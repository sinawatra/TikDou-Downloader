import { douyin } from './douyin.js';
import { facebook } from './facebook.js';
import { tiktok } from './tiktok.js';

// To support a new site, add its file and list it here.
const PLATFORMS = [tiktok, douyin, facebook];

export function parseChannelUrl(input) {
  const match = String(input ?? '').match(/https?:\/\/[^\s"'<>]+/);
  if (!match) throw new Error('Paste a TikTok, Douyin or Facebook channel URL.');
  const url = new URL(match[0]);
  for (const platform of PLATFORMS) {
    const channel = platform.matchUrl(url);
    if (channel) return { platform, ...channel };
  }
  throw new Error('Expected a channel URL like https://www.tiktok.com/@name, https://www.douyin.com/user/MS4w... or https://www.facebook.com/name');
}

// Returns null unless this is a real page of posts. Refusals come back as an
// empty 200 or as JSON with an error status, and neither means the list ended.
export function parseListResponse(text, platform) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const status = body?.status_code ?? body?.statusCode ?? 0;
  return status === 0 && body && platform.hasMoreKey in body ? body : null;
}

// Reads the responses the channel page receives. wants() picks them by URL
// before their bodies are read. read() returns null for a refusal, undefined
// for a response with none of this channel's posts, or { items, hasMore }.
export function listReader(channel) {
  const { platform } = channel;
  if (platform.listReader) return platform.listReader(channel);
  return {
    wants: ({ url }) => new URL(url).pathname === platform.postsPath,
    read({ text }) {
      const body = parseListResponse(text, platform);
      if (!body) return null;
      return {
        items: (body[platform.listKey] ?? []).filter((item) => platform.belongsTo(item, channel.id)),
        hasMore: Boolean(body[platform.hasMoreKey]),
      };
    },
  };
}
