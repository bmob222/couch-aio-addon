# Couch AIO — All-in-One Stremio Addon

One addon, many sources — an AIOStreams-style catalog that scrapes on demand.
**Zero dependencies** (Node `http` only), so it runs anywhere: free serverless, a
container host, or your own box.

## What's inside

| Section | Source | Plays as |
|---|---|---|
| **GlobeTV · Live TV** | globetv.app | Native YouTube (`ytId`) — plays everywhere |
| **Ramoflix / WMovies · Movies & TV** | ramoflix.net, wmovies.org | Public embed sources (videasy, moviesapi, soap2night, vidfast, 111movies, vidzee) |
| **Anisuge · Anime** | anisuge.tv | Direct **HLS (m3u8)**, sub + dub, referer-proxied |
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
vercel            # first run links the project
vercel --prod     # deploy
```
`vercel.json` routes everything to the serverless handler. Your manifest is then
`https://<project>.vercel.app/manifest.json`.

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

With `RESOLVER_URL` set, `/stream` for movies/TV returns playable `HLS` streams
(top hosts resolved in parallel, ~3-20s cold, instant cached) plus the remaining
hosts as external embed links. Without it (e.g. serverless deploy), movie streams
fall back to external embed links only. It needs a real box (Mac/mini/NAS) — it
can't run on free serverless.

## Test
```bash
npm test           # live smoke test against every source (14 checks)
```

## How it's built

- `lib/http.js` — dependency-free fetch (gzip/br, redirects, browser UA).
- `lib/addon.js` — manifest + catalog/meta/stream routing over a provider registry.
- `lib/server.js` / `api/index.js` — standalone and Vercel transports (same core).
- `providers/*.js` — one module per source. Add a source = add a provider + a
  catalog row in `lib/addon.js`.

## Notes / limits

- Without the self-hosted resolver, embed-based movie sources open the provider
  page (`externalUrl`). With it, they become directly playable HLS. Anime is
  always direct HLS. VidFast Cloudflare-blocks headless browsers (embed-only).
- Sites change markup; providers are defensive (fallbacks + try/catch) but a
  parser may need a nudge when a site redesigns.
- No affiliation with any listed site. Scrapes public pages only.

## License
MIT
