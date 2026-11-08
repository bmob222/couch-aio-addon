'use strict';
// Generic scraper for "fmovie"-theme WordPress sites (Ramoflix, WMovies).
// Both are SSR HTML with a per-title inline `Servers` (movie) / `Episodes` (TV)
// JS object carrying IMDB `tt` + TMDB ids, and delegate playback to public
// multi-embed hosts (videasy, moviesapi, soap2night, vidfast, 111movies,
// vidzee, cinesrc). We scrape category pages for catalogs and reconstruct the
// embed URLs for streams. Because Stremio also hands us the `tt` id on a
// /stream request, movie/series streams can be built with NO scraping at all.
const { request, getJson, UA } = require('../lib/http');
const cache = require('../lib/cache');
const resolver = require('../lib/resolver');
const direct = require('../lib/direct');
const hls = require('../lib/hls');

// Per-instance site config. `bases` are tried in order (domains move: WMovies
// went .org → .nl, .cc is dead). `mirrors` = sister sites with the same
// catalog, used when every base is unreachable — Ramoflix sits behind a
// Cloudflare managed challenge for datacenter IPs (Vercel gets "Just a
// moment…" 403), so the cloud deploy serves its rows from Doraby instead.
const SITES = {
  ramoflix: { bases: ['https://ramoflix.net'], name: 'Ramoflix', mirrors: ['doraby'] },
  wmovies: { bases: ['https://wmovies.nl', 'https://wmovies.org'], name: 'WMovies', mirrors: ['doraby'] },
  doraby: { bases: ['https://doraby.com'], name: 'Doraby', mirrors: [] },
};
for (const s of Object.values(SITES)) s.base = s.bases[0];

// Cloudflare interstitial / hard block (vs. CF's passive JS beacon, which
// every normal page carries).
function isBlocked(r) {
  const body = typeof r.body === 'string' ? r.body.slice(0, 4000) : '';
  return r.status === 403 || r.status === 503 || r.status === 429 ||
    /<title>\s*(Just a moment|Attention Required|Access denied)/i.test(body);
}

// GET <site>/<path> trying each base; remembers the base that worked.
// → { body, base } | null when every base is blocked/unreachable.
async function siteGet(siteKey, path) {
  const site = SITES[siteKey];
  const order = [site.base, ...site.bases.filter((b) => b !== site.base)];
  for (const base of order) {
    try {
      const r = await request(`${base}${path}`);
      if (isBlocked(r) || r.status >= 400) continue;
      // A domain move that drops the path lands on the new home page.
      const finalBase = new URL(r.finalUrl).origin;
      if (finalBase !== base && path !== '/' && new URL(r.finalUrl).pathname === '/') continue;
      site.base = base;
      return { body: r.body, base };
    } catch (e) { /* next base */ }
  }
  return null;
}

// Embed hosts keyed by IMDB (tt) or TMDB id. `key` picks which id to inject.
// Order = resolver priority (verified Nov 2026 in headless Chromium):
//  - MoviesAPI (→ vidspark) and 111Movies (moved .com → .net → vidmario player)
//    resolve reliably; both CDNs are Referer/Origin-gated (403 without).
//  - VidZee / Videasy currently yield no m3u8 headlessly; VidFast
//    Cloudflare-blocks headless. Kept as fallbacks/embeds.
//  - Soap2Night removed (domain no longer resolves).
// `referer` = the header the CDN usually wants, advertised as proxyHeaders
// before a play-time resolve has told us the exact one. `reliable` hosts are
// listed even while their resolve is still running; others must resolve
// within the list-time window to be shown.
const EMBEDS = [
  { label: 'MoviesAPI', key: 'imdb', reliable: true, referer: 'https://cdn.vidspark.to/',     movie: (id) => `https://moviesapi.to/movie/${id}`,          tv: (id, s, e) => `https://moviesapi.to/tv/${id}-${s}-${e}` },
  { label: '111Movies', key: 'imdb', reliable: true, referer: 'https://player.vidmario.net/', movie: (id) => `https://111movies.net/movie/${id}`,         tv: (id, s, e) => `https://111movies.net/tv/${id}/${s}/${e}` },
  { label: 'VidZee',    key: 'imdb', referer: 'https://player.vidzee.wtf/',   movie: (id) => `https://player.vidzee.wtf/embed/movie/${id}`, tv: (id, s, e) => `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}` },
  { label: 'Videasy',   key: 'tmdb', referer: 'https://player.videasy.to/',   movie: (id) => `https://player.videasy.to/movie/${id}`,     tv: (id, s, e) => `https://player.videasy.to/tv/${id}/${s}/${e}` },
  { label: 'VidFast',   key: 'tmdb', referer: 'https://vidfast.pro/',         movie: (id) => `https://vidfast.pro/movie/${id}`,           tv: (id, s, e) => `https://vidfast.pro/tv/${id}/${s}/${e}` },
];
const providerKey = (label) => label.toLowerCase().replace(/[^a-z0-9]/g, '');

