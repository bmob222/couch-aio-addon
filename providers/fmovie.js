'use strict';
// Generic scraper for "fmovie"-theme WordPress sites (Ramoflix, WMovies).
// Both are SSR HTML with a per-title inline `Servers` (movie) / `Episodes` (TV)
// JS object carrying IMDB `tt` + TMDB ids, and delegate playback to public
// multi-embed hosts (videasy, moviesapi, soap2night, vidfast, 111movies,
// vidzee, cinesrc). We scrape category pages for catalogs and reconstruct the
// embed URLs for streams. Because Stremio also hands us the `tt` id on a
// /stream request, movie/series streams can be built with NO scraping at all.
const { getText } = require('../lib/http');
const cache = require('../lib/cache');
const resolver = require('../lib/resolver');
const { proxUrl } = require('../lib/proxy');

// Per-instance site config.
const SITES = {
  ramoflix: { base: 'https://ramoflix.net', name: 'Ramoflix' },
  wmovies: { base: 'https://wmovies.org', name: 'WMovies' },
  doraby: { base: 'https://doraby.com', name: 'Doraby' },
};

// Embed hosts keyed by IMDB (tt) or TMDB id. `key` picks which id to inject.
// order = display priority. These are the same public providers both sites use.
// Order = resolver priority: hosts verified to yield m3u8 in headless Chromium
// first (MoviesAPI/111Movies/Videasy, Aug 2026); VidFast CF-blocks headless so
// it sits last (still offered as an external embed link).
const EMBEDS = [
  { label: 'MoviesAPI', key: 'imdb', movie: (id) => `https://moviesapi.to/movie/${id}`,                 tv: (id, s, e) => `https://moviesapi.to/tv/${id}-${s}-${e}` },
  { label: '111Movies', key: 'imdb', movie: (id) => `https://111movies.com/movie/${id}`,                tv: (id, s, e) => `https://111movies.com/tv/${id}/${s}/${e}` },
  { label: 'Videasy',   key: 'tmdb', movie: (id) => `https://player.videasy.net/movie/${id}`,          tv: (id, s, e) => `https://player.videasy.net/tv/${id}/${s}/${e}` },
  { label: 'Soap2Night',key: 'imdb', movie: (id) => `https://soap2night.site/embed/movie/${id}`,        tv: (id, s, e) => `https://soap2night.site/embed/tv/${id}/${s}/${e}` },
  { label: 'VidZee',    key: 'imdb', movie: (id) => `https://player.vidzee.wtf/embed/movie/${id}`,      tv: (id, s, e) => `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}` },
  { label: 'VidFast',   key: 'tmdb', movie: (id) => `https://vidfast.pro/movie/${id}`,                  tv: (id, s, e) => `https://vidfast.pro/tv/${id}/${s}/${e}` },
];

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

function parseCatalogItems(html, site) {
  const items = [];
  const re = /<div id="post-(\d+)"[^>]*class="item[^"]*"[\s\S]*?<a href="([^"]+)"[\s\S]*?(<img[^>]*>)[\s\S]*?<div class="meta">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 60) {
    const [, postId, href, imgTag, metaBlock] = m;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (!slug || slug.startsWith('category') || slug.startsWith('genre')) continue;
    const yearM = metaBlock.match(/(19|20)\d{2}/);
    const isTv = /SS\s*\d|EP\s*\d|Series/i.test(metaBlock);
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

async function catalog(siteKey, kind, { skip = 0 } = {}) {
  const site = SITES[siteKey];
  if (!site) return [];
  const page = Math.floor(skip / 20) + 1;
  const path = kind === 'series' ? 'tv-series' : 'movies';
  const url = `${site.base}/category/${path}/${page > 1 ? `page/${page}/` : ''}`;
  return cache.wrap(`${siteKey}:cat:${kind}:${page}`, 10 * 60 * 1000, async () => {
    const html = await getText(url);
    return parseCatalogItems(html, siteKey);
  });
}

// --- title page → { imdb, tmdb, title, poster, isTv } ------------------------
function extractIds(html) {
  // Movie: var Servers = {..."id":"1284041","imdb_id":"tt32268156"...}
  // TV:    var Episodes/Servers = {..."tvid":"95350","tvimdbid":"tt26545992"...}
  const imdb = (html.match(/"(?:imdb_id|tvimdbid)"\s*:\s*"(tt\d+)"/) || [])[1];
  const tmdb = (html.match(/"(?:id|tvid)"\s*:\s*"(\d+)"/) || [])[1];
  const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1];
  // Poster/background for meta: og:image, then the first non-placeholder poster.
  const og = (html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ||
              html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/) || [])[1];
  const posterImg = (html.match(/<img[^>]*class="[^"]*poster[^"]*"[^>]*>/) ||
                     html.match(/class="poster"[\s\S]{0,200}?(<img[^>]*>)/) || [])[0];
  const poster = (og && !/^data:/.test(og) ? og : undefined) || (posterImg && pickPoster(posterImg));
  return { imdb, tmdb, title: title && title.trim(), poster };
}

