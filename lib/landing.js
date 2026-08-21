'use strict';
// One-click install landing page. Keeps the addon "easy for users": open the URL,
// hit Install, done. Renders a stremio:// deep link + copyable manifest URL.
module.exports = function landing(host) {
  const manifest = `${host}/manifest.json`;
  const deep = `stremio://${host}/manifest.json`;
  const web = `https://web.stremio.com/#/addons?addon=${encodeURIComponent('https://' + manifest)}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Couch AIO — Stremio Addon</title>
<style>
:root{color-scheme:dark}
body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:#0b0d12;color:#e8ebf2;
  display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{max-width:520px;padding:40px;text-align:center}
h1{font-size:28px;margin:0 0 6px;letter-spacing:.5px}
p{color:#9aa3b2;line-height:1.5}
.rows{text-align:left;background:#141821;border-radius:12px;padding:16px 18px;margin:22px 0;font-size:14px}
.rows b{color:#7cc0ff}
a.btn{display:inline-block;background:#3a86ff;color:#fff;text-decoration:none;
  padding:14px 28px;border-radius:10px;font-weight:600;margin:6px}
a.ghost{background:#1c2230;color:#cfe0ff}
code{background:#0f1219;padding:8px 10px;border-radius:8px;display:block;margin-top:14px;
  word-break:break-all;color:#8fd0a0;font-size:12px}
</style></head><body><div class="card">
<h1>Couch AIO</h1>
<p>All-in-one catalog addon — live TV, movies, series & anime, scraped on demand.</p>
<div class="rows">
<div>📺 <b>GlobeTV</b> — free live world TV (YouTube)</div>
<div>🎬 <b>Ramoflix · WMovies</b> — movies & series</div>
<div>🍥 <b>Anisuge · AnimeNexus</b> — anime (sub/dub)</div>
<div style="margin-top:8px;color:#7c8698">Also answers <b>/stream</b> for any IMDB id.</div>
</div>
<a class="btn" href="${deep}">➕ Install in Stremio</a>
<a class="btn ghost" href="${web}" target="_blank">Install via Web</a>
<code>https://${manifest}</code>
<p style="font-size:12px;margin-top:18px;color:#6b7484">Paste the URL above into Stremio → Addons → Install from URL.</p>
</div></body></html>`;
};