// Play-time resolvers for /direct/<provider>/… (payload { e: embedUrl }).
for (const p of EMBEDS) {
  direct.register(providerKey(p.label), async (payload) => {
    if (!payload || !/^https:\/\//.test(payload.e || '')) return null;
    const hit = await resolver.resolveEmbed(payload.e);
    return hit ? { url: hit.url, headers: hit.headers } : null;
  });
}

// --- catalog: scrape a category page -----------------------------------------
// Decode the handful of HTML entities WP emits in titles (&#8217; etc.).
function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// The real poster lives in the img's `data-src` (lazyload); `src` is a 1x1
// webp placeholder. Prefer data-src, fall back to a non-data src.
function pickPoster(imgTag) {
  const ds = (imgTag.match(/data-src="([^"]+)"/) || [])[1];
  if (ds && !/^data:/.test(ds)) return ds;
  const s = (imgTag.match(/\ssrc="([^"]+)"/) || [])[1];
  return s && !/^data:/.test(s) ? s : undefined;
}

// slug → poster, filled while parsing catalogs (the poster only appears in the
// listing, not the title page), so meta for a browsed item can reuse it.
const posterBySlug = new Map();

function parseCatalogItems(html, site, kind) {
  const items = [];
  const re = /<div id="post-(\d+)"[^>]*class="item[^"]*"[\s\S]*?<a href="([^"]+)"[\s\S]*?(<img[^>]*>)[\s\S]*?<div class="meta">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 60) {
    const [, postId, href, imgTag, metaBlock] = m;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (!slug || slug.startsWith('category') || slug.startsWith('genre')) continue;
    const yearM = metaBlock.match(/(19|20)\d{2}/);
    // The catalog kind is authoritative (we fetched /category/tv-series or
    // /movies); fall back to markup heuristics only when kind is unknown.
    const isTv = kind === 'series' ? true : kind === 'movie' ? false
      : /SS\s*\d|EP\s*\d|Series/i.test(metaBlock);
    // Prefer the img alt (clean title), then the meta anchor text, then slug.
    const altM = imgTag.match(/alt="([^"]+)"/);
    const anchorM = metaBlock.match(/<a[^>]*>([^<]+)<\/a>/);
    const name = decodeEntities((altM && altM[1]) || (anchorM && anchorM[1]) || slug.replace(/-/g, ' '));
    const poster = pickPoster(imgTag);
    if (poster) posterBySlug.set(`${site}:${slug}`, poster);
    items.push({
      id: `${site}:${isTv ? 'series' : 'movie'}:${slug}`,
      type: isTv ? 'series' : 'movie',
      name: name.trim(),
      poster,
      year: yearM ? yearM[0] : undefined,
    });
  }
  return items;
}

async function catalog(siteKey, kind, { skip = 0 } = {}, viaMirror = false) {
  const site = SITES[siteKey];
  if (!site) return [];
  const page = Math.floor(skip / 20) + 1;
  const path = kind === 'series' ? 'tv-series' : 'movies';
  const items = await cache.wrap(`${siteKey}:cat:${kind}:${page}`, 10 * 60 * 1000, async () => {
    const got = await siteGet(siteKey, `/category/${path}/${page > 1 ? `page/${page}/` : ''}`);
    return got ? parseCatalogItems(got.body, siteKey, kind) : [];
  }).catch(() => []);
  if (items.length || viaMirror) return items;
  // Blocked/empty → serve the sister site's identical catalog (its own ids, so
  // meta/streams resolve against the reachable mirror).
  for (const m of site.mirrors || []) {
    const alt = await catalog(m, kind, { skip }, true);
    if (alt.length) {
      console.warn(`[couch-aio] ${siteKey} unreachable from this host — catalog served from mirror ${m}`);
      return alt;
    }
  }
  return [];
}

