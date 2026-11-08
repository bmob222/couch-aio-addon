'use strict';
// Signed HLS playlist proxy.
//
// Free-stream CDNs now refuse playback unless every request (playlist AND each
// segment) looks like it comes from their own player page (Referer/Origin/UA).
// Instead of depending on the client honouring header hints, streams point at
// THIS server:
//
//   /hls/<provider>/playlist/<payload>/index.m3u8?psig=<exp>.<mac>
//       → fetch upstream with the provider's headers, rewrite EVERY URI
//         (variants, segments, EXT-X-MAP/KEY/MEDIA/I-FRAME/PART) to …
//   /hls/<provider>/resource/<payload>/media.<ext>?psig=…
//       → child playlists: fetched + rewritten again
//       → segments/keys/subs: 307 to the upstream URL when that CDN serves
//         WITHOUT headers (no bandwidth through us), otherwise relayed
//         (streamed, Range-preserving, binary-safe).
//
// <payload> = base64url(JSON {u: url, h: headers, s?: subs, w?: wrapper}).
// psig = HMAC-SHA256(PROXY_SECRET, "<exp>:<pathname>") — only URLs this server
// minted are served, so the proxy is not an open relay.
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { request, UA } = require('./http');
const cache = require('./cache');

// ------------------------------------------------------------------ signing
let SECRET = process.env.PROXY_SECRET || '';
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[couch-aio] PROXY_SECRET is not set — using a random per-process secret. ' +
    'Signed /hls and /direct links will break after a restart or across ' +
    'serverless instances. Set PROXY_SECRET (e.g. `vercel env add PROXY_SECRET production`).'
  );
}
const PLAYLIST_TTL_S = parseInt(process.env.HLS_LINK_TTL_S || String(8 * 3600), 10);

function mac(str) {
  return crypto.createHmac('sha256', SECRET).update(str).digest().subarray(0, 18).toString('base64url');
}
function sign(pathname, ttlS = PLAYLIST_TTL_S) {
  const exp = Math.floor(Date.now() / 1000) + ttlS;
  return `${exp}.${mac(`${exp}:${pathname}`)}`;
}
// → null when valid, else an error string.
function verify(pathname, psig) {
  if (!psig || typeof psig !== 'string') return 'missing psig';
  const dot = psig.indexOf('.');
  if (dot < 1) return 'malformed psig';
  const exp = parseInt(psig.slice(0, dot), 10);
  const got = Buffer.from(psig.slice(dot + 1));
  const want = Buffer.from(mac(`${exp}:${pathname}`));
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return 'bad signature';
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return 'expired';
  return null;
}
function signedUrl(host, pathname, ttlS) {
  return `${host}${pathname}?psig=${sign(pathname, ttlS)}`;
}

// ------------------------------------------------------------------ payloads
const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
function dec(str) {
  try { return JSON.parse(Buffer.from(str, 'base64url').toString('utf8')); } catch (e) { return null; }
}
// Keep per-segment URLs short: drop the default UA (re-added on fetch).
function compactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (v == null || v === '') continue;
    if (/^user-agent$/i.test(k) && v === UA) continue;
    if (/^accept$/i.test(k) && v === '*/*') continue;
    out[k] = v;
  }
  return out;
}
const cleanProvider = (p) => String(p || 'x').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'x';

function playlistUrl(host, provider, { url, headers, subs }) {
  const body = { u: url, h: compactHeaders(headers) };
  if (subs && subs.length) body.s = subs;
  return signedUrl(host, `/hls/${cleanProvider(provider)}/playlist/${enc(body)}/index.m3u8`);
}
function resourceUrl(host, provider, { url, headers, w }, ext) {
  const body = { u: url, h: compactHeaders(headers) };
  if (w) body.w = 1;
  return signedUrl(host, `/hls/${cleanProvider(provider)}/resource/${enc(body)}/media.${ext}`);
}

