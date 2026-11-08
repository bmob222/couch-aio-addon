'use strict';
// Couch AIO resolver — runs ON THE USER'S BOX (not serverless). The public
// multi-embed hosts (videasy, vidfast, moviesapi, 111movies, ...) are signed-JS
// SPA players: the HLS URL only exists after the player script executes and
// (usually) after a play click. This service drives a real headless Chromium,
// clicks play, and sniffs the network for the master .m3u8 + the Referer it
// was fetched with, so the addon can hand Stremio a directly playable stream.
//
//   GET /resolve?u=<embedUrl>   → { url, referer, headers, ms } | { err }
//   GET /health                 → { ok, browser }
//
// Run: cd resolver && npm install && PORT=7799 node server.js
const http = require('http');
const { URL } = require('url');
const { chromium } = require('playwright');

const PORT = parseInt(process.env.PORT || '7799', 10);
const NAV_TIMEOUT = 25000;   // page load budget
const SNIFF_TIMEOUT = 22000; // total wait for an m3u8 after load
const CACHE_TTL = 90 * 60 * 1000; // resolved links live ~90 min

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ---------------------------------------------------------------- cache
const cache = new Map(); // embedUrl -> { at, value }
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL) { cache.delete(k); return null; }
  return e.value;
}
function cacheSet(k, v) {
  cache.set(k, { at: Date.now(), value: v });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
}

// ---------------------------------------------------------------- browser
let browserPromise = null;
async function getBrowser() {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    if (b && b.isConnected()) return b;
    browserPromise = null;
  }
  // `channel: 'chromium'` = full Chromium in the new headless mode. The old
  // headless shell advertises "HeadlessChrome" in client hints, and some embed
  // APIs (e.g. the 111Movies player API) silently return empty sources to it.
  const opts = { headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] };
  if (process.env.RESOLVER_HEADLESS_SHELL !== '1') opts.channel = 'chromium';
  browserPromise = chromium.launch(opts).catch(() => chromium.launch({ headless: true, args: opts.args }));
  return browserPromise;
}

function looksLikeHls(url, contentType) {
  if (!/^https?:\/\//i.test(url)) return false; // blob:/data: playlists aren't fetchable
  if (/\.m3u8(\?|$)/i.test(url)) return true;
  return /mpegurl/i.test(contentType || '');
}
// Master playlists beat media/child playlists; skip obvious ad/telemetry hosts.
function isJunk(url) {
  return /doubleclick|googlesyndication|analytics|sentry|adsco|adserv/i.test(url);
}

// Some players never request the m3u8 by URL: they fetch a JSON source list and
// build a blob: playlist in JS. Scan small JSON/text XHR bodies for an https
// .m3u8 URL so those hosts still resolve. Returns the first plausible URL.
const M3U8_IN_TEXT = /https?:(?:\\?\/){2}[^"'\s<>]+?\.m3u8(?:\?[^"'\s<>]*)?/i;
function m3u8FromBody(text) {
  if (!text || text.length > 2_000_000) return null;
  const m = text.match(M3U8_IN_TEXT);
  if (!m) return null;
  const url = m[0].replace(/\\\//g, '/').replace(/\\u0026/g, '&');
  return isJunk(url) ? null : url;
}

// Client-hint brands that don't say "HeadlessChrome".
const SEC_CH_UA = '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"';

// Try clicking whatever looks like a play control, then the page center.
async function pokePlay(page) {
  const selectors = [
    'button[aria-label*="play" i]', '.jw-icon-display', '.vjs-big-play-button',
    '.plyr__control--overlaid', '#player', 'video', '.play', '[class*="play"]',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 400 })) {
        await el.click({ timeout: 1500, force: true });
        return;
      }
    } catch (e) { /* next */ }
  }
  try {
    const vp = page.viewportSize() || { width: 1280, height: 720 };
    await page.mouse.click(vp.width / 2, vp.height / 2);
  } catch (e) { /* ignore */ }
}

