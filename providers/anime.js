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

async function anisugeStreams(slug, episodeId, knownAnimeId) {
  const out = [];
  const blob = await anisugeEpisodeBlob(slug, episodeId, knownAnimeId);
  if (!blob) return out;
  const sl = await getJson(`${AS}/ajax/server/list?servers=${encodeURIComponent(blob)}`, { headers: AJAX }).catch(() => null);
  const servers = parseServers((sl && sl.result) || '');
  // Resolve up to 3 servers; de-dupe m3u8s.
  const seen = new Set();
  for (const sv of servers.slice(0, 5)) {
    const r = await getJson(`${AS}/ajax/server?get=${encodeURIComponent(sv.linkId)}`, { headers: AJAX }).catch(() => null);
    const embed = r && r.result && (r.result.url || r.result.link);
    if (!embed) continue;
    const resolved = await resolveEmbed(embed);
    if (resolved && resolved.m3u8 && !seen.has(resolved.m3u8)) {
      seen.add(resolved.m3u8);
      // The m3u8 CDN is referer-gated to the EMBED host (e.g. vidtube.site),
      // not to anisuge — attach proxyHeaders so the Stremio player sends the
      // right Referer/Origin. notWebReady:true tells Stremio to proxy them.
      const ref = (resolved.host || AS) + '/';
      out.push({
        url: resolved.m3u8,
        name: `Anisuge · ${sv.type.toUpperCase()}`,
        title: 'HLS',
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: { request: { Referer: ref, Origin: resolved.host || AS } },
        },
      });
    } else if (!resolved) {
      out.push({ externalUrl: embed, name: `Anisuge · ${sv.type.toUpperCase()}`, title: 'embed', behaviorHints: { notWebReady: true } });
    }
    if (out.length >= 4) break;
  }
  return out;
}

async function streams(id) {
  const parts = id.split(':'); // anime:as:<slug>:<episodeId>
  const ns = parts[1];
  if (ns === 'as') {
    const [slug, animeId] = parts[2].split('~');
    const episodeId = parts[3];
    if (!episodeId) return [];
    return anisugeStreams(slug, episodeId, animeId);
  }
  return []; // anime.nexus streams are CF-gated; not served in v1.
}

module.exports = { CATALOGS, handlesCatalog, catalog, meta, streams };