// --- title page → { imdb, tmdb, title, poster, isTv } ------------------------
function extractIds(html) {
  // Movie: var Servers = {..."id":"1284041","imdb_id":"tt32268156"...}
  // TV:    var Episodes/Servers = {..."tvid":"95350","tvimdbid":"tt26545992"...}
  const imdb = (html.match(/"(?:imdb_id|tvimdbid)"\s*:\s*"(tt\d+)"/) || [])[1];
  const tmdb = (html.match(/"(?:id|tvid)"\s*:\s*"(\d+)"/) || [])[1];
  const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1];
  // TV pages expose the site's TMDB key + tv id — used to enumerate episodes.
  const tvid = (html.match(/"tvid"\s*:\s*"(\d+)"/) || [])[1];
  const tvapikey = (html.match(/"tvapikey"\s*:\s*"([0-9a-f]{32})"/) || [])[1];
  // Poster/background for meta: og:image, then the first non-placeholder poster.
  const og = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ||
              html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/) || [])[1];
  const posterImg = (html.match(/<img[^>]*class="[^"]*poster[^"]*"[^>]*>/) ||
                     html.match(/class="poster"[\s\S]{0,200}?(<img[^>]*>)/) || [])[0];
  const poster = (og && !/^data:/.test(og) ? og : undefined) || (posterImg && pickPoster(posterImg));
  return { imdb, tmdb, title: title && title.trim(), poster, tvid, tvapikey };
}

async function resolveTitle(siteKey, slug) {
  const site = SITES[siteKey];
  return cache.wrap(`${siteKey}:title:${slug}`, 30 * 60 * 1000, async () => {
    let got = await siteGet(siteKey, `/${slug}/`);
    // Same WP slugs on the mirror network → try mirrors when blocked.
    for (const m of site.mirrors || []) {
      if (got) break;
      got = await siteGet(m, `/${slug}/`);
    }
    if (!got) throw new Error(`${siteKey}: title page unreachable`);
    return extractIds(got.body);
  });
}

// --- streams: build embed URLs. Works from either a site slug id OR a raw
//     imdb id (Stremio's /stream/movie/tt... request). -------------------------
function embedUrls({ imdb, tmdb }, type, season, episode) {
  const out = [];
  for (const p of EMBEDS) {
    const id = p.key === 'tmdb' ? tmdb : imdb;
    if (!id) continue;
    out.push({ label: p.label, referer: p.referer, reliable: !!p.reliable, url: type === 'series' ? p.tv(id, season, episode) : p.movie(id) });
  }
  return out;
}

// How many embed hosts to offer (each resolves at PLAY time via /direct).
const RESOLVE_HOSTS = parseInt(process.env.RESOLVE_HOSTS || '3', 10);
// List-time head start: hosts that definitively FAIL within this window are
// dropped; hosts still resolving are listed anyway (resolve-on-play finishes
// the job, and the warm cache makes the click instant).
const LIST_WAIT_MS = parseInt(process.env.LIST_WAIT_MS || '4000', 10);
// Embed pages can't play inside the Couch app (externalUrl rows always fail
// there), so they're off unless explicitly re-enabled for web/desktop Stremio.
const includeEmbeds = () => process.env.INCLUDE_EMBEDS === '1';

// Top RESOLUTION from a master m3u8 → "1080p" label (mirrors anime.maxQuality).
async function hlsQuality(m3u8, headers) {
  try {
    const r = await request(m3u8, { headers: { ...headers }, timeout: 4000 });
    let best = 0;
    const re = /RESOLUTION=\d+x(\d+)/g;
    let m;
    while ((m = re.exec(String(r.body)))) best = Math.max(best, parseInt(m[1], 10));
    return best ? `${best}p` : 'HLS';
  } catch (e) { return 'HLS'; }
}

const PENDING = Symbol('pending');
function settleWithin(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r(PENDING), ms))]);
}

function defaultHeaders(p) {
  return { Referer: p.referer, Origin: new URL(p.referer).origin, 'User-Agent': UA };
}