// Open embedUrl and wait for an m3u8 request to fly by.
async function sniff(embedUrl) {
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    extraHTTPHeaders: { 'sec-ch-ua': SEC_CH_UA, 'sec-ch-ua-mobile': '?0', 'sec-ch-ua-platform': '"macOS"' },
  });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  // New tabs (popup ads) get closed immediately.
  ctx.on('page', (p) => { if (p.url() !== 'about:blank') p.close().catch(() => {}); });

  const page = await ctx.newPage();
  let done;
  const found = new Promise((res) => { done = res; });

  page.on('request', (req) => {
    const url = req.url();
    if (looksLikeHls(url, '') && !isJunk(url)) {
      done({ url, referer: req.headers()['referer'] || embedUrl });
    }
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    if (isJunk(url)) return;
    const ct = resp.headers()['content-type'] || '';
    if (looksLikeHls(url, ct)) {
      return done({ url, referer: resp.request().headers()['referer'] || embedUrl });
    }
    // JSON source APIs (fetch/xhr) that carry the m3u8 URL in their body.
    const rt = resp.request().resourceType();
    if ((rt === 'xhr' || rt === 'fetch') && /json|text\/plain|javascript/i.test(ct) && resp.status() < 400) {
      const text = await resp.text().catch(() => '');
      const hit = m3u8FromBody(text);
      // The player fetches the playlist from its own page, so the page origin
      // is the Referer the CDN expects.
      if (hit) done({ url: hit, referer: resp.request().headers()['referer'] || embedUrl, fromBody: true });
    }
  });

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Poke play a few times while we wait for the sniffer.
    const poker = (async () => {
      for (let i = 0; i < 5; i++) {
        await page.waitForTimeout(i === 0 ? 1500 : 3000);
        await pokePlay(page);
      }
    })();
    const timer = new Promise((res) => setTimeout(() => res(null), SNIFF_TIMEOUT));
    const hit = await Promise.race([found, timer]);
    poker.catch(() => {});
    return hit; // { url, referer } | null
  } finally {
    await ctx.close().catch(() => {});
  }
}

// One in-flight resolve per embed URL (stream requests often repeat).
const inflight = new Map();
async function resolve(embedUrl) {
  const cached = cacheGet(embedUrl);
  if (cached) return cached;
  if (inflight.has(embedUrl)) return inflight.get(embedUrl);
  const p = (async () => {
    const t0 = Date.now();
    const hit = await sniff(embedUrl);
    if (!hit) return { err: 'no m3u8 observed' };
    let origin;
    try { origin = new URL(hit.referer).origin; } catch (e) { origin = undefined; }
    // headers = what the CDN expects on the playlist AND every segment.
    const value = {
      url: hit.url,
      referer: hit.referer,
      headers: { Referer: hit.referer, ...(origin ? { Origin: origin } : {}), 'User-Agent': UA },
      ms: Date.now() - t0,
    };
    cacheSet(embedUrl, value);
    return value;
  })().finally(() => inflight.delete(embedUrl));
  inflight.set(embedUrl, p);
  return p;
}

// ---------------------------------------------------------------- http
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (u.pathname === '/health') {
    const b = await browserPromise?.catch(() => null);
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ok: true, browser: !!(b && b.isConnected()), cached: cache.size }));
  }

  if (u.pathname === '/resolve') {
    const target = u.searchParams.get('u');
    if (!target || !/^https?:\/\//.test(target)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ err: 'missing or bad u' }));
    }
    try {
      const out = await resolve(target);
      res.writeHead(out.err ? 502 : 200, { 'Content-Type': 'application/json' });
      console.log(`[resolve] ${target} → ${out.err ? 'FAIL ' + out.err : out.url.slice(0, 90) + ` (${out.ms}ms)`}`);
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ err: String(e && e.message) }));
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ err: 'not found' }));
});

server.listen(PORT, () => console.log(`Couch AIO resolver on http://localhost:${PORT}`));
