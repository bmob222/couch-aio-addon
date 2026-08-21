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

- Embed-based movie sources open the provider page (`externalUrl`); a downstream
  resolver (or the Couch app's) turns them into a direct file. Anime is direct HLS.
- Sites change markup; providers are defensive (fallbacks + try/catch) but a
  parser may need a nudge when a site redesigns.
- No affiliation with any listed site. Scrapes public pages only.

## License
MIT
