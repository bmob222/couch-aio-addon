'use strict';
// Core Stremio addon: manifest + catalog/meta/stream routing over a provider
// registry. Transport-agnostic — lib/server.js (standalone) and api/index.js
// (Vercel) both just call handleRequest(path).
const globetv = require('../providers/globetv');
const fmovie = require('../providers/fmovie');
const anime = require('../providers/anime');

const VERSION = '0.1.0';

// Catalogs surfaced on the Discover board. Each maps to a provider call.
const CATALOGS = [
  { type: 'tv',     id: 'globetv.live',    name: 'GlobeTV · Live TV',  extra: [{ name: 'search' }, { name: 'skip' }] },
  { type: 'movie',  id: 'ramoflix.movies', name: 'Ramoflix · Movies',  extra: [{ name: 'skip' }] },
  { type: 'series', id: 'ramoflix.series', name: 'Ramoflix · TV',      extra: [{ name: 'skip' }] },
  { type: 'movie',  id: 'wmovies.movies',  name: 'WMovies · Movies',   extra: [{ name: 'skip' }] },
  { type: 'series', id: 'wmovies.series',  name: 'WMovies · TV',       extra: [{ name: 'skip' }] },
  ...anime.CATALOGS,
];

function manifest() {
  return {
    id: 'org.couch.aio',
    version: VERSION,
    name: 'Couch AIO',
    description:
      'All-in-one catalog addon: GlobeTV live TV, Ramoflix & WMovies (movies/TV), ' +
      'and anime (anisuge / anime.nexus). Browse a section and it scrapes the ' +
      'source on demand. Also answers /stream for any IMDB id with public embed sources.',
    logo: 'https://globetv.app/favicon.ico',
    resources: ['catalog', 'meta', 'stream'],
    types: ['movie', 'series', 'tv', 'anime'],
    idPrefixes: ['tt', 'globetv:', 'ramoflix:', 'wmovies:', 'anime:'],
    catalogs: CATALOGS.map((c) => ({ type: c.type, id: c.id, name: c.name, extra: c.extra })),
    behaviorHints: { configurable: false, adult: false },
  };
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const part of decodeURIComponent(str).split('&')) {
    const [k, v] = part.split('=');
    if (k) out[k] = v;
  }
  return out;
}

async function doCatalog(type, id, extraStr) {
  const extra = parseExtra(extraStr);
  const skip = parseInt(extra.skip || '0', 10) || 0;
  const search = extra.search || '';
  let metas = [];
  if (id === 'globetv.live') metas = await globetv.catalog({ skip, search });
  else if (id === 'ramoflix.movies') metas = await fmovie.catalog('ramoflix', 'movie', { skip });
  else if (id === 'ramoflix.series') metas = await fmovie.catalog('ramoflix', 'series', { skip });
  else if (id === 'wmovies.movies') metas = await fmovie.catalog('wmovies', 'movie', { skip });
  else if (id === 'wmovies.series') metas = await fmovie.catalog('wmovies', 'series', { skip });
  else if (anime.handlesCatalog(id)) metas = await anime.catalog(id, { skip, search });
  return { metas };
}

async function doMeta(type, id) {
  if (id.startsWith('globetv:')) return { meta: await globetv.meta(id) };
  if (id.startsWith('ramoflix:') || id.startsWith('wmovies:')) return { meta: await fmovie.meta(id) };
  if (id.startsWith('anime:')) return { meta: await anime.meta(id) };
  return { meta: null };
}

async function doStream(type, id) {
  if (id.startsWith('globetv:')) return { streams: await globetv.streams(id) };
  if (id.startsWith('ramoflix:') || id.startsWith('wmovies:')) return { streams: await fmovie.streams(id) };
  if (id.startsWith('anime:')) return { streams: await anime.streams(id) };
  if (id.startsWith('tt')) return { streams: await fmovie.streams(id) };
  return { streams: [] };
}

async function handleRequest(pathname) {
  const clean = pathname.replace(/^\/+/, '').replace(/\.json$/, '');
  const parts = clean.split('/').filter(Boolean);

  if (parts.length === 0 || parts[0] === 'manifest') return { status: 200, json: manifest() };

  const [resource, type, rest] = parts;
  const id = decodeURIComponent(rest || '');

  try {
    if (resource === 'catalog') {
      const extraStr = parts.slice(3).join('/');
      return { status: 200, json: await doCatalog(type, id, extraStr) };
    }
    if (resource === 'meta') return { status: 200, json: await doMeta(type, id) };
    if (resource === 'stream') return { status: 200, json: await doStream(type, id) };
  } catch (e) {
    return { status: 200, json: { metas: [], streams: [], meta: null, err: String(e && e.message) } };
  }
  return { status: 404, json: { err: 'not found' } };
}

module.exports = { manifest, handleRequest, VERSION };
