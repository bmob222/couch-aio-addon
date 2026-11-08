# Couch AIO — All-in-One Stremio Addon

One addon, many sources — an aggregator-style catalog that scrapes on demand.
**Zero dependencies** (Node `http` only), so it runs anywhere: free serverless, a
container host, or your own box.

## What's inside

| Section | Source | Plays as |
|---|---|---|
| **GlobeTV · Live TV** | globetv.app | Native YouTube (`ytId`) — plays everywhere |
| **Ramoflix / WMovies / Doraby · Movies & TV** | ramoflix.net, wmovies.nl, doraby.com | Embed hosts (MoviesAPI, 111Movies, VidZee, Videasy, VidFast) → HLS via the optional resolver |
| **Anisuge · Anime** | anisuge.tv | **HLS**, sub + dub, subtitles as HLS renditions |
| **AnimeNexus · Anime** | anime.nexus | Catalog (streams are Cloudflare-gated) |

It also answers `/stream/movie/tt…` and `/stream/series/tt…:S:E` for **any IMDB id**,
so it works as a plain stream provider even without browsing a catalog.

Browsing a section scrapes that site live; selecting a title resolves its real
stream at request time (short-TTL in-memory cache).

## Install (users)

Open the addon's root URL in a browser and click **Install in Stremio**, or paste
`https://<your-host>/manifest.json` into Stremio → Addons → *Install from URL*.

## Deploy (free hosting)

### Vercel (free, recommended)
```bash
npm i -g vercel
vercel login                                   # token expires — re-login when deploys 401
vercel            # first run links the project
openssl rand -hex 32 | vercel env add PROXY_SECRET production   # REQUIRED, once
vercel --prod     # deploy
```
`vercel.json` routes everything to the serverless handler. Your manifest is then
`https://<project>.vercel.app/manifest.json`.

**`PROXY_SECRET` is required on Vercel** (and any multi-instance host): signed
`/hls` and `/direct` links are verified with it. Without it each instance makes
up its own random secret and links minted by one instance fail on another.

### Render / Railway / Fly / Koyeb (free tiers)
Point the service at this repo. Start command:
```bash
npm start          # node lib/server.js, listens on $PORT (default 7700)
```

### Docker / self-host (e.g. alongside Couch Scraper)
```bash
docker build -t couch-aio . && docker run -p 7700:7700 couch-aio
# or just:
node lib/server.js
```


## How playback works (Nov 2026)

Free-stream CDNs now refuse playback unless the playlist **and every segment**
carry their player page's `Referer`/`Origin`/`User-Agent` (HTTP 400/403
otherwise). Couch AIO never hands clients a raw CDN link:

1. **Resolve-on-play** — stream lists return
   `/direct/<provider>/<payload>/index.m3u8?psig=…`. The provider is resolved
   when the player opens it (cached ~75 s, in-flight deduped), then answered with
   a **307** to the upstream m3u8 if it plays without headers, or to the signed
   playlist proxy below. Lists stay fast and links never go stale in a client's
   stream cache. Links are HMAC-signed (30-day validity).
2. **Playlist proxy** — `/hls/<provider>/playlist/<payload>/index.m3u8?psig=…`
   fetches upstream with the provider's headers and rewrites every URI
   (variants, segments, `EXT-X-MAP`/`KEY`/`MEDIA`/`I-FRAME`) to
   `/hls/<provider>/resource/<payload>/media.<ext>?psig=…` (8 h validity).
3. **Resources** — child playlists are rewritten again; segments/keys/subs are
   **307-redirected** to the CDN when it serves without headers (probed once per
   host, cached 1 h — no bandwidth through the server) and **relayed**
   (streamed, Range-preserving) when it needs headers.
4. **Disguised segments** (`.jpg`/`.png`/extension-less, `image/*`, even a real
   PNG header glued in front of the TS) are exposed as `media.ts`/`.m4s`, always
   relayed, the image prefix stripped and the type corrected to `video/mp2t`, so
   FFmpeg's HLS extension whitelist and format probe accept them.
