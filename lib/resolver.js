'use strict';
// Client for the optional headless resolver service (resolver/server.js).
// When RESOLVER_URL is set (e.g. http://localhost:7799), movie/TV embed pages
// can be turned into directly playable HLS: the resolver drives the embed in a
// headless browser and sniffs the m3u8 + the headers its CDN expects. Called at
// PLAY time via /direct (lib/direct.js), so stream lists stay fast.
const { getJson, UA } = require('./http');
const cache = require('./cache');

const RESOLVER_URL = (process.env.RESOLVER_URL || '').replace(/\/$/, '');
// Per-embed budget: the resolver itself needs up to ~25s cold; cached hits are
// instant.
const TIMEOUT = parseInt(process.env.RESOLVER_TIMEOUT_MS || '26000', 10);
const CACHE_MS = parseInt(process.env.RESOLVER_CACHE_S || '600', 10) * 1000;
const FAIL_CACHE_MS = parseInt(process.env.RESOLVER_FAIL_CACHE_S || '300', 10) * 1000;

function enabled() { return !!RESOLVER_URL; }

function headersFor(out, embedUrl) {
  if (out.headers && typeof out.headers === 'object') return out.headers;
  const referer = out.referer || embedUrl;
  let origin;
  try { origin = new URL(referer).origin; } catch (e) { /* ignore */ }
  return { Referer: referer, ...(origin ? { Origin: origin } : {}), 'User-Agent': UA };
}

// → { url, referer, headers } | null  (never throws)
async function resolveEmbed(embedUrl) {
  if (!RESOLVER_URL) return null;
  // Remember failures briefly so repeated list/play requests don't re-drive
  // a headless browser for a host that just failed.
  if (cache.get(`rslvfail:${embedUrl}`)) return null;
  return cache.wrap(`rslv:${embedUrl}`, CACHE_MS, async () => {
    const out = await getJson(
      `${RESOLVER_URL}/resolve?u=${encodeURIComponent(embedUrl)}`,
      { timeout: TIMEOUT }
    );
    if (!out || !out.url) throw new Error((out && out.err) || 'no url');
    return { url: out.url, referer: out.referer || embedUrl, headers: headersFor(out, embedUrl) };
  }).catch(() => { cache.set(`rslvfail:${embedUrl}`, true, FAIL_CACHE_MS); return null; });
}

module.exports = { enabled, resolveEmbed };
