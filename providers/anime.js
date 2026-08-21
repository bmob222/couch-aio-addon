'use strict';
// Anime provider. Primary source: anisuge.tv (AnimeSuge/Zoro clone — SSR PHP with
// /ajax/ endpoints, curl-friendly, real m3u8 via the megaplay embed). Secondary:
// anime.nexus catalog (its /api/anime/discover JSON is reachable; its streams are
// Cloudflare-gated so we surface catalog only).
//
// Stremio ids we mint:
//   anime:as:<slug>                  → anisuge anime (meta lists episodes)
//   anime:as:<slug>:<episodeId>:<sub|dub>  → an episode stream
//   anime:nx:<uuid>:<slug>           → anime.nexus catalog item (meta best-effort)
const { getText, getJson } = require('../lib/http');
const cache = require('../lib/cache');

const AS = 'https://anisuge.tv';
const NX = 'https://api.anime.nexus';
const AJAX = { 'X-Requested-With': 'XMLHttpRequest', Referer: AS + '/' };

const CATALOGS = [
  { type: 'anime', id: 'anisuge.trending', name: 'Anisuge · Trending', extra: [{ name: 'search' }, { name: 'skip' }] },
  { type: 'anime', id: 'animenexus.popular', name: 'AnimeNexus · Popular', extra: [{ name: 'skip' }] },
];

function handlesCatalog(id) {
  return id === 'anisuge.trending' || id === 'animenexus.popular';
}

// ---- anisuge catalog: parse /filter or /home cards --------------------------
function parseAnisugeCards(html) {
  const out = [];
  // Card anchor: <a class="poster..." href="https://anisuge.tv/watch/<slug>[/ep-N]"
  //   data-tip="<animeId>"> ... <img ... data-src="<poster>" alt="<title>">
  const re = /href="(?:https?:\/\/[^/]+)?\/watch\/([^"?#]+?)"[^>]*?(?:data-tip="(\d+)")?[^>]*>[\s\S]{0,300}?<img[^>]*?(?:data-src|src)="([^"]+)"[^>]*?alt="([^"]*)"/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) && out.length < 40) {
    let slug = m[1].replace(/\/ep-\d+.*$/, ''); // strip trailing /ep-N
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const animeId = m[2];
    const poster = m[3];
    const name = (m[4] || slug.replace(/-/g, ' ')).trim();
    // Carry animeId in the id when present so meta can skip re-scraping the id.
    out.push({ id: `anime:as:${slug}${animeId ? '~' + animeId : ''}`, type: 'anime', name, poster, posterShape: 'poster' });
  }
  return out;
}

async function anisugeCatalog({ skip = 0, search = '' } = {}) {
  if (search) {
    const j = await getJson(`${AS}/ajax/anime/search?keyword=${encodeURIComponent(search)}`, { headers: AJAX });
    const html = (j && j.result) || (j && j.html) || '';
    return parseAnisugeCards(typeof html === 'string' ? html : '');
  }
  const page = Math.floor(skip / 24) + 1;
  return cache.wrap(`as:cat:${page}`, 10 * 60 * 1000, async () => {
    const html = await getText(`${AS}/filter?page=${page}`);
    let cards = parseAnisugeCards(html);
    if (!cards.length) cards = parseAnisugeCards(await getText(`${AS}/home`));
    return cards;
  });
}

// ---- anime.nexus catalog (JSON, catalog-only) -------------------------------
async function nexusCatalog({ skip = 0 } = {}) {
  const page = Math.floor(skip / 24) + 1;
  return cache.wrap(`nx:cat:${page}`, 10 * 60 * 1000, async () => {
    const j = await getJson(`${NX}/api/anime/discover?page=${page}`, { headers: { Referer: 'https://anime.nexus/' } });
    const data = (j && j.data) || [];
    return data.map((a) => ({
      id: `anime:nx:${a.id}:${a.slug}`,
      type: 'anime',
      name: a.name,
      poster: a.poster || a.image || a.cover,
      description: a.description,
      releaseInfo: a.release_date ? String(a.release_date).slice(0, 4) : undefined,
    }));
  });
}

async function catalog(catId, opts) {
  if (catId === 'anisuge.trending') return anisugeCatalog(opts);
  if (catId === 'animenexus.popular') return nexusCatalog(opts);
  return [];
}

// ---- anisuge meta: episodes -------------------------------------------------
function extractAnimeId(html) {
  return (html.match(/data-id="(\d+)"/) || [])[1];
}

