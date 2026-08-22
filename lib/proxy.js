'use strict';
// HLS/stream proxy. Some source CDNs referer-gate their m3u8/segments to the
// embed host (e.g. anisuge's akirax.buzz requires Referer: vidtube.site). Rather
// than depend on the Stremio client honoring proxyHeaders, we hand the client a
// URL on THIS server; we fetch upstream with the right Referer and rewrite the
// playlist so segments/keys/child playlists route back through us too.
const { request } = require('./http');

// Build a proxied URL for `target`, carrying the referer. The URL path ends in
// a REAL media extension because FFmpeg's HLS demuxer whitelists segment URLs
// by extension — CDNs that disguise segments as `.jpg` (anisuge's sugevideo)
// would otherwise be rejected with "not in allowed_segment_extensions" /
// INVALIDDATA before a single byte is read.
function proxSuffix(target) {
  if (isM3U8(target, '')) return 'index.m3u8';
  if (/\.m4s(\?|$)/i.test(target)) return 'seg.m4s';
  if (/\.mp4(\?|$)/i.test(target)) return 'seg.mp4';
  if (/\.(key|vtt|srt|ass)(\?|$)/i.test(target)) return 'file.' + target.match(/\.(key|vtt|srt|ass)(\?|$)/i)[1];
  return 'seg.ts';
}
function proxUrl(host, target, ref, opts = {}) {
  let q = `u=${encodeURIComponent(target)}${ref ? `&r=${encodeURIComponent(ref)}` : ''}`;
  // Master-playlist URLs may carry subtitle tracks to inject as native HLS
  // EXT-X-MEDIA renditions: [{ url, lang, name }] → base64url JSON in `s`.
  if (opts.subs && opts.subs.length) {
    q += `&s=${Buffer.from(JSON.stringify(opts.subs)).toString('base64url')}`;
  }
  return `${host}/proxy/${proxSuffix(target)}?${q}`;
}

function isM3U8(url, contentType) {
  return /\.m3u8(\?|$)/i.test(url) || /mpegurl/i.test(contentType || '');
}

// Inject external subtitle tracks into a MASTER playlist as native HLS WebVTT
// renditions, so FFmpeg-based players surface them as embedded subtitle tracks
// (clients that ignore Stremio stream-level `subtitles` still get subs).
function injectSubs(text, selfHost, ref, subs) {
  if (!subs || !subs.length || !/#EXT-X-STREAM-INF/.test(text)) return text;
  const media = subs.map((s, i) => {
    const wrap = `${selfHost}/proxy/subs.m3u8?w=1&u=${encodeURIComponent(s.url)}${ref ? `&r=${encodeURIComponent(ref)}` : ''}`;
    const lang = (s.lang || 'und').slice(0, 3);
    const name = (s.name || s.lang || `Subs ${i + 1}`).replace(/"/g, '');
    return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cs",NAME="${name}",LANGUAGE="${lang}",AUTOSELECT=YES,DEFAULT=${i === 0 ? 'YES' : 'NO'},URI="${wrap}"`;
  }).join('\n');
  return text
    .replace('#EXTM3U', `#EXTM3U\n${media}`)
    .replace(/#EXT-X-STREAM-INF:([^\n]*)/g, (m, attrs) =>
      /SUBTITLES=/.test(attrs) ? m : `#EXT-X-STREAM-INF:${attrs},SUBTITLES="cs"`);
}

// A single-segment HLS playlist wrapping one WebVTT file (the standard way to
// carry side-loaded subs as an HLS rendition).
function subsWrapperPlaylist(vttUrl, selfHost, ref) {
  const proxied = proxUrl(selfHost, vttUrl, ref);
  return ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:7200',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXTINF:7200,', proxied, '#EXT-X-ENDLIST', ''].join('\n');
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

  // Subtitle-rendition wrapper: emit a one-segment playlist around a .vtt.
  if (query.get('w') === '1') {
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.writeHead(200);
    return res.end(subsWrapperPlaylist(target, selfHost, ref));
  }
  let subs = null;
  if (query.get('s')) {
    try { subs = JSON.parse(Buffer.from(query.get('s'), 'base64url').toString('utf8')); } catch (e) {}
  }

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
    const body = injectSubs(rewritePlaylist(text, upstream.finalUrl || target, selfHost, ref), selfHost, ref, subs);
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
  // Some CDNs disguise TS segments as images (content-type: image/jpeg with a
  // real MPEG-TS body). Players can reject the mislabel — sniff the 0x47 sync
  // byte pattern and correct it.
  const buf = Buffer.isBuffer(upstream.body) ? upstream.body : Buffer.from(upstream.body, 'binary');
  if (buf.length > 376 && buf[0] === 0x47 && buf[188] === 0x47 && buf[376] === 0x47) {
    out['content-type'] = 'video/mp2t';
  }
  // Subtitle CDNs commonly serve application/octet-stream; players require a
  // real subtitle content-type to parse the track.
  if (/\.vtt(\?|$)/i.test(target) || buf.slice(0, 6).toString() === 'WEBVTT') {
    out['content-type'] = 'text/vtt; charset=utf-8';
  } else if (/\.srt(\?|$)/i.test(target)) {
    out['content-type'] = 'application/x-subrip; charset=utf-8';
  } else if (/\.ass(\?|$)/i.test(target)) {
    out['content-type'] = 'text/x-ssa; charset=utf-8';
  }
  out['Access-Control-Allow-Origin'] = '*';
  for (const [k, v] of Object.entries(out)) res.setHeader(k, v);
  res.writeHead(upstream.status);
  res.end(Buffer.isBuffer(upstream.body) ? upstream.body : Buffer.from(upstream.body, 'binary'));
}

module.exports = { handleProxy, proxUrl, isM3U8, rewritePlaylist };