async function buildEmbedStreams({ imdb, tmdb, contentTitle }, type, season, episode, sourceLabel, host) {
  const epTag = type === 'series' ? ` · S${season}E${episode}` : '';
  const embeds = embedUrls({ imdb, tmdb }, type, season, episode);
  const prefix = contentTitle ? contentTitle + '\n' : '';

  // Resolve-on-play: each stream is a signed /direct URL that drives the
  // headless resolver when the player opens it. We start resolving now (warms
  // the cache) and only wait LIST_WAIT_MS to weed out hosts that fail fast.
  const playable = [];
  if (resolver.enabled() && host) {
    const targets = embeds.slice(0, RESOLVE_HOSTS);
    const outcomes = await Promise.all(targets.map((e) =>
      settleWithin(direct.resolve(providerKey(e.label), hls.enc({ e: e.url })), LIST_WAIT_MS)));
    const qualities = await Promise.all(outcomes.map((o) =>
      (o && o !== PENDING ? hlsQuality(o.url, o.headers) : 'HLS')));
    targets.forEach((e, i) => {
      const o = outcomes[i];
      if (o === null) return; // definitively failed
      if (o === PENDING && !e.reliable) return; // flaky host still spinning — don't advertise
      const headers = o !== PENDING && o.headers ? o.headers : defaultHeaders(e);
      playable.push({
        url: direct.directUrl(host, providerKey(e.label), { e: e.url }),
        name: `Couch AIO\n${e.label}`,
        title: `${prefix}${e.label}${epTag} · ${qualities[i]}`,
        behaviorHints: {
          notWebReady: true,
          bingeGroup: `couch-aio-${providerKey(e.label)}`,
          proxyHeaders: { request: headers },
        },
      });
    });
  }
  if (!includeEmbeds()) return playable;

  const external = embeds
    .filter((e) => !playable.some((p) => p.title.includes(e.label)))
    .map((e) => ({
      externalUrl: e.url,
      name: 'Couch AIO',
      title: `${prefix}${e.label}${epTag} · Embed (opens externally)`,
      behaviorHints: { notWebReady: true, proxyHeaders: { request: defaultHeaders(e) } },
    }));
  return [...playable, ...external];
}

// From a Stremio stream id. Two shapes:
//  - `<site>:<type>:<slug>`         → scrape title page for ids
//  - `tt1234567` / `tt1234567:1:2`  → build embeds straight from imdb id
async function streams(id, host) {
  if (id.startsWith('tt')) {
    const [imdb, s, e] = id.split(':');
    const type = s ? 'series' : 'movie';
    return buildEmbedStreams({ imdb, tmdb: null }, type, s, e, 'Embed', host);
  }
  const [siteKey, type, slug, s, e] = id.split(':');
  const ids = await resolveTitle(siteKey, slug);
  if (!ids || (!ids.imdb && !ids.tmdb)) return [];
  return buildEmbedStreams({ ...ids, contentTitle: ids.title }, type, s || 1, e || 1, SITES[siteKey]?.name, host);
}

// Enumerate a series' episodes from TMDB using the tv id + api key the fmovie
// title page embeds. Returns Stremio `videos` [{id, season, episode, ...}] with
// ids shaped `<site>:series:<slug>:<S>:<E>` so streams() can build embeds.
async function seriesVideos(siteKey, slug, tvid, apiKey) {
  if (!tvid || !apiKey) return [];
  return cache.wrap(`${siteKey}:eps:${slug}`, 6 * 60 * 60 * 1000, async () => {
    const base = 'https://api.themoviedb.org/3/tv/';
    const show = await getJson(`${base}${tvid}?api_key=${apiKey}&language=en-US`).catch(() => null);
    if (!show || !Array.isArray(show.seasons)) return [];
    // Skip specials (season 0) unless it's the only season.
    const seasonNums = show.seasons
      .map((s) => s.season_number)
      .filter((n) => Number.isInteger(n) && n > 0);
    const nums = seasonNums.length ? seasonNums : [0];
    const videos = [];
    for (const n of nums) {
      const sd = await getJson(`${base}${tvid}/season/${n}?api_key=${apiKey}&language=en-US`).catch(() => null);
      for (const ep of (sd && sd.episodes) || []) {
        const S = ep.season_number, E = ep.episode_number;
        if (!Number.isInteger(S) || !Number.isInteger(E)) continue;
        videos.push({
          id: `${siteKey}:series:${slug}:${S}:${E}`,
          title: ep.name || `Episode ${E}`,
          season: S,
          episode: E,
          released: ep.air_date ? `${ep.air_date}T00:00:00.000Z` : undefined,
          thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : undefined,
          overview: ep.overview || undefined,
        });
      }
    }
    return videos;
  });
}

async function meta(id) {
  const [siteKey, type, slug] = id.split(':');
  const ids = await resolveTitle(siteKey, slug).catch(() => null);
  const poster = (ids && ids.poster) || posterBySlug.get(`${siteKey}:${slug}`);
  const m = {
    id,
    type,
    name: decodeEntities((ids && ids.title) || slug.replace(/-/g, ' ')),
    poster,
    background: poster,
  };
  if (type === 'series' && ids) {
    m.videos = await seriesVideos(siteKey, slug, ids.tvid || ids.tmdb, ids.tvapikey).catch(() => []);
  }
  return m;
}

module.exports = { SITES, catalog, meta, streams, buildEmbedStreams, EMBEDS };