// ------------------------------------------------------------------ rewrite
const DISGUISE_EXT = /\.(jpe?g|png|gif|webp|bmp|ico|svg|html?|php|js|css|txt|json|woff2?)$/i;
function urlExt(u) {
  try { return (new URL(u).pathname.match(/\.([a-z0-9]{2,5})$/i) || [])[1]?.toLowerCase() || ''; } catch (e) { return ''; }
}
// Pick the extension we EXPOSE for a segment. FFmpeg's HLS demuxer whitelists
// segment URLs by extension, so disguised names (.jpg/.png/.html/none) become
// media.ts — or media.m4s/.mp4 in an fMP4 (EXT-X-MAP) playlist.
function segmentExt(u, fmp4) {
  const e = urlExt(u);
  if (e === 'm3u8') return 'm3u8';
  if (['aac', 'mp3', 'ac3', 'ec3', 'vtt', 'webvtt', 'srt', 'key'].includes(e)) return e === 'webvtt' ? 'vtt' : e;
  if (fmp4) return e === 'mp4' ? 'mp4' : 'm4s';
  if (e === 'm4s' || e === 'mp4') return e;
  return 'ts';
}

// Rewrite every URI in a playlist through /hls/<provider>/resource.
function rewritePlaylist(text, baseUrl, ctx) {
  const { host, provider, headers } = ctx;
  const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch (e) { return u; } };
  const res = (u, ext) => resourceUrl(host, provider, { url: abs(u), headers }, ext);
  const fmp4 = /#EXT-X-MAP:/i.test(text);
  let nextIsVariant = false;
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      const tag = (t.match(/^#([A-Z0-9-]+)/i) || [])[1] || '';
      if (tag === 'EXT-X-STREAM-INF') nextIsVariant = true;
      if (!/URI="/.test(t)) return line;
      return line.replace(/URI="([^"]+)"/g, (m, u) => {
        if (/^(data|skd|blob):/i.test(u)) return m;
        let ext;
        if (tag === 'EXT-X-KEY' || tag === 'EXT-X-SESSION-KEY') ext = 'key';
        else if (tag === 'EXT-X-MAP') ext = 'mp4';
        else if (tag === 'EXT-X-MEDIA' || tag === 'EXT-X-I-FRAME-STREAM-INF' || tag === 'EXT-X-RENDITION-REPORT') ext = 'm3u8';
        else ext = segmentExt(u, fmp4);
        return `URI="${res(u, ext)}"`;
      });
    }
    const ext = nextIsVariant ? 'm3u8' : segmentExt(t, fmp4);
    nextIsVariant = false;
    return res(t, ext);
  }).join('\n');
}

// Inject side-loaded subtitles into a MASTER playlist as native WebVTT
// renditions (players that ignore Stremio stream-level `subtitles` still get
// selectable tracks). subs = [{url, lang, name}].
function injectSubs(text, ctx, subs) {
  if (!subs || !subs.length || !/#EXT-X-STREAM-INF/.test(text)) return text;
  const media = subs.map((s, i) => {
    const wrap = resourceUrl(ctx.host, ctx.provider, { url: s.url, headers: ctx.headers, w: 1 }, 'm3u8');
    const lang = (s.lang || 'und').slice(0, 3);
    const name = (s.name || s.lang || `Subs ${i + 1}`).replace(/"/g, '');
    return `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cs",NAME="${name}",LANGUAGE="${lang}",AUTOSELECT=YES,DEFAULT=${i === 0 ? 'YES' : 'NO'},URI="${wrap}"`;
  }).join('\n');
  return text
    .replace('#EXTM3U', `#EXTM3U\n${media}`)
    .replace(/#EXT-X-STREAM-INF:([^\n]*)/g, (m, attrs) =>
      /SUBTITLES=/.test(attrs) ? m : `#EXT-X-STREAM-INF:${attrs},SUBTITLES="cs"`);
}

// ------------------------------------------------------------------ host verdicts
// Does this CDN host serve without the provider headers? Probed once with the
// first resource we see (no Referer/Origin, tiny Range), cached ~1 h.
const VERDICT_TTL = parseInt(process.env.HLS_VERDICT_TTL_S || '3600', 10) * 1000;
const probing = new Map();

function rawGet(url, headers, { method = 'GET', timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(u, { method, headers, timeout }, resolve);
    req.on('timeout', () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
    req.end();
  });
}
// GET following redirects (manually, so we keep our headers).
async function rawGetFollow(url, headers, opts, hops = 0) {
  const r = await rawGet(url, headers, opts);
  if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && hops < 5) {
    r.resume();
    return rawGetFollow(new URL(r.headers.location, url).toString(), headers, opts, hops + 1);
  }
  r.finalUrl = url;
  return r;
}

// Read up to n bytes then abort.
function firstBytes(res, n = 512) {
  return new Promise((resolve) => {
    const chunks = []; let len = 0; let done = false;
    const finish = () => { if (done) return; done = true; res.destroy(); resolve(Buffer.concat(chunks)); };
    res.on('data', (c) => { chunks.push(c); len += c.length; if (len >= n) finish(); });
    res.on('end', finish); res.on('error', finish); res.on('close', finish);
  });
}

// Image/HTML magic at the start of a body (disguised or error responses).
function imageMagic(buf) {
  if (!buf || buf.length < 4) return false;
  return (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') ||
    (buf[0] === 0xff && buf[1] === 0xd8) || buf.subarray(0, 4).toString('latin1') === 'GIF8' ||
    buf.subarray(0, 2).toString('latin1') === 'BM' || buf.subarray(8, 12).toString('latin1') === 'WEBP';
}
function looksLikeMedia(buf, ct) {
  if (!buf || !buf.length) return false;
  if (buf[0] === 0x47) return true; // MPEG-TS sync
  const box = buf.subarray(4, 8).toString('latin1');
  if (['ftyp', 'styp', 'moof', 'sidx', 'moov'].includes(box)) return true;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return true; // packed audio
  if (/^\s*</.test(buf.subarray(0, 32).toString('latin1'))) return false; // HTML error page
  return !/text\/html|json/i.test(ct || '');
}
// Offset of the first MPEG-TS packet run (3 sync bytes 188 apart), or -1.
// Some CDNs prepend a real PNG/JPEG header to TS segments; FFmpeg then probes
// png_pipe and refuses the segment, so we strip the prefix when relaying.
function tsSyncOffset(buf, maxScan = 65536) {
  const end = Math.min(buf.length - 377, maxScan);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47 && buf[i + 376] === 0x47) return i;
  }
  return -1;
}

