import assert from 'node:assert/strict';
import { test } from 'node:test';
import { facebook } from '../src/platforms/facebook.js';
import { listReader, parseChannelUrl } from '../src/platforms/index.js';

test('parseChannelUrl opens the Videos tab of a Facebook page', () => {
  const channel = parseChannelUrl('see https://www.facebook.com/NASA/?ref=share');
  assert.equal(channel.platform.name, 'Facebook');
  assert.equal(channel.id, 'nasa');
  assert.equal(channel.url, 'https://www.facebook.com/NASA/videos');
  assert.equal(parseChannelUrl('https://m.facebook.com/NASA/videos/').url, 'https://www.facebook.com/NASA/videos');

  const numbered = parseChannelUrl('https://www.facebook.com/profile.php?id=61550000000000&sk=about');
  assert.equal(numbered.id, '61550000000000');
  assert.equal(numbered.url, 'https://www.facebook.com/profile.php?id=61550000000000&sk=videos');
});

test('parseChannelUrl rejects Facebook links that are not pages', () => {
  assert.throws(() => parseChannelUrl('https://www.facebook.com/watch/?v=123'));
  assert.throws(() => parseChannelUrl('https://www.facebook.com/NASA/videos/123/'));
  assert.throws(() => parseChannelUrl('https://www.facebook.com/groups/abc'));
  assert.throws(() => parseChannelUrl('https://www.facebook.com/reel/123'));
  assert.throws(() => parseChannelUrl('https://www.facebook.com/profile.php'));
  assert.throws(() => parseChannelUrl('https://facebook.com.evil.example/NASA'));
});

const routeProps = { userID: '100', userVanity: 'NASA', pageID: '200' };
const owner = { __typename: 'User', id: '100', delegate_page_id: '200' };
const gridVideo = (id, extra = {}) => ({
  __typename: 'Video',
  id,
  owner,
  publish_time: 1700000000,
  savable_title: { text: `video ${id}` },
  canonical_uri_with_fallback: `https://www.facebook.com/NASA/videos/${id}/`,
  creation_story: { attachments: [{ target: { __typename: 'Video', id, playable_url: `https://cdn/${id}-sd.mp4` } }] },
  ...extra,
});
const script = (data) => `<script type="application/json" data-sjs>${JSON.stringify(data)}</script>`;
const documentHtml = (...data) => `<html>${data.map(script).join('')}</html>`;

function reader() {
  return listReader(parseChannelUrl('https://www.facebook.com/NASA')).read;
}

test('Facebook reads the page owner and its first videos from the page itself', () => {
  const read = reader();
  const list = read({
    type: 'document',
    text: documentHtml(
      { props: routeProps },
      { __typename: 'User', id: '100', name: 'NASA Official' },
      {
        all_videos: {
          edges: [{ node: gridVideo('11') }, { node: gridVideo('12') }],
          page_info: { has_next_page: true, end_cursor: 'abc' },
        },
        related: { edges: [{ node: { __typename: 'Video', id: '99', owner: { id: '555' } } }], page_info: { has_next_page: false } },
      },
    ),
  });
  assert.deepEqual(list.items.map((item) => item.id), ['11', '12']);
  assert.equal(list.hasMore, true);
  assert.deepEqual(list.items[0], {
    id: '11',
    title: 'video 11',
    createTime: 1700000000,
    urls: ['https://cdn/11-sd.mp4'],
    pageUrl: 'https://www.facebook.com/NASA/videos/11/',
    channelKey: '200',
    author: 'NASA Official',
  });
});

test('Facebook follows the paging of the lists that hold the channel videos', () => {
  const read = reader();
  read({ type: 'document', text: documentHtml({ props: routeProps }) });
  const page = (hasNext) => [
    JSON.stringify({ data: { node: { all_videos: { edges: [{ node: gridVideo('13') }], page_info: { has_next_page: hasNext } } } } }),
    JSON.stringify({ label: 'deferred', data: { unrelated: true } }),
  ].join('\n');
  assert.equal(read({ type: 'fetch', url: 'https://www.facebook.com/api/graphql/', text: page(true) }).hasMore, true);
  assert.equal(read({ type: 'fetch', url: 'https://www.facebook.com/api/graphql/', text: page(false) }).hasMore, false);

  const preview = read({ type: 'fetch', text: JSON.stringify({ data: { video: gridVideo('14') } }) });
  assert.equal(preview.hasMore, undefined, 'a response without paging leaves it unchanged');
  assert.equal(preview.items[0].pageUrl, 'https://www.facebook.com/NASA/videos/14/');
});