async function resolveTitle(siteKey, slug) {
  const site = SITES[siteKey];
  return cache.wrap(`${siteKey}:title:${slug}`, 30 * 60 * 1000, async () => {
    const html = await getText(`${site.base}/${slug}/`);
    return extractIds(html);
  });
}

// --- streams: build embed URLs. Works from either a site slug id OR a raw
//     imdb id (Stremio's /stream/movie/tt... request). -------------------------
function embedUrls({ imdb, tmdb }, type, season, episode) {
  const out = [];
  for (const p of EMBEDS) {
    const id = p.key === 'tmdb' ? tmdb : imdb;
    if (!id) continue;
    out.push({ label: p.label, url: type === 'series' ? p.tv(id, season, episode) : p.movie(id) });
  }
  return out;
}

// How many embed hosts to drive through the headless resolver per request.
const RESOLVE_HOSTS = parseInt(process.env.RESOLVE_HOSTS || '3', 10);
// Embed pages can't play inside the Couch app (externalUrl rows always fail
// there), so they're off unless explicitly re-enabled for web/desktop Stremio.
const includeEmbeds = () => process.env.INCLUDE_EMBEDS === '1';

// Top RESOLUTION from a master m3u8 → "1080p" label (mirrors anime.maxQuality).
async function hlsQuality(m3u8, ref) {
  try {
    const txt = await getText(m3u8, { headers: { Referer: ref, Origin: new URL(ref).origin } });
    let best = 0;
    const re = /RESOLUTION=\d+x(\d+)/g;
    let m;
    while ((m = re.exec(txt))) best = Math.max(best, parseInt(m[1], 10));
    return best ? `${best}p` : 'HLS';
  } catch (e) { return 'HLS'; }
}

async function buildEmbedStreams({ imdb, tmdb, contentTitle }, type, season, episode, sourceLabel, host) {
  const epTag = type === 'series' ? ` · S${season}E${episode}` : '';
  const embeds = embedUrls({ imdb, tmdb }, type, season, episode);
  const prefix = contentTitle ? contentTitle + '\n' : '';

  // With a local headless resolver configured, drive the top hosts in parallel
  // and turn captured m3u8s into directly playable streams relayed through our
  // referer-injecting /proxy.
  const playable = [];
  if (resolver.enabled() && host) {
    const targets = embeds.slice(0, RESOLVE_HOSTS);
    const hits = await Promise.all(targets.map((e) => resolver.resolveEmbed(e.url)));
    const qualities = await Promise.all(hits.map((h) => (h ? hlsQuality(h.url, h.referer) : null)));
    targets.forEach((e, i) => {
      const hit = hits[i];
      if (!hit) return;
      playable.push({
        url: proxUrl(host, hit.url, hit.referer),
        name: `Couch AIO\n${e.label}`,
        title: `${prefix}${e.label}${epTag} · ${qualities[i]}`,
        behaviorHints: { notWebReady: false, bingeGroup: `couch-aio-${e.label.toLowerCase()}` },
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
      behaviorHints: { notWebReady: true },
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

async function meta(id) {
  const [siteKey, type, slug] = id.split(':');
  const ids = await resolveTitle(siteKey, slug).catch(() => null);
  const poster = (ids && ids.poster) || posterBySlug.get(`${siteKey}:${slug}`);
  return {
    id,
    type,
    name: decodeEntities((ids && ids.title) || slug.replace(/-/g, ' ')),
    poster,
    background: poster,
  };
}

module.exports = { SITES, catalog, meta, streams, buildEmbedStreams, EMBEDS };