async function anisugeEpisodes(slug, knownAnimeId) {
  return cache.wrap(`as:eps:${slug}`, 15 * 60 * 1000, async () => {
    const page = await getText(`${AS}/watch/${slug}`);
    const animeId = knownAnimeId || extractAnimeId(page);
    const title = (page.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1];
    const poster = (page.match(/<img[^>]+class="[^"]*poster[^"]*"[^>]+src="([^"]+)"/) || [])[1];
    if (!animeId) return { title, poster, episodes: [] };
    const j = await getJson(`${AS}/ajax/episode/list/${animeId}`, { headers: AJAX });
    const frag = (j && j.result) || '';
    const eps = [];
    const re = /data-id="(\d+)"[^>]*(?:data-number="(\d+)")?[^>]*>[\s\S]{0,120}?(?:title="([^"]+)"|>\s*([^<]+?)\s*<)/g;
    let m;
    while ((m = re.exec(frag))) {
      const epId = m[1];
      const num = m[2] || String(eps.length + 1);
      const epTitle = (m[3] || m[4] || `Episode ${num}`).trim();
      eps.push({ id: epId, number: parseInt(num, 10) || eps.length + 1, title: epTitle });
    }
    return { title: title && title.trim(), poster, animeId, episodes: eps };
  });
}

async function meta(id) {
  const [, ns, a, b] = id.split(':');
  if (ns === 'as') {
    const [slug, animeId] = a.split('~');
    const info = await anisugeEpisodes(slug, animeId);
    return {
      id,
      type: 'anime',
      name: info.title || slug.replace(/-/g, ' '),
      poster: info.poster,
      videos: (info.episodes || []).map((e) => ({
        // carry animeId after ~ so streams() can skip the /watch fetch
        id: `anime:as:${slug}~${info.animeId || animeId || ''}:${e.id}`,
        title: e.title,
        episode: e.number,
        season: 1,
      })),
    };
  }
  // anime.nexus: best-effort detail (stream is CF-gated, so catalog/meta only).
  const uuid = a;
  const slug = b;
  const j = await getJson(`${NX}/api/anime/details?id=${uuid}`, { headers: { Referer: 'https://anime.nexus/' } }).catch(() => null);
  const d = (j && j.data) || j || {};
  return {
    id,
    type: 'anime',
    name: d.name || (slug || '').replace(/-/g, ' '),
    poster: d.poster || d.image,
    description: d.description,
  };
}

// ---- anisuge streams: episode blob → server list → embed → m3u8 -------------
// Resolve any AnimeSuge-family embed host (vidtube.site / megaplay.buzz / …) to
// its m3u8. They all expose /stream/getSources?id=<data-id-on-embed-page>.
async function resolveEmbed(embedUrl) {
  try {
    const html = await getText(embedUrl, { headers: { Referer: AS + '/' } });
    const dataId = (html.match(/data-id="([^"]+)"/) || [])[1];
    const host = new URL(embedUrl).origin;
    if (dataId) {
      const j = await getJson(`${host}/stream/getSources?id=${dataId}`, {
        headers: { Referer: embedUrl, 'X-Requested-With': 'XMLHttpRequest' },
      });
      const file =
        (j && j.sources && (j.sources.file || (Array.isArray(j.sources) && j.sources[0] && j.sources[0].file))) ||
        (j && j.file);
      if (file) return { m3u8: file, tracks: (j && j.tracks) || [], host };
    }
    const inline = (html.match(/https?:\/\/[^"'\s]+\.m3u8[^"'\s]*/) || [])[0];
    if (inline) return { m3u8: inline, tracks: [], host };
  } catch (e) { /* fall through */ }
  return null;
}

// Find an episode's encrypted `data-ids` blob (needed by /ajax/server/list) by
// re-reading the anime's episode list and matching the episode's data-id.
async function anisugeEpisodeBlob(slug, episodeId, knownAnimeId) {
  return cache.wrap(`as:blob:${slug}:${episodeId}`, 15 * 60 * 1000, async () => {
    let animeId = knownAnimeId;
    if (!animeId) animeId = extractAnimeId(await getText(`${AS}/watch/${slug}`));
    if (!animeId) return null;
    const j = await getJson(`${AS}/ajax/episode/list/${animeId}`, { headers: AJAX });
    const frag = (j && j.result) || '';
    // Match the <a data-id="episodeId" ... data-ids="blob"> entry.
    const re = new RegExp(`data-id="${episodeId}"[^>]*?data-ids="([^"]+)"`);
    const m = frag.match(re);
    return m ? m[1] : null;
  });
}

// Map a track label to an ISO-639 code Stremio expects.
function subLang(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('english') || l === 'en' || l === 'eng') return 'eng';
  if (l.includes('spanish')) return 'spa';
  if (l.includes('portug')) return 'por';
  if (l.includes('french')) return 'fre';
  if (l.includes('german')) return 'ger';
  if (l.includes('arabic')) return 'ara';
  if (l.includes('italian')) return 'ita';
  return l.slice(0, 3) || 'eng';
}

// Parse the /ajax/server/list fragment into { type, linkId } server rows.
function parseServers(frag) {
  const servers = [];
  // Fragment is split into data-type="sub" / data-type="dub" blocks; each server
  // button carries data-link-id (the token passed to /ajax/server?get=).
  const blockRe = /data-type="(sub|dub)"([\s\S]*?)(?=data-type="(?:sub|dub)"|$)/g;
  let b;
  while ((b = blockRe.exec(frag))) {
    const type = b[1];
    const linkRe = /data-(?:link-)?id="([^"]+)"/g;
    let l;
    while ((l = linkRe.exec(b[2]))) servers.push({ type, linkId: l[1] });
  }
  if (!servers.length) {
    const linkRe = /data-(?:link-)?id="([^"]+)"/g;
    let l;
    while ((l = linkRe.exec(frag))) servers.push({ type: 'sub', linkId: l[1] });
  }
  return servers;
}