test('Facebook ignores other responses and reports refused paging', () => {
  const read = reader();
  const graphql = { type: 'fetch', url: 'https://www.facebook.com/api/graphql/' };
  const videos = JSON.stringify({ data: { video: gridVideo('15') } });
  assert.equal(read({ ...graphql, text: videos }), undefined, 'the owner is not known before the page loads');

  read({ type: 'document', text: documentHtml({ props: routeProps }) });
  assert.equal(read({ ...graphql, text: JSON.stringify({ data: { comments: [] } }) }), undefined);
  assert.equal(read({ ...graphql, text: JSON.stringify({ data: { video: { __typename: 'Video', id: '9', owner: { id: '555' } } } }) }), undefined);

  const limited = JSON.stringify({ errors: [{ message: 'Rate limit exceeded', code: 1675004 }] });
  assert.equal(read({ ...graphql, text: limited, requestBody: 'fb_api_req_friendly_name=PagesCometChannelTabAllVideosCardImplPaginationQuery' }), null);
  assert.equal(read({ ...graphql, text: limited, requestBody: 'fb_api_req_friendly_name=CometNotificationsQuery' }), undefined);
});

test('Facebook reads the title and date from a copy that does not say it is a video', () => {
  const read = reader();
  const node = { __typename: 'Video', id: '17', owner, channel_tab_thumbnail_renderer: {
    __typename: 'ChannelTabVideoThumbnailWithReactionsRenderer',
    video: { id: '17', owner, publish_time: 1700000000, savable_title: { text: 'a reel' }, canonical_uri_with_fallback: 'https://www.facebook.com/reel/17/' },
  } };
  const [item] = read({ type: 'document', text: documentHtml({ props: routeProps }, { all_videos: { edges: [{ node }], page_info: { has_next_page: false } } }) }).items;
  assert.equal(item.title, 'a reel');
  assert.equal(item.createTime, 1700000000);
  assert.equal(item.pageUrl, 'https://www.facebook.com/reel/17/');
});

test('Facebook links a video without its own address to the watch page', () => {
  const read = reader();
  const list = read({ type: 'document', text: documentHtml({ props: routeProps }, { video: gridVideo('16', { canonical_uri_with_fallback: null }) }) });
  assert.equal(list.items[0].pageUrl, 'https://www.facebook.com/watch/?v=16');
});

test('Facebook takes the HD file from the video page, for that video only', () => {
  const html = documentHtml({
    media: {
      __typename: 'Video',
      id: '11',
      videoDeliveryLegacyFields: { id: '11', browser_native_hd_url: 'https://cdn/11-hd.mp4', browser_native_sd_url: 'https://cdn/11-sd.mp4' },
    },
    related: { __typename: 'Video', id: '12', browser_native_hd_url: 'https://cdn/12-hd.mp4' },
    newer: {
      __typename: 'Video',
      id: '13',
      videoDeliveryResponseFragment: {
        videoDeliveryResponseResult: {
          progressive_urls: [
            { progressive_url: 'https://cdn/13-sd.mp4', metadata: { quality: 'SD' } },
            { progressive_url: 'https://cdn/13-hd.mp4', metadata: { quality: 'HD' } },
          ],
        },
      },
    },
  });
  assert.deepEqual(facebook.urlsFromVideoPage(html, '11'), ['https://cdn/11-hd.mp4', 'https://cdn/11-sd.mp4']);
  assert.deepEqual(facebook.urlsFromVideoPage(html, '13'), ['https://cdn/13-hd.mp4', 'https://cdn/13-sd.mp4']);
  assert.deepEqual(facebook.urlsFromVideoPage('<html>login</html>', '11'), []);
});
