'use strict';
// Standalone HTTP server (for Render/Railway/Fly/self-host or `npm start`).
// Dependency-free — Node http only, same style as the Couch emby-bridge.
const http = require('http');
const { handleRequest } = require('./addon');
const landing = require('./landing');

const PORT = parseInt(process.env.PORT || '7700', 10);

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }

  // Landing / install page
  if (path === '/' || path === '/configure') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.writeHead(200);
    return res.end(landing(req.headers.host));
  }

  const result = await handleRequest(path);
  cors(res);
  res.writeHead(result.status);
  res.end(JSON.stringify(result.json));
});

server.listen(PORT, () => {
  console.log(`[couch-aio] listening on :${PORT}  (manifest: http://localhost:${PORT}/manifest.json)`);
});

module.exports = server;
