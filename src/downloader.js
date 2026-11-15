import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { videoFilename } from './files.js';
import { hostMatches } from './platforms/shared.js';

const ATTEMPTS = 3;

// Applies browser cookie scoping, so cookies only reach hosts they were set for.
export function cookieHeader(url, cookies) {
  const { hostname, protocol } = new URL(url);
  return cookies
    .filter((c) => (c.domain.startsWith('.') ? hostMatches(hostname, c.domain.slice(1)) : hostname === c.domain))
    .filter((c) => !c.secure || protocol === 'https:')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
}

function requestHeaders(url, { platform, userAgent, cookies }) {
  const cookie = platform.sendCookies ? cookieHeader(url, cookies()) : '';
  return {
    Referer: `${platform.origin}/`,
    ...(userAgent && { 'User-Agent': userAgent }),
    ...(cookie && { Cookie: cookie }),
  };
}

// Facebook refuses logged-in requests that don't say they come from its own pages.
const PAGE_HEADERS = { Accept: 'text/html', 'Sec-Fetch-Site': 'same-origin' };

// Some sites list only a low-quality stream and name the full one on the
// video's own page. Any problem here falls back to the listed streams.
async function videoPageUrls(video, options) {
  const { platform, signal } = options;
  if (!video.pageUrl || !platform.urlsFromVideoPage) return [];
  try {
    const response = await fetch(video.pageUrl, {
      signal,
      headers: { ...requestHeaders(video.pageUrl, options), ...PAGE_HEADERS },
    });
    return response.ok ? platform.urlsFromVideoPage(await response.text(), video.id) : [];
  } catch {
    signal.throwIfAborted();
    return [];
  }
}

async function fetchToFile(url, target, { signal, onProgress, ...options }) {
  const response = await fetch(url, { signal, headers: requestHeaders(url, options) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if ((response.headers.get('content-type') ?? '').startsWith('text/')) {
    throw new Error('Received a web page instead of a video');
  }

  const total = Number(response.headers.get('content-length')) || 0;
  let received = 0;
  const counter = new Transform({
    transform(chunk, _encoding, done) {
      received += chunk.length;
      onProgress(received, total);
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), counter, createWriteStream(target), { signal });

  if (!received || (total && received !== total)) {
    throw new Error(`Incomplete download (${received} of ${total} bytes)`);
  }
}

export async function downloadVideo(video, directory, options) {
  const finalPath = path.join(directory, videoFilename(video));
  const partPath = `${finalPath}.part`;
  const urls = [...new Set([...await videoPageUrls(video, options), ...video.urls])];
  if (!urls.length) throw new Error('The site gave no video file for this post');
  let lastError;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    for (const url of urls) {
      options.signal.throwIfAborted();
      try {
        await fetchToFile(url, partPath, options);
        await rename(partPath, finalPath);
        return finalPath;
      } catch (error) {
        lastError = error;
        await rm(partPath, { force: true });
        options.signal.throwIfAborted();
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
  }
  throw lastError;
}
