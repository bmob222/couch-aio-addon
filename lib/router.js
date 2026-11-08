'use strict';
// Transport-agnostic HTTP router shared by lib/server.js (standalone) and
// api/index.js (Vercel). Routes:
//   /, /configure                → install landing page
//   /hls/<provider>/…            → signed HLS playlist proxy (lib/hls.js)
//   /direct/<provider>/…         → resolve-on-play 307 (lib/direct.js)
//   /proxy, /proxy/*             → legacy unsigned relay (back-compat for
//                                   stream URLs cached by clients pre-Nov 2026)
//   everything else              → Stremio addon JSON (lib/addon.js)
const { handleRequest } = require('./addon');
const landing = require('./landing');
const { handleProxy } = require('./proxy');
const { handleHls } = require('./hls');
const { handleDirect } = require('./direct');

async function route(req, res, selfHost) {
  const url = new URL(req.url || '/', selfHost);
  const path = url.pathname;
  if (process.env.ACCESS_LOG) console.log(`[req] ${req.method} ${(req.url || '').slice(0, 160)}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  try {
    if (path === '/' || path === '/configure') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.statusCode = 200;
      return res.end(landing(new URL(selfHost).host));
    }
    if (path.startsWith('/hls/')) return await handleHls(req, res, url, selfHost);
    if (path.startsWith('/direct/')) return await handleDirect(req, res, url, selfHost);
    if (path === '/proxy' || path.startsWith('/proxy/')) {
      res.__range = req.headers.range;
      if (!res.writeHead) res.writeHead = (s) => { res.statusCode = s; };
      return await handleProxy(url.searchParams, selfHost, res);
    }
    const result = await handleRequest(path, selfHost);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.statusCode = result.status;
    return res.end(JSON.stringify(result.json));
  } catch (e) {
    if (res.headersSent) return res.destroy();
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify({ error: String((e && e.message) || e) }));
  }
}

module.exports = { route };
