import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { downloadVideo } from '../src/downloader.js';

let server;
let origin;
let directory;
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'channel-downloader-'));
  server = http.createServer((req, res) => {
    if (req.url === '/page') {
      if (req.headers['sec-fetch-site'] !== 'same-origin') {
        res.statusCode = 400;
        return res.end();
      }
      res.setHeader('Content-Type', 'text/html');
      return res.end(`hd=${origin}/hd`);
    }
    if (req.url === '/hd' || req.url === '/sd') {
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(`${req.url.slice(1)} bytes`);
    }
    res.statusCode = 404;
    return res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.close();
  await rm(directory, { recursive: true, force: true });
});

const platform = {
  origin: 'https://site.example',
  sendCookies: false,
  urlsFromVideoPage: (html) => [html.slice(3)],
};
const download = (video) => downloadVideo({ title: '', createTime: 0, ...video }, directory, {
  signal: new AbortController().signal,
  platform,
  cookies: () => [],
  onProgress() {},
});

test('the full-quality file from the video page comes before the listed stream', async () => {
  const file = await download({ id: '1000001', urls: [`${origin}/sd`], pageUrl: `${origin}/page` });
  assert.equal(await readFile(file, 'utf8'), 'hd bytes');
});

test('the listed stream is used when the video page fails', async () => {
  const file = await download({ id: '1000002', urls: [`${origin}/sd`], pageUrl: `${origin}/missing` });
  assert.equal(await readFile(file, 'utf8'), 'sd bytes');
});

test('a video with no file anywhere fails without retrying', async () => {
  await assert.rejects(download({ id: '1000003', urls: [], pageUrl: `${origin}/missing` }), /no video file/);
});