async function hostVerdict(url, ua) {
  let host;
  try { host = new URL(url).host; } catch (e) { return { open: false }; }
  const key = `hlsv:${host}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (probing.has(host)) return probing.get(host);
  const p = (async () => {
    let v = { open: false };
    try {
      const r = await rawGetFollow(url, { 'User-Agent': ua || UA, Accept: '*/*', Range: 'bytes=0-511' }, { timeout: 8000 });
      const ct = r.headers['content-type'] || '';
      const buf = await firstBytes(r, 512);
      v = {
        open: (r.statusCode === 200 || r.statusCode === 206) && looksLikeMedia(buf, ct),
        // Image-wrapped media must always be relayed (prefix stripped).
        disguised: imageMagic(buf) || /^image\//i.test(ct),
        // Honest media content-type → safe to redirect even extension-less URLs
        // (an image/* or text/* label could make FFmpeg mis-probe the format).
        honestType: /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|mp4))/i.test(ct),
        status: r.statusCode,
      };
    } catch (e) { v = { open: false, err: e.message }; }
    cache.set(key, v, VERDICT_TTL);
    return v;
  })().finally(() => probing.delete(host));
  probing.set(host, p);
  return p;
}

// ------------------------------------------------------------------ handlers
function jsonError(res, status, error) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify({ error }));
}
function fetchHeaders(h) {
  const out = { 'User-Agent': UA, Accept: '*/*' };
  for (const [k, v] of Object.entries(h || {})) out[k] = v;
  return out;
}

async function servePlaylist(res, upstreamUrl, ctx, subs) {
  let up;
  try {
    up = await request(upstreamUrl, { headers: fetchHeaders(ctx.headers), timeout: 20000 });
  } catch (e) { return jsonError(res, 502, `upstream fetch failed: ${e.message}`); }
  const text = String(up.body || '');
  if (up.status >= 400 || !/#EXTM3U/.test(text.slice(0, 1024))) {
    return jsonError(res, up.status >= 400 ? up.status : 502, `upstream playlist unavailable (HTTP ${up.status})`);
  }
  const body = injectSubs(rewritePlaylist(text, up.finalUrl || upstreamUrl, ctx), ctx, subs);
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(body);
}

function subsWrapper(res, vttResourceUrl) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:7200', '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:7200,', vttResourceUrl, '#EXT-X-ENDLIST', ''].join('\n'));
}

const EXT_CT = {
  ts: 'video/mp2t', m4s: 'video/iso.segment', mp4: 'video/mp4', aac: 'audio/aac', mp3: 'audio/mpeg',
  ac3: 'audio/ac3', ec3: 'audio/eac3', key: 'application/octet-stream',
  vtt: 'text/vtt; charset=utf-8', srt: 'application/x-subrip; charset=utf-8',
};
function sniffType(buf, ext, upstreamCt) {
  if (buf && buf.length) {
    if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'video/mp2t';
    const box = buf.subarray(4, 8).toString('latin1');
    if (['ftyp', 'styp', 'moof', 'sidx'].includes(box)) return ext === 'm4s' ? 'video/iso.segment' : 'video/mp4';
    if (buf.subarray(0, 6).toString('latin1') === 'WEBVTT' || buf.subarray(3, 9).toString('latin1') === 'WEBVTT') return 'text/vtt; charset=utf-8';
  }
  // Disguised segment served as image/* or text/* → expose as the real type.
  if (EXT_CT[ext] && (!upstreamCt || /^(image|text\/html|application\/octet-stream|binary)/i.test(upstreamCt))) return EXT_CT[ext];
  return upstreamCt || EXT_CT[ext] || 'application/octet-stream';
}

// Stream-through relay: Range-preserving, binary-safe. Only the first few KB
// are held back to sniff the real type (and strip an image prefix from
// disguised TS segments); the rest is piped as it arrives.
const SNIFF_BYTES = 4096;
const SNIFF_MAX = 65536 + 512;
async function relay(req, res, upstreamUrl, headers, ext) {
  const h = fetchHeaders(headers);
  if (req.headers.range) h.Range = req.headers.range;
  let up;
  try {
    up = await rawGetFollow(upstreamUrl, h, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', timeout: 25000 });
  } catch (e) { return jsonError(res, 502, `upstream fetch failed: ${e.message}`); }
  res.on('close', () => up.destroy());

  const writeHead = (head, stripped) => {
    res.statusCode = stripped && up.statusCode === 206 ? 200 : up.statusCode;
    const keep = stripped ? ['cache-control', 'last-modified'] :
      ['content-length', 'content-range', 'accept-ranges', 'cache-control', 'last-modified', 'etag'];
    for (const k of keep) if (up.headers[k]) res.setHeader(k, up.headers[k]);
    res.setHeader('Content-Type', up.statusCode < 400 ? sniffType(head, ext, up.headers['content-type']) : (up.headers['content-type'] || 'text/plain'));
    res.setHeader('Access-Control-Allow-Origin', '*');
  };
  if (req.method === 'HEAD') { writeHead(null, false); up.resume(); return res.end(); }

  const chunks = []; let len = 0; let decided = false;
  const decide = (ended) => {
    decided = true;
    up.removeListener('data', onData);
    let head = Buffer.concat(chunks);
    let stripped = false;
    // Disguised TS: image magic (or non-TS start) in a TS slot → find the
    // first sync run and drop everything before it.
    if (up.statusCode < 400 && ext === 'ts' && head.length > 377 && head[0] !== 0x47) {
      const off = tsSyncOffset(head);
      if (off > 0) { head = head.subarray(off); stripped = true; }
    }
    writeHead(head, stripped);
    if (ended) return res.end(head);
    res.write(head);
    up.pipe(res);
  };
  const onData = (c) => {
    chunks.push(c); len += c.length;
    // TS start → decide immediately; otherwise keep reading (up to SNIFF_MAX)
    // so a prefixed image can be skipped.
    const first = chunks[0];
    if (len >= SNIFF_MAX || (len >= SNIFF_BYTES && (first[0] === 0x47 || ext !== 'ts' || tsSyncOffset(Buffer.concat(chunks)) >= 0))) decide(false);
  };
  up.on('data', onData);
  up.on('end', () => { if (!decided) decide(true); });
  up.on('error', () => { if (!decided) jsonError(res, 502, 'upstream stream error'); else res.destroy(); });
}

const SEGMENT_MODE = () => (process.env.HLS_SEGMENT_MODE || 'auto').toLowerCase(); // auto|relay|redirect

async function serveResource(req, res, body, ext, ctx) {
  if (body.w) {
    return subsWrapper(res, resourceUrl(ctx.host, ctx.provider, { url: body.u, headers: ctx.headers }, 'vtt'));
  }
  if (ext === 'm3u8') return servePlaylist(res, body.u, ctx, null);

  // Segment / key / subtitle: redirect when the CDN is open, else relay.
  const mode = SEGMENT_MODE();
  // Disguised names (.jpg/.png/.html) are always relayed so the client sees a
  // real media content-type; extension-less URLs only redirect when the CDN
  // labels them honestly.
  const disguised = DISGUISE_EXT.test(safePath(body.u));
  let redirect = false;
  if (mode === 'redirect') redirect = true;
  else if (mode === 'auto' && !disguised && ext !== 'key') {
    const v = await hostVerdict(body.u, ctx.headers['User-Agent']);
    redirect = v.open && !v.disguised && (!!urlExt(body.u) || v.honestType);
  }
  if (process.env.ACCESS_LOG) console.log(`[hls] ${ctx.provider} ${ext} ${(() => { try { return new URL(body.u).host; } catch (e) { return '?'; } })()} → ${redirect ? 'redirect' : 'relay'}`);
  if (redirect) {
    res.statusCode = 307;
    res.setHeader('Location', body.u);
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.end();
  }
  return relay(req, res, body.u, ctx.headers, ext);
}
function safePath(u) { try { return new URL(u).pathname; } catch (e) { return ''; } }

// Entry point: GET /hls/<provider>/<playlist|resource>/<payload>/<file>?psig=…
async function handleHls(req, res, url, selfHost) {
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const parts = url.pathname.split('/').filter(Boolean); // hls, provider, kind, payload, file
  if (parts.length !== 5 || parts[0] !== 'hls') return jsonError(res, 404, 'not found');
  const [, provider, kind, payload, file] = parts;
  const bad = verify(url.pathname, url.searchParams.get('psig'));
  if (bad) return jsonError(res, 403, `invalid link: ${bad}`);
  const body = dec(payload);
  if (!body || !body.u || !/^https?:\/\//i.test(body.u)) return jsonError(res, 400, 'bad payload');
  const ctx = { host: selfHost, provider, headers: fetchHeaders(body.h) };
  const ext = (file.match(/\.([a-z0-9]+)$/i) || [])[1] || 'ts';
  if (kind === 'playlist') return servePlaylist(res, body.u, ctx, body.s);
  if (kind === 'resource') return serveResource(req, res, body, ext.toLowerCase(), ctx);
  return jsonError(res, 404, 'not found');
}

// Is a stream playable WITHOUT any headers? (playlist + first variant + first
// segment). Used by /direct to decide 307-direct vs 307-to-/hls.
async function streamIsOpen(m3u8Url) {
  const key = `hlsopen:${(() => { try { return new URL(m3u8Url).host; } catch (e) { return m3u8Url; } })()}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let open = false;
  try {
    let url = m3u8Url;
    for (let depth = 0; depth < 3; depth++) {
      const r = await request(url, { headers: { Accept: '*/*' }, timeout: 8000 });
      const text = String(r.body || '');
      if (r.status !== 200 || !/#EXTM3U/.test(text.slice(0, 1024))) break;
      const lines = text.split(/\r?\n/).map((l) => l.trim());
      const variantIdx = lines.findIndex((l) => l.startsWith('#EXT-X-STREAM-INF'));
      const next = variantIdx >= 0 ? lines.slice(variantIdx + 1).find((l) => l && !l.startsWith('#'))
        : lines.find((l) => l && !l.startsWith('#'));
      if (!next) break;
      const abs = new URL(next, r.finalUrl || url).toString();
      if (variantIdx >= 0) { url = abs; continue; }
      // Disguised segments must go through /hls (they need the media.ts name).
      if (DISGUISE_EXT.test(safePath(abs)) || !urlExt(abs)) break;
      open = (await hostVerdict(abs)).open;
      break;
    }
  } catch (e) { open = false; }
  cache.set(key, open, VERDICT_TTL);
  return open;
}

module.exports = {
  handleHls, playlistUrl, resourceUrl, rewritePlaylist, injectSubs, sign, verify, signedUrl,
  enc, dec, streamIsOpen, hostVerdict, segmentExt, compactHeaders,
};
