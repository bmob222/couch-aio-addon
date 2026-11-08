'use strict';
// Smoke test. Two parts:
//  1. OFFLINE (always): HMAC link signing, playlist rewriting, and a full
//     in-process round trip through the /hls + /direct routes against fake
//     local CDNs (one header-gated + PNG-disguised, one open).
//  2. LIVE (skip with OFFLINE=1): manifest + every catalog + a meta + streams
//     per provider against the REAL upstream sites.
// Run:  node test/smoke.js            (set RESOLVER_URL to also test movies)
process.env.PROXY_SECRET = process.env.PROXY_SECRET || 'smoke-test-secret';
const http = require('http');
const { handleRequest, manifest } = require('../lib/addon');
const hls = require('../lib/hls');
const direct = require('../lib/direct');
const { route } = require('../lib/router');

let pass = 0, fail = 0;
function log(ok, label, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}
const HOST = 'http://127.0.0.1:7701'; // placeholder self host for minted links

async function req(path) {
  const r = await handleRequest(path, HOST);
  return r.json;
}

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

// ---------------------------------------------------------------- offline
async function offline() {
  // signing
  const p = '/hls/x/playlist/abc/index.m3u8';
  const sig = hls.sign(p, 60);
  log(hls.verify(p, sig) === null, 'sign: valid psig verifies');
  log(hls.verify(p.replace('abc', 'abd'), sig) === 'bad signature', 'sign: tampered path rejected');
  log(hls.verify(p, hls.sign(p, -5)) === 'expired', 'sign: expired psig rejected');
  log(hls.verify(p, undefined) === 'missing psig', 'sign: missing psig rejected');

  // rewrite coverage
  const ctx = { host: HOST, provider: 'demo', headers: { Referer: 'https://ref.example/' } };
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="en",URI="audio/en.m3u8"',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720,AUDIO="a"',
    'v720/index.m3u8',
  ].join('\n');
  const media = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k.key"',
    '#EXTINF:6,', 'seg0.jpg', '#EXTINF:6,', 'https://cdn.example/abcdef', '#EXT-X-ENDLIST',
  ].join('\n');
  const fmp4 = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'part0.m4s', '#EXT-X-ENDLIST'].join('\n');
  const rm = hls.rewritePlaylist(master, 'https://cdn.example/m/master.m3u8', ctx);
  const rd = hls.rewritePlaylist(media, 'https://cdn.example/m/v720/index.m3u8', ctx);
  const rf = hls.rewritePlaylist(fmp4, 'https://cdn.example/f/index.m3u8', ctx);
  const leaked = [rm, rd, rf].some((t) => /cdn\.example|keys\.example/.test(t.replace(/\/resource\/[^/]+\//g, '/')));
  log(!leaked, 'rewrite: no upstream URI left un-proxied');
  const exts = (t) => (t.match(/\/media\.([a-z0-9]+)\?psig=/g) || []).map((m) => m.slice(7, -6));
  log(JSON.stringify(exts(rm)) === '["m3u8","m3u8","m3u8"]', 'rewrite: MEDIA/I-FRAME/variant → m3u8', exts(rm).join(','));
  log(JSON.stringify(exts(rd)) === '["key","ts","ts"]', 'rewrite: KEY + disguised .jpg + ext-less → key,ts,ts', exts(rd).join(','));
  log(JSON.stringify(exts(rf)) === '["mp4","m4s"]', 'rewrite: EXT-X-MAP + fMP4 segment → mp4,m4s', exts(rf).join(','));

  // in-process round trip against fake CDNs
  const ts = Buffer.alloc(188 * 20); for (let i = 0; i < 20; i++) ts[i * 188] = 0x47;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 7)]);
  const gated = await listen((rq, rs) => {
    if (rq.headers.referer !== 'https://player.example/') { rs.writeHead(403); return rs.end('forbidden'); }
    if (rq.url.startsWith('/master.m3u8')) {
      rs.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return rs.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\nlow.m3u8\n');
    }
    if (rq.url.startsWith('/low.m3u8')) {
      rs.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return rs.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.png\n#EXT-X-ENDLIST\n');
    }
    rs.writeHead(200, { 'Content-Type': 'image/png' });
    return rs.end(Buffer.concat([png, ts])); // PNG-prefixed TS
  });
  const open = await listen((rq, rs) => {
    if (rq.url.startsWith('/index.m3u8')) {
      rs.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      return rs.end('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg0.ts\n#EXT-X-ENDLIST\n');
    }
    rs.writeHead(200, { 'Content-Type': 'video/mp2t' });
    return rs.end(ts);
  });
  const self = await listen((rq, rs) => route(rq, rs, selfBase));
  const selfBase = self.base;
  try {
    direct.register('smokegated', async () => ({ url: `${gated.base}/master.m3u8`, headers: { Referer: 'https://player.example/', Origin: 'https://player.example' } }));
    direct.register('smokeopen', async () => ({ url: `${open.base}/index.m3u8`, headers: { Referer: 'https://player.example/' } }));

    const dg = await get(direct.directUrl(selfBase, 'smokegated', { id: 1 }));
    log(dg.status === 307 && /\/hls\/smokegated\/playlist\//.test(dg.headers.location || ''), 'direct: gated stream → 307 to /hls playlist');
    const m = await get(dg.headers.location);
    const variant = (String(m.body).match(/^http\S+$/m) || [])[0];
    log(m.status === 200 && /\/resource\/.+\/media\.m3u8/.test(variant || ''), 'hls: master rewritten, variant proxied');
    const v = await get(variant);
    const seg = (String(v.body).match(/^http\S+$/m) || [])[0];
    log(v.status === 200 && /\/media\.ts\?/.test(seg || ''), 'hls: disguised .png segment exposed as media.ts');
    const s = await get(seg);
    log(s.status === 200 && s.body[0] === 0x47 && s.headers['content-type'] === 'video/mp2t',
      'hls: gated segment RELAYED, PNG prefix stripped, video/mp2t', `${s.status} ${s.headers['content-type']} first=0x${(s.body[0] || 0).toString(16)}`);

    const dO = await get(direct.directUrl(selfBase, 'smokeopen', { id: 2 }));
    log(dO.status === 307 && dO.headers.location === `${open.base}/index.m3u8`, 'direct: open stream → 307 straight to upstream');
    const op = await get(hls.playlistUrl(selfBase, 'smokeopen', { url: `${open.base}/index.m3u8`, headers: { Referer: 'https://x/' } }));
    const oseg = (String(op.body).match(/^http\S+$/m) || [])[0];
    const os = await get(oseg);
    log(os.status === 307 && os.headers.location === `${open.base}/seg0.ts`, 'hls: open-CDN segment → 307 redirect (no relay)');

    const forged = await get(`${selfBase}/hls/smokegated/playlist/${hls.enc({ u: `${gated.base}/master.m3u8` })}/index.m3u8?psig=1.AAAA`);
    log(forged.status === 403 && /invalid link/.test(String(forged.body)), 'hls: forged signature → 403 JSON error');
  } finally {
    gated.srv.close(); open.srv.close(); self.srv.close();
  }
}