// Read the top RESOLUTION from a master m3u8 for a quality label (e.g. "1080p").
async function maxQuality(m3u8, ref) {
  try {
    const txt = await getText(m3u8, { headers: { Referer: ref, Origin: new URL(ref).origin } });
    let best = 0;
    const re = /RESOLUTION=\d+x(\d+)/g;
    let m;
    while ((m = re.exec(txt))) best = Math.max(best, parseInt(m[1], 10));
    return best ? `${best}p` : 'HLS';
  } catch (e) { return 'HLS'; }
}

async function anisugeStreams(slug, episodeId, knownAnimeId, host, label) {
  const out = [];
  const blob = await anisugeEpisodeBlob(slug, episodeId, knownAnimeId);
  if (!blob) return out;
  const sl = await getJson(`${AS}/ajax/server/list?servers=${encodeURIComponent(blob)}`, { headers: AJAX }).catch(() => null);
  const servers = parseServers((sl && sl.result) || '');
  // Resolve at least one server PER type (sub AND dub) so the user can pick.
  const byType = { sub: [], dub: [] };
  for (const sv of servers) (byType[sv.type] || byType.sub).push(sv);
  const seen = new Set();

  const resolveType = async (type) => {
    for (const sv of (byType[type] || []).slice(0, 3)) {
      const r = await getJson(`${AS}/ajax/server?get=${encodeURIComponent(sv.linkId)}`, { headers: AJAX }).catch(() => null);
      const embed = r && r.result && (r.result.url || r.result.link);
      if (!embed) continue;
      const resolved = await resolveEmbed(embed);
      if (resolved && resolved.m3u8 && !seen.has(resolved.m3u8)) {
        seen.add(resolved.m3u8);
        const ref = (resolved.host || AS) + '/';
        const proxied = (u) => (host ? `${host}/proxy?u=${encodeURIComponent(u)}&r=${encodeURIComponent(ref)}` : u);
        const quality = await maxQuality(resolved.m3u8, ref);
        const tag = type === 'dub' ? 'DUB' : 'SUB';
        const stream = {
          url: proxied(resolved.m3u8),
          name: `Couch AIO\nAnisuge ${tag}`,
          // Descriptive title: episode label + quality + audio track.
          title: `${label ? label + '\n' : ''}${quality} · ${tag === 'DUB' ? 'English Dub' : 'Japanese + Subs'}`,
          behaviorHints: { notWebReady: false, bingeGroup: `couch-aio-${slug}-${tag.toLowerCase()}` },
        };
        if (!host) stream.behaviorHints = { notWebReady: true, proxyHeaders: { request: { Referer: ref, Origin: resolved.host || AS } } };
        const subs = (resolved.tracks || [])
          .filter((t) => t && t.file && /\.(vtt|srt|ass)(\?|$)/i.test(t.file) && (t.kind || '').toLowerCase() !== 'thumbnails')
          .map((t, i) => ({ id: `as-${type}-${i}`, url: proxied(t.file), lang: subLang(t.label || t.language) }));
        // English first so players that pick the first track default to English.
        subs.sort((a, b) => (a.lang === 'eng' ? -1 : 0) - (b.lang === 'eng' ? -1 : 0));
        if (subs.length) stream.subtitles = subs;
        return stream;
      }
    }
    return null;
  };

  const [subStream, dubStream] = await Promise.all([resolveType('sub'), resolveType('dub')]);
  if (subStream) out.push(subStream);
  if (dubStream) out.push(dubStream);
  return out;
}

