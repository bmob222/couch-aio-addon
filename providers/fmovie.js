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

// Per-instance site config.
const SITES = {
  ramoflix: { base: 'https://ramoflix.net', name: 'Ramoflix' },
  wmovies: { base: 'https://wmovies.org', name: 'WMovies' },
};

// Embed hosts keyed by IMDB (tt) or TMDB id. `key` picks which id to inject.
// order = display priority. These are the same public providers both sites use.
const EMBEDS = [
  { label: 'Videasy',   key: 'tmdb', movie: (id) => `https://player.videasy.net/movie/${id}`,          tv: (id, s, e) => `https://player.videasy.net/tv/${id}/${s}/${e}` },
  { label: 'VidFast',   key: 'tmdb', movie: (id) => `https://vidfast.pro/movie/${id}`,                  tv: (id, s, e) => `https://vidfast.pro/tv/${id}/${s}/${e}` },
  { label: 'MoviesAPI', key: 'imdb', movie: (id) => `https://moviesapi.to/movie/${id}`,                 tv: (id, s, e) => `https://moviesapi.to/tv/${id}-${s}-${e}` },
  { label: 'Soap2Night',key: 'imdb', movie: (id) => `https://soap2night.site/embed/movie/${id}`,        tv: (id, s, e) => `https://soap2night.site/embed/tv/${id}/${s}/${e}` },
  { label: '111Movies', key: 'imdb', movie: (id) => `https://111movies.com/movie/${id}`,                tv: (id, s, e) => `https://111movies.com/tv/${id}/${s}/${e}` },
  { label: 'VidZee',    key: 'imdb', movie: (id) => `https://player.vidzee.wtf/embed/movie/${id}`,      tv: (id, s, e) => `https://player.vidzee.wtf/embed/tv/${id}/${s}/${e}` },
];

// --- catalog: scrape a category page -----------------------------------------
function parseCatalogItems(html, site) {
  const items = [];
  const re = /<div id="post-(\d+)"[^>]*class="item[^"]*"[\s\S]*?<a href="([^"]+)"[\s\S]*?(?:data-src|src)="([^"]+)"[\s\S]*?<div class="meta">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) && items.length < 60) {
    const [, postId, href, poster, metaBlock] = m;
    const slug = href.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
    if (!slug || slug.startsWith('category') || slug.startsWith('genre')) continue;
    const yearM = metaBlock.match(/(19|20)\d{2}/);
    const isTv = /SS\s*\d|EP\s*\d|Series/i.test(metaBlock);
    const nameM = html.slice(m.index).match(/<h\d[^>]*>([^<]+)<\/h\d>/) || href.match(/\/([^/]+)\/?$/);
    items.push({
      id: `${site}:${isTv ? 'series' : 'movie'}:${slug}`,
      type: isTv ? 'series' : 'movie',
      name: (nameM && nameM[1] ? nameM[1] : slug.replace(/-/g, ' ')).trim(),
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
  return { imdb, tmdb, title: title && title.trim() };
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
function buildEmbedStreams({ imdb, tmdb, contentTitle }, type, season, episode, sourceLabel) {
  const out = [];
  const epTag = type === 'series' ? ` · S${season}E${episode}` : '';
  for (const p of EMBEDS) {
    const id = p.key === 'tmdb' ? tmdb : imdb;
    if (!id) continue;
    const url = type === 'series' ? p.tv(id, season, episode) : p.movie(id);
    out.push({
      // externalUrl: opens the embed page in a browser. These hosts are signed-JS
      // players (no direct file), so they're offered as external links, labeled by
      // host so the user can pick one — a headless resolver would be needed to turn
      // them into an in-app stream.
      externalUrl: url,
      name: 'Couch AIO',
      title: `${contentTitle ? contentTitle + '\n' : ''}${p.label}${epTag} · Embed (opens externally)`,
      behaviorHints: { notWebReady: true },
    });
  }
  return out;
}

// From a Stremio stream id. Two shapes:
//  - `<site>:<type>:<slug>`         → scrape title page for ids
//  - `tt1234567` / `tt1234567:1:2`  → build embeds straight from imdb id
async function streams(id) {
  if (id.startsWith('tt')) {
    const [imdb, s, e] = id.split(':');
    const type = s ? 'series' : 'movie';
    return buildEmbedStreams({ imdb, tmdb: null }, type, s, e, 'Embed');
  }
  const [siteKey, type, slug, s, e] = id.split(':');
  const ids = await resolveTitle(siteKey, slug);
  if (!ids || (!ids.imdb && !ids.tmdb)) return [];
  return buildEmbedStreams({ ...ids, contentTitle: ids.title }, type, s || 1, e || 1, SITES[siteKey]?.name);
}

async function meta(id) {
  const [siteKey, type, slug] = id.split(':');
  const ids = await resolveTitle(siteKey, slug).catch(() => null);
  return {
    id,
    type,
    name: (ids && ids.title) || slug.replace(/-/g, ' '),
    poster: undefined,
  };
}

module.exports = { SITES, catalog, meta, streams, buildEmbedStreams, EMBEDS };
