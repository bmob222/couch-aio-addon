'use strict';
// GlobeTV (https://globetv.app) — Laravel+Inertia SPA. Every full-page load
// embeds an Inertia `data-page` JSON blob in <div id="app" data-page="...">.
// Channels are live YouTube embeds → we map youtube_video_id to Stremio's
// native `ytId` stream, which the Stremio player resolves itself (so these
// actually play with no extra resolver).
const { getText } = require('../lib/http');
const cache = require('../lib/cache');

const BASE = 'https://globetv.app';
const PREFIX = 'globetv';

// Parse the Inertia data-page JSON out of an HTML page.
function parseInertia(html) {
  const m = html.match(/id="app"[^>]*data-page="([^"]*)"/);
  if (!m) return null;
  const json = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  try { return JSON.parse(json); } catch (e) { return null; }
}

// Fetch one page of the TV channel paginator.
async function fetchTvPage(page = 1) {
  return cache.wrap(`${PREFIX}:tv:${page}`, 10 * 60 * 1000, async () => {
    const html = await getText(`${BASE}/tv?page=${page}`);
    const data = parseInertia(html);
    const channels = data?.props?.channels?.data || [];
    return channels;
  });
}

// Stremio catalog: skip is 0-based, page size 24 upstream.
async function catalog({ skip = 0, search = '' } = {}) {
  const page = Math.floor(skip / 24) + 1;
  let channels = await fetchTvPage(page);
  if (search) {
    const q = search.toLowerCase();
    // search scans the first few pages (upstream has no search param).
    const extra = await Promise.all([1, 2, 3].map((p) => fetchTvPage(p)));
    channels = extra.flat().filter((c) => (c.name || '').toLowerCase().includes(q));
  }
  return channels
    .filter((c) => c.youtube_video_id)
    .map((c) => ({
      id: `${PREFIX}:${c.id}:${c.youtube_video_id}`,
      type: 'tv',
      name: c.name,
      poster: c.logo_url || `https://i.ytimg.com/vi/${c.youtube_video_id}/hqdefault.jpg`,
      posterShape: 'landscape',
      description: c.description || `Live channel · ${c.name}`,
    }));
}

// meta for a channel id (globetv:<id>:<ytid>)
async function meta(id) {
  const [, , ytid] = id.split(':');
  const name = id; // we don't re-fetch; name is set at catalog time
  return {
    id,
    type: 'tv',
    name: name,
    poster: `https://i.ytimg.com/vi/${ytid}/hqdefault.jpg`,
    posterShape: 'landscape',
    background: `https://i.ytimg.com/vi/${ytid}/maxresdefault.jpg`,
  };
}

// stream: native ytId (Stremio player plays YouTube live directly).
async function streams(id) {
  const [, , ytid] = id.split(':');
  if (!ytid) return [];
  return [{ ytId: ytid, title: 'GlobeTV · Live (YouTube)' }];
}

module.exports = { PREFIX, catalog, meta, streams };
