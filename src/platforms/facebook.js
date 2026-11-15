import { hostMatches, uniqueHttpUrls } from './shared.js';

const GRAPHQL_PATH = '/api/graphql/';
// First path segments that are Facebook's own sections, not a page's name.
const NOT_PAGES = new Set([
  'ads', 'bookmarks', 'business', 'dialog', 'events', 'friends', 'gaming', 'groups', 'hashtag', 'help',
  'home.php', 'l.php', 'login', 'login.php', 'marketplace', 'messages', 'notifications', 'pages', 'people',
  'permalink.php', 'photo', 'photo.php', 'photos', 'plugins', 'policies', 'privacy', 'reel', 'reels', 'saved',
  'search', 'settings', 'share', 'stories', 'story.php', 'video', 'video.php', 'videos', 'watch',
]);

const walk = (value, visit) => {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  visit(value);
  for (const entry of Object.values(value)) walk(entry, visit);
};

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

// The page embeds its first data in <script type="application/json"> blocks.
const embeddedJson = (html) => [...html.matchAll(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => parseJson(match[1]))
  .filter(Boolean);

// GraphQL answers can stream several JSON objects, one per line.
const jsonLines = (text) => text.replace(/^for \(;;\);/, '').split('\n').map(parseJson).filter(Boolean);

// HD first. The legacy fields and progressive_urls are two generations of the same data.
function streamUrls(node) {
  const legacy = node.videoDeliveryLegacyFields ?? {};
  const progressive = node.videoDeliveryResponseFragment?.videoDeliveryResponseResult?.progressive_urls ?? [];
  const quality = (name) => progressive.filter((p) => p?.metadata?.quality === name).map((p) => p.progressive_url);
  return {
    hd: [legacy.browser_native_hd_url, node.browser_native_hd_url, node.playable_url_quality_hd, ...quality('HD')],
    sd: [legacy.browser_native_sd_url, node.browser_native_sd_url, node.playable_url, ...quality('SD')],
  };
}

const ownerIds = (node) => [node.owner?.id, node.owner?.delegate_page_id, node.owner?.owner_as_page?.id].filter(Boolean);

const textOf = (field) => (typeof field === 'string' ? field : field?.text) || '';

// One video turns up several times in a response, each copy with different
// fields, so the copies are merged by id. Only one copy needs to say it is a
// video: the one holding the title and date sometimes doesn't.
function collectVideos(payloads) {
  const videoIds = new Set();
  walk(payloads, (node) => {
    if (node.__typename === 'Video' && node.id) videoIds.add(node.id);
  });
  const videos = new Map();
  walk(payloads, (node) => {
    if (!videoIds.has(node.id)) return;
    const video = videos.get(node.id) ?? { id: String(node.id), owners: new Set(), hd: [], sd: [] };
    videos.set(node.id, video);
    for (const id of ownerIds(node)) video.owners.add(String(id));
    video.title ||= textOf(node.savable_title) || textOf(node.video_title) || textOf(node.title) || textOf(node.message);
    video.createTime ||= Number(node.publish_time || node.creation_time) || 0;
    video.pageUrl ||= node.canonical_uri_with_fallback || node.permalink_url || '';
    const { hd, sd } = streamUrls(node);
    video.hd.push(...hd);
    video.sd.push(...sd);
  });
  return videos;
}

// The page names its owner in its route props, and a page has two ids: the
// profile's and the page's. Videos are owned by either.
function findChannel(payloads, channelId) {
  let found = null;
  walk(payloads, (node) => {
    if (found || !('userVanity' in node) || !node.userID) return;
    if (String(node.userVanity).toLowerCase() === channelId || String(node.userID) === channelId) {
      found = { owners: new Set([node.userID, node.pageID].filter(Boolean).map(String)), key: String(node.pageID || node.userID) };
    }
  });
  if (!found) return null;
  walk(payloads, (node) => {
    if (node.__typename === 'User' && found.owners.has(String(node.id)) && typeof node.name === 'string') found.name ||= node.name;
  });
  return found;
}

const isPaginationRefusal = (payloads, requestBody) => {
  const query = new URLSearchParams(requestBody ?? '').get('fb_api_req_friendly_name') ?? '';
  return /Pagination/.test(query) && payloads.some((payload) => payload.errors && !payload.data);
};

export const facebook = {
  name: 'Facebook',
  origin: 'https://www.facebook.com',
  requiresLogin: true,
  sessionCookie: 'c_user',
  // Needed to fetch each video's own page as the logged-in user.
  sendCookies: true,

  matchUrl(url) {
    if (!hostMatches(url.hostname, 'facebook.com')) return null;
    if (url.pathname.replace(/\/$/, '') === '/profile.php') {
      const id = url.searchParams.get('id');
      if (!/^\d+$/.test(id ?? '')) return null;
      return { id, url: `https://www.facebook.com/profile.php?id=${id}&sk=videos` };
    }
    const name = url.pathname.match(/^\/([\w.-]+)(?:\/videos)?\/?$/)?.[1];
    if (!name || NOT_PAGES.has(name.toLowerCase())) return null;
    return { id: name.toLowerCase(), url: `https://www.facebook.com/${name}/videos` };
  },

  // Facebook has no single list endpoint: videos arrive in the page itself and
  // in GraphQL answers mixed with everything else, so this keeps only the
  // channel's own videos and the paging of the lists that hold them.
  listReader(channel) {
    let owner = null;
    return {
      wants: ({ url, type }) => type === 'document' || new URL(url).pathname === GRAPHQL_PATH,
      read({ type, text, requestBody }) {
        const payloads = type === 'document' ? embeddedJson(text) : jsonLines(text);
        if (type === 'document') owner ??= findChannel(payloads, channel.id);
        if (isPaginationRefusal(payloads, requestBody)) return null;
        if (!owner) return undefined;

        const videos = [...collectVideos(payloads).values()]
          .filter((video) => [...video.owners].some((id) => owner.owners.has(id)));
        if (!videos.length) return undefined;

        const ownedIds = new Set(videos.map((video) => video.id));
        const pageInfos = [];
        walk(payloads, (node) => {
          const entries = node.edges?.map((edge) => edge?.node) ?? node.nodes;
          if (node.page_info && entries?.some((entry) => ownedIds.has(String(entry?.id)))) pageInfos.push(node.page_info);
        });

        return {
          items: videos.map((video) => ({
            id: video.id,
            title: video.title ?? '',
            createTime: video.createTime,
            urls: uniqueHttpUrls([...video.hd, ...video.sd]),
            pageUrl: video.pageUrl.startsWith('https://www.facebook.com/')
              ? video.pageUrl
              : `https://www.facebook.com/watch/?v=${video.id}`,
            channelKey: owner.key,
            author: owner.name || channel.id,
          })),
          hasMore: pageInfos.length ? pageInfos.some((info) => info.has_next_page) : undefined,
        };
      },
    };
  },

  itemId: (item) => item.id,

  // Facebook adds no download watermark. The list carries only a low-bitrate
  // stream; the downloader gets the HD one from the video's own page.
  classify: (item) => ({ kind: 'video', video: item }),

  urlsFromVideoPage(html, id) {
    const hd = [];
    const sd = [];
    walk(embeddedJson(html), (node) => {
      if (String(node.id) !== id) return;
      const urls = streamUrls(node);
      hd.push(...urls.hd);
      sd.push(...urls.sd);
    });
    return uniqueHttpUrls([...hd, ...sd]);
  },
};