async function streams(id, host) {
  const parts = id.split(':'); // anime:as:<slug>~<animeId>:<episodeId>
  const ns = parts[1];
  if (ns === 'as') {
    const [slug, animeId] = parts[2].split('~');
    const episodeId = parts[3];
    if (!episodeId) return [];
    return anisugeStreams(slug, episodeId, animeId, host);
  }
  return []; // anime.nexus streams are CF-gated; not served in v1.
}

// --- tt / kitsu resolver: the app plays anime from its OWN library, keyed by an
// IMDB (tt) id, not our anime:as: catalog id — so /stream/series/tt…:S:E lands
// here. Resolve tt → title (Cinemeta) → anisuge search → episode → HLS. Returns
// [] when no confident title match, so non-anime tt requests aren't polluted.
function normalizeTitle(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function cinemetaName(type, tt) {
  const j = await getJson(`https://v3-cinemeta.strem.io/meta/${type}/${tt}.json`, {
    headers: { Referer: 'https://www.stremio.com/' },
  }).catch(() => null);
  return j && j.meta && j.meta.name;
}

// Parse the /ajax/anime/search result.html into rich cards carrying every title
// variant (English .name, romaji data-jp, and .subname aliases) so a tt lookup
// can match across languages.
function parseAnisugeSearch(html) {
  const out = [];
  const re = /<a class="item" href="(?:https?:\/\/[^/]+)?\/watch\/([^"?#]+?)"[\s\S]*?data-jp="([^"]*)"[^>]*>([^<]*)<\/div>\s*(?:<div class="subname">([^<]*)<\/div>)?/g;
  let m;
  const seen = new Set();
  while ((m = re.exec(html)) && out.length < 20) {
    const slug = m[1].replace(/\/ep-\d+.*$/, '');
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, jp: m[2] || '', name: (m[3] || '').trim(), subname: m[4] || '' });
  }
  return out;
}

// Word-overlap match — robust to romanization spacing ("Ittekara" vs "Itte
// kara"), punctuation, and English-vs-romaji (one variant will hit). Matches when
// a variant is a substring OR shares ≥60% of the shorter title's significant words.
function titleMatches(target, card) {
  const t = normalizeTitle(target);
  const tWords = new Set(t.split(' ').filter((w) => w.length >= 2));
  const variants = [card.name, card.jp, ...(card.subname || '').split(';')].map(normalizeTitle).filter(Boolean);
  return variants.some((v) => {
    if (v === t || v.includes(t) || t.includes(v)) return true;
    const vWords = new Set(v.split(' ').filter((w) => w.length >= 2));
    if (!vWords.size || !tWords.size) return false;
    let shared = 0;
    for (const w of vWords) if (tWords.has(w)) shared++;
    return shared / Math.min(vWords.size, tWords.size) >= 0.6;
  });
}

async function anisugeSearchCards(keyword) {
  const j = await getJson(`${AS}/ajax/anime/search?keyword=${encodeURIComponent(keyword)}`, { headers: AJAX }).catch(() => null);
  const html = (j && j.result && (j.result.html || j.result)) || '';
  return parseAnisugeSearch(typeof html === 'string' ? html : '');
}

async function imdbStreams(type, tt, season, episode, host) {
  const name = await cinemetaName(type, tt);
  if (!name) return [];
  // anisuge's search chokes on very long/punctuated titles → try the full title,
  // then progressively shorter keyword prefixes (5 then 3 significant words).
  const words = name.replace(/[.,:;!?]/g, ' ').split(/\s+/).filter(Boolean);
  const attempts = [name, words.slice(0, 5).join(' '), words.slice(0, 3).join(' ')];
  let cards = [];
  for (const kw of attempts) {
    cards = await anisugeSearchCards(kw);
    if (cards.some((c) => titleMatches(name, c))) break;
  }
  if (!cards.length) return [];
  // Match Cinemeta's title against any anisuge title variant (EN/romaji/alias).
  const best = cards.find((c) => titleMatches(name, c));
  if (!best) return [];
  const info = await anisugeEpisodes(best.slug);
  const wantEp = type === 'movie' ? 1 : (episode || 1);
  const ep = (info.episodes || []).find((e) => e.number === wantEp) || (info.episodes || [])[wantEp - 1];
  if (!ep) return [];
  const label = type === 'movie' ? name : `${name} · E${wantEp}${ep.title && !/^episode\b/i.test(ep.title) ? ` · ${ep.title}` : ''}`;
  return anisugeStreams(best.slug, ep.id, info.animeId, host, label);
}

module.exports = { CATALOGS, handlesCatalog, catalog, meta, streams, imdbStreams };
