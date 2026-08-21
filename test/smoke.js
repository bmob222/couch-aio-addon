'use strict';
// Live smoke test — exercises manifest + every catalog + a meta + a stream per
// provider against the REAL upstream sites. Prints a pass/fail table. Run:
//   node test/smoke.js
const { handleRequest, manifest } = require('../lib/addon');

let pass = 0, fail = 0;
function log(ok, label, detail) {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`);
  ok ? pass++ : fail++;
}

async function req(path) {
  const r = await handleRequest(path);
  return r.json;
}

(async () => {
  // 1. manifest
  const m = manifest();
  log(m.catalogs.length >= 5, 'manifest', `${m.catalogs.length} catalogs, v${m.version}`);

  // 2. catalogs
  const catalogs = [
    ['catalog/tv/globetv.live', 'GlobeTV live'],
    ['catalog/movie/ramoflix.movies', 'Ramoflix movies'],
    ['catalog/series/ramoflix.series', 'Ramoflix series'],
    ['catalog/movie/wmovies.movies', 'WMovies movies'],
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

  // 3. GlobeTV stream (ytId — should always resolve)
  if (firstIds['GlobeTV live']) {
    const j = await req('stream/tv/' + encodeURIComponent(firstIds['GlobeTV live']));
    const s = (j.streams || [])[0];
    log(!!(s && s.ytId), 'stream: GlobeTV', s && s.ytId ? `ytId=${s.ytId}` : 'no ytId');
  }

  // 4. IMDB → embed sources (no scrape; pure reconstruction)
  {
    const j = await req('stream/movie/tt1375666'); // Inception
    const n = (j.streams || []).length;
    log(n > 0, 'stream: IMDB embed (tt1375666)', `${n} embed sources`);
  }
  {
    const j = await req('stream/series/tt0944947:1:1'); // GoT S1E1
    const n = (j.streams || []).length;
    log(n > 0, 'stream: IMDB series embed', `${n} embed sources`);
  }

  // 5. Anisuge meta → episodes → first episode stream
  if (firstIds['Anisuge trending']) {
    const metaJ = await req('meta/anime/' + encodeURIComponent(firstIds['Anisuge trending']));
    const vids = (metaJ.meta && metaJ.meta.videos) || [];
    log(vids.length > 0, 'meta: Anisuge episodes', `${vids.length} episodes`);
    if (vids.length) {
      const sj = await req('stream/anime/' + encodeURIComponent(vids[0].id));
      const n = (sj.streams || []).length;
      log(n > 0, 'stream: Anisuge episode', `${n} stream(s)${n ? ' — ' + ((sj.streams[0].url && 'HLS') || 'embed') : ''}`);
    }
  }

  // 6. Ramoflix meta (title-page id extraction)
  if (firstIds['Ramoflix movies']) {
    const metaJ = await req('meta/movie/' + encodeURIComponent(firstIds['Ramoflix movies']));
    log(!!(metaJ.meta && metaJ.meta.name), 'meta: Ramoflix title', metaJ.meta && metaJ.meta.name);
    const sj = await req('stream/movie/' + encodeURIComponent(firstIds['Ramoflix movies']));
    log((sj.streams || []).length > 0, 'stream: Ramoflix embeds', `${(sj.streams || []).length} sources`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
