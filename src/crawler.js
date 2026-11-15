import { chromium } from 'playwright-core';
import { nextStep, SCROLL_DELAY_MS } from './crawlPolicy.js';
import { listReader } from './platforms/index.js';

const CAPTCHA_SELECTOR = '#captcha_container, .captcha_verify_container, .captcha-verify-container, [id^="captcha-verify"], iframe[src*="verifycenter"], iframe[src*="captcha"]';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitMessages = (platform) => ({
  captcha: `${platform.name} is showing a CAPTCHA. Please complete it in the Chrome window.`,
  login: `${platform.name} only lists this channel for logged-in accounts. Log in in the Chrome window to continue, or press Stop if you have no account.`,
  idle: 'No new videos yet. Check the Chrome window for a login prompt or CAPTCHA.',
});

// Opens the channel in a visible Chrome window and reads the post lists the
// page requests for itself while scrolling. Logins and CAPTCHAs are left for
// the user to complete in that window; the crawl waits for them.
export async function crawlChannel({
  channel,
  profileDir,
  browserChannel,
  signal,
  isSatisfied,
  onStatus,
  onVideo,
  onSkipped,
  onUserAgent,
  onCookies,
}) {
  const { platform } = channel;
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: browserChannel,
    headless: false,
    viewport: null,
  });

  let closed = false;
  context.on('close', () => { closed = true; });
  const closeOnAbort = () => context.close().catch(() => {});
  signal.addEventListener('abort', closeOnAbort, { once: true });

  const seen = new Set();
  let videos = 0;
  let hasMore = null;
  let lastActivity = Date.now();
  let refusedSince = null;
  let waitingForLogin = false;
  let reloads = 0;

  const reader = listReader(channel);
  let page = context.pages()[0] ?? await context.newPage();
  // On the context, so a page opened to replace a broken one is read too.
  context.on('response', async (response) => {
    try {
      const request = response.request();
      const source = { url: response.url(), type: request.resourceType() };
      if (!reader.wants(source)) return;
      const list = reader.read({ ...source, text: await response.text(), requestBody: request.postData() });
      if (list === undefined) return;
      if (!list) {
        refusedSince ??= Date.now();
        return;
      }
      refusedSince = null;
      waitingForLogin = false;
      reloads = 0;
      lastActivity = Date.now();
      if (platform.sendCookies) onCookies(await context.cookies());
      for (const item of list.items) {
        const id = platform.itemId(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const post = platform.classify(item);
        if (post.kind === 'video') {
          videos += 1;
          onVideo(post.video);
        } else {
          onSkipped(post);
        }
      }
      // Set last: the main loop ends the crawl on this, so this page must be read first.
      if (list.hasMore !== undefined) hasMore = list.hasMore;
    } catch {
      // Responses cut off by navigation or closing the window are expected here.
    }
  });

  const messages = waitMessages(platform);
  const openChannel = () => page.goto(channel.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // Opens the channel again rather than reloading, because logging in can
  // leave the window on another page. A login can also detach the page from
  // the app, so a failure gets one try in a fresh tab.
  const reloadPage = async () => {
    onStatus('Reloading channel…');
    try {
      await openChannel();
    } catch (error) {
      if (closed || signal.aborted) throw error;
      const broken = page;
      page = await context.newPage();
      await broken.close().catch(() => {});
      await openChannel();
    }
    lastActivity = Date.now();
  };
  const scrollPage = async () => {
    onStatus(`Browsing channel… ${videos} videos found`);
    const size = page.viewportSize() ?? await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.mouse.move(size.width / 2, size.height / 2);
    await page.mouse.wheel(0, size.height * 2);
  };

  try {
    onUserAgent(await page.evaluate(() => navigator.userAgent));
    onStatus('Opening channel…');
    await openChannel();
    lastActivity = Date.now();

    while (!closed && !signal.aborted) {
      const cookies = await context.cookies(platform.origin);
      const step = nextStep({
        satisfied: isSatisfied(),
        hasMore,
        captchaVisible: await page.locator(CAPTCHA_SELECTOR).locator('visible=true').count().catch(() => 0) > 0,
        refusedForMs: refusedSince === null ? null : Date.now() - refusedSince,
        requiresLogin: platform.requiresLogin,
        loggedIn: cookies.some((cookie) => cookie.name === platform.sessionCookie && cookie.value),
        waitingForLogin,
        reloads,
        idleMs: Date.now() - lastActivity,
      });

      if (step.action === 'finish') return { reason: step.reason };
      if (step.action === 'wait') {
        if (step.why === 'captcha') {
          lastActivity = Date.now();
          refusedSince = null;
        }
        if (step.why === 'login') waitingForLogin = true;
        onStatus(messages[step.why], true);
      } else if (step.action === 'reload') {
        if (step.countsAsRetry) reloads += 1;
        waitingForLogin = false;
        refusedSince = null;
        await reloadPage();
      } else {
        await scrollPage();
      }
      await sleep(SCROLL_DELAY_MS);
    }
    return { reason: signal.aborted ? 'stopped' : 'browser-closed' };
  } catch (error) {
    if (closed || signal.aborted) {
      return { reason: signal.aborted ? 'stopped' : 'browser-closed' };
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    await context.close().catch(() => {});
  }
}
