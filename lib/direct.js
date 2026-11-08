'use strict';
// Resolve-on-play.
//
// Stream lists hand out  <host>/direct/<provider>/<payload>/index.m3u8?psig=…
// instead of pre-resolved CDN links. Resolving happens when the player opens
// the URL, so lists are fast and links never go stale in a client's cache.
// The answer is a 307 to:
//   • the upstream m3u8 itself, when it plays without any headers, or
//   • our signed /hls playlist proxy, when the CDN needs Referer/Origin/UA
//     (or we inject subtitle renditions).
//
// Providers register a resolver:  register('anisuge', async (payload) =>
//   ({ url, headers, subs }) | null)
const hls = require('./hls');
const cache = require('./cache');

const DIRECT_TTL_S = parseInt(process.env.DIRECT_LINK_TTL_S || String(30 * 24 * 3600), 10); // link validity
const RESOLVE_CACHE_MS = parseInt(process.env.DIRECT_CACHE_S || '75', 10) * 1000;          // resolved-target cache

const resolvers = new Map();
const inflight = new Map();

function register(provider, fn) { resolvers.set(provider, fn); }

function directUrl(host, provider, payload) {
  const p = String(provider).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return hls.signedUrl(host, `/direct/${p}/${hls.enc(payload)}/index.m3u8`, DIRECT_TTL_S);
}

// Resolve with a short cache + in-flight dedupe (players often open a URL
// twice: probe, then play). Never throws; null on failure.
function resolve(provider, payloadStr) {
  const key = `direct:${provider}:${payloadStr}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  const fn = resolvers.get(provider);
  if (!fn) return Promise.resolve(null);
  const payload = hls.dec(payloadStr);
  const p = Promise.resolve()
    .then(() => fn(payload))
    .then((r) => { if (r && r.url) cache.set(key, r, RESOLVE_CACHE_MS); return r && r.url ? r : null; })
    .catch(() => null)
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// Warm the cache at stream-list time without blocking the response.
function prefetch(provider, payload) {
  resolve(provider, hls.enc(payload)).catch(() => {});
}

function jsonError(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ error }));
}

// GET /direct/<provider>/<payload>[/index.m3u8]?psig=…
async function handleDirect(req, res, url, selfHost) {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 3 || parts.length > 4 || parts[0] !== 'direct') return jsonError(res, 404, 'not found');
  const bad = hls.verify(url.pathname, url.searchParams.get('psig'));
  if (bad) return jsonError(res, 403, `invalid link: ${bad}`);
  const [, provider, payload] = parts;
  const t0 = Date.now();
  const r = await resolve(provider, payload);
  if (!r) return jsonError(res, 502, `${provider}: could not resolve a playable stream right now`);

  const headers = hls.compactHeaders(r.headers);
  const needsProxy = (r.subs && r.subs.length) || (Object.keys(headers).length && !(await hls.streamIsOpen(r.url)));
  const location = needsProxy ? hls.playlistUrl(selfHost, provider, { url: r.url, headers, subs: r.subs }) : r.url;
  if (process.env.ACCESS_LOG) console.log(`[direct] ${provider} → ${needsProxy ? '/hls' : 'upstream'} (${Date.now() - t0}ms)`);
  res.statusCode = 307;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end();
}

module.exports = { register, directUrl, resolve, prefetch, handleDirect };
