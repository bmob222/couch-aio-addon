'use strict';
// HLS/stream proxy. Some source CDNs referer-gate their m3u8/segments to the
// embed host (e.g. anisuge's akirax.buzz requires Referer: vidtube.site). Rather
// than depend on the Stremio client honoring proxyHeaders, we hand the client a
// URL on THIS server; we fetch upstream with the right Referer and rewrite the
// playlist so segments/keys/child playlists route back through us too.
const { request } = require('./http');

// Build a proxied URL for `target`, carrying the referer.
function proxUrl(host, target, ref) {
  const q = `u=${encodeURIComponent(target)}${ref ? `&r=${encodeURIComponent(ref)}` : ''}`;
  return `${host}/proxy?${q}`;
}

function isM3U8(url, contentType) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType || '');
}

// Rewrite an m3u8 so every URI (segments, keys, child playlists) goes back
// through /proxy with the same referer. selfHost is like "http://localhost:7700".
function rewritePlaylist(text, baseUrl, selfHost, ref) {
  const base = new URL(baseUrl);
  const absolutize = (u) => {
    try { return new URL(u, base).toString(); } catch (e) { return u; }
  };
  return text
    .split('\n')
    .map((line) => {
      const t = line.trim();
      if (!t) return line;
      // KEY / MAP lines carry URI="..."
      if (t.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxUrl(selfHost, absolutize(u), ref)}"`);
      }
      // A bare URI line (segment or child playlist)
      return proxUrl(selfHost, absolutize(t), ref);
    })
    .join('\n');
}

// Handle GET /proxy?u=<url>&r=<referer>. Returns { status, headers, body|stream }.
async function handleProxy(query, selfHost, res) {
  const target = query.get('u');
  const ref = query.get('r') || '';
  if (!target) { res.writeHead(400); return res.end('missing u'); }

  const headers = {};
  if (ref) { headers.Referer = ref; try { headers.Origin = new URL(ref).origin; } catch (e) {} }

  // Pass through the client's Range header for seeking.
  const range = res.__range;
  if (range) headers.Range = range;

  const wantsPlaylist = isM3U8(target, '');
  let upstream;
  try {
    upstream = await request(target, { headers, timeout: 20000, binary: !wantsPlaylist });
  } catch (e) {
    res.writeHead(502); return res.end('proxy fetch failed: ' + e.message);
  }

  const ct = upstream.headers['content-type'] || '';
  if (wantsPlaylist || isM3U8(target, ct)) {
    const text = Buffer.isBuffer(upstream.body) ? upstream.body.toString('utf8') : upstream.body;
    const body = rewritePlaylist(text, upstream.finalUrl || target, selfHost, ref);
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    return res.end(body);
  }

  // Binary segment/key: relay bytes + key upstream headers.
  const out = {};
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
    if (upstream.headers[h]) out[h] = upstream.headers[h];
  }
  out['Access-Control-Allow-Origin'] = '*';
  for (const [k, v] of Object.entries(out)) res.setHeader(k, v);
  res.writeHead(upstream.status);
  res.end(Buffer.isBuffer(upstream.body) ? upstream.body : Buffer.from(upstream.body, 'binary'));
}

module.exports = { handleProxy, proxUrl, isM3U8, rewritePlaylist };