// ---------------------------------------------------------------- live
async function live() {
  const m = manifest();
  log(m.catalogs.length >= 5, 'manifest', `${m.catalogs.length} catalogs, v${m.version}`);

  const catalogs = [
    ['catalog/tv/globetv.live', 'GlobeTV live'],
    ['catalog/movie/ramoflix.movies', 'Ramoflix movies'],
    ['catalog/series/ramoflix.series', 'Ramoflix series'],
    ['catalog/movie/wmovies.movies', 'WMovies movies'],
    ['catalog/series/wmovies.series', 'WMovies series'],
    ['catalog/movie/doraby.movies', 'Doraby movies'],
    ['catalog/anime/anisuge.trending', 'Anisuge trending'],
    ['catalog/anime/animenexus.popular', 'AnimeNexus popular'],
  ];
  const firstIds = {};
  for (const [path, label] of catalogs) {
    try {
      const j = await req(path);
      const n = (j.metas || []).length;
      log(n > 0, `catalog: ${label}`, `${n} items${j.err ? ' err=' + j.err : ''}`);
      if (n > 0) firstIds[label] = j.metas[0].id;
    } catch (e) { log(false, `catalog: ${label}`, e.message); }
  }

  if (firstIds['GlobeTV live']) {
    const j = await req('stream/tv/' + encodeURIComponent(firstIds['GlobeTV live']));
    const s = (j.streams || [])[0];
    log(!!(s && s.ytId), 'stream: GlobeTV', s && s.ytId ? `ytId=${s.ytId}` : 'no ytId');
  }

  // Anisuge catalog item → meta episodes → episode streams (resolve-on-play)
  if (firstIds['Anisuge trending']) {
    const metaJ = await req('meta/anime/' + encodeURIComponent(firstIds['Anisuge trending']));
    const vids = (metaJ.meta && metaJ.meta.videos) || [];
    log(vids.length > 0, 'meta: Anisuge episodes', `${vids.length} episodes`);
    if (vids.length) {
      const sj = await req('stream/anime/' + encodeURIComponent(vids[0].id));
      const n = (sj.streams || []).length;
      log(n > 0 && sj.streams.every((s) => /\/direct\/anisuge\//.test(s.url)), 'stream: Anisuge episode', `${n} /direct stream(s)`);
    }
  }

  // App-style anime request keyed by IMDb id (Frieren S1E1) + play-time resolve.
  {
    const sj = await req('stream/series/tt22248376:1:1');
    const st = (sj.streams || []);
    log(st.length > 0 && st.every((s) => s.behaviorHints && s.behaviorHints.proxyHeaders && s.behaviorHints.notWebReady),
      'stream: anime by IMDb (Frieren tt22248376:1:1)', `${st.length} stream(s): ${st.map((s) => s.name.split('\n')[1]).join(', ')}`);
    if (st.length) {
      const [, , provider, payload] = new URL(st[0].url).pathname.split('/');
      const r = await direct.resolve(provider, payload);
      log(!!(r && /\.m3u8/.test(r.url)), 'direct: anisuge play-time resolve → m3u8', r ? `${(r.subs || []).length} subtitle tracks` : 'null');
    }
  }

  // Movies: with a resolver, expect resolve-on-play HLS rows; without one,
  // validate the embed reconstruction (INCLUDE_EMBEDS).
  if (process.env.RESOLVER_URL) {
    const j = await req('stream/movie/tt1375666'); // Inception
    const st = (j.streams || []).filter((s) => /\/direct\//.test(s.url || ''));
    log(st.length > 0, 'stream: Inception via resolver (/direct)', st.map((s) => s.title.split('\n').pop()).join(' | '));
  }
  process.env.INCLUDE_EMBEDS = '1';
  {
    const j = await req('stream/movie/tt1375666');
    log((j.streams || []).length > 0, 'stream: IMDB embed (tt1375666)', `${(j.streams || []).length} sources`);
  }
  {
    const j = await req('stream/series/tt0944947:1:1'); // GoT S1E1
    log((j.streams || []).length > 0, 'stream: IMDB series embed', `${(j.streams || []).length} sources`);
  }

  const fm = firstIds['WMovies movies'] || firstIds['Ramoflix movies'];
  if (fm) {
    const metaJ = await req('meta/movie/' + encodeURIComponent(fm));
    log(!!(metaJ.meta && metaJ.meta.name), 'meta: fmovie title', metaJ.meta && metaJ.meta.name);
    const sj = await req('stream/movie/' + encodeURIComponent(fm));
    log((sj.streams || []).length > 0, 'stream: fmovie title embeds', `${(sj.streams || []).length} sources`);
  }
}

(async () => {
  console.log('— offline —');
  await offline();
  if (process.env.OFFLINE !== '1') { console.log('— live —'); await live(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
