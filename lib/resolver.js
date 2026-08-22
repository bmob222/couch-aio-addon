'use strict';
// Client for the optional headless resolver service (resolver/server.js).
// When RESOLVER_URL is set (e.g. http://localhost:7799), movie/TV embed pages
// can be turned into directly playable HLS: we ask the resolver to drive the
// embed in a headless browser and sniff the master m3u8 + its Referer, then
// serve it through our own /proxy so the client needs no header support.
const { getJson } = require('./http');
const cache = require('./cache');

const RESOLVER_URL = (process.env.RESOLVER_URL || '').replace(/\/$/, '');
// Per-embed budget: the resolver itself needs up to ~25s cold; cached hits are
// instant. Stremio stream requests tolerate ~30s, so allow most of it.
const TIMEOUT = parseInt(process.env.RESOLVER_TIMEOUT_MS || '26000', 10);

function enabled() { return !!RESOLVER_URL; }

// → { url, referer } | null  (never throws)
async function resolveEmbed(embedUrl) {
  if (!RESOLVER_URL) return null;
  return cache.wrap(`rslv:${embedUrl}`, 60 * 60 * 1000, async () => {
    const out = await getJson(
      `${RESOLVER_URL}/resolve?u=${encodeURIComponent(embedUrl)}`,
      { timeout: TIMEOUT }
    );
    if (!out || !out.url) throw new Error((out && out.err) || 'no url');
    return { url: out.url, referer: out.referer || embedUrl };
  }).catch(() => null);
}

module.exports = { enabled, resolveEmbed };