5. Every stream also carries `behaviorHints.proxyHeaders.request` +
   `notWebReady: true` for clients that can send headers themselves.

Legacy `/proxy?u=…` URLs (cached by clients before this change) still work.

| Env | Default | Meaning |
|---|---|---|
| `PROXY_SECRET` | random per process (warns) | HMAC key for `/hls` + `/direct` links — **set it** |
| `RESOLVER_URL` | — | headless resolver (movies/TV) |
| `RESOLVE_HOSTS` | `3` | embed hosts offered per title |
| `LIST_WAIT_MS` | `4000` | list-time head start; hosts that fail inside it are dropped |
| `DIRECT_CACHE_S` | `75` | play-time resolve cache |
| `HLS_LINK_TTL_S` / `DIRECT_LINK_TTL_S` | 8 h / 30 d | signed link lifetimes |
| `HLS_SEGMENT_MODE` | `auto` | `auto` (probe), `relay` (always proxy), `redirect` |
| `INCLUDE_EMBEDS` | off | also list raw embed pages (`externalUrl`) |

## Movie/TV resolver (optional, self-hosted — makes movies directly playable)

The public embed hosts (MoviesAPI, 111Movies, Videasy, Soap2Night, ...) are
signed-JS players — the real HLS URL only exists after the player script runs.
`resolver/` is a small companion service that drives them in headless Chromium,
sniffs the master `.m3u8` + its Referer, and hands it back to the addon, which
serves it through its referer-injecting `/proxy` as a directly playable stream.

```bash
cd resolver && npm install        # installs Playwright + Chromium
PORT=7799 node server.js          # resolver
# in another shell:
RESOLVER_URL=http://localhost:7799 PORT=7700 node lib/server.js
```

With `RESOLVER_URL` set, `/stream` for movies/TV returns resolve-on-play HLS
rows for the top hosts (resolution starts at list time to warm the cache; a host
that fails within `LIST_WAIT_MS` is dropped). The resolver runs full Chromium in
new-headless mode and also reads m3u8 URLs out of the players' JSON source APIs
(needed for 111Movies, whose player builds a blob: playlist). Without a resolver
(e.g. the Vercel deploy) movie/TV streams are empty unless `INCLUDE_EMBEDS=1`.
It needs a real box (Mac/mini/NAS) — it can't run on free serverless.

## Test
```bash
npm test                                   # offline proxy/signing checks + live sources
OFFLINE=1 npm test                         # offline checks only
RESOLVER_URL=http://localhost:7799 npm test  # also checks movie resolve-on-play
```

## How it's built

- `lib/http.js` — dependency-free fetch (gzip/br, redirects, browser UA).
- `lib/addon.js` — manifest + catalog/meta/stream routing over a provider registry.
- `lib/router.js` — shared HTTP router; `lib/server.js` / `api/index.js` are the
  standalone and Vercel transports.
- `lib/hls.js` — signed playlist proxy (rewrite, redirect-or-relay, disguise fixes).
- `lib/direct.js` — resolve-on-play registry + `/direct` 307 handler.
- `providers/*.js` — one module per source. Add a source = add a provider + a
  catalog row in `lib/addon.js`.

## Notes / limits

- Without the self-hosted resolver there are no movie/TV streams (embed pages
  can be listed with `INCLUDE_EMBEDS=1`). Anime always plays.
- Ramoflix serves a Cloudflare challenge to datacenter IPs (Vercel); its
  catalogs fall back to the identical Doraby catalog there. WMovies moved to
  wmovies.nl (wmovies.cc no longer resolves). VidFast Cloudflare-blocks headless
  browsers; VidZee/Videasy currently yield no stream headlessly.
- Sites change markup; providers are defensive (fallbacks + try/catch) but a
  parser may need a nudge when a site redesigns.
- No affiliation with any listed site. Scrapes public pages only.

## License
MIT
