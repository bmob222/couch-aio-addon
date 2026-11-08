'use strict';
// Standalone HTTP server (for Render/Railway/Fly/self-host or `npm start`).
// Dependency-free — Node http only, same style as the Couch emby-bridge.
const http = require('http');
const { route } = require('./router');

const PORT = parseInt(process.env.PORT || '7700', 10);

const server = http.createServer((req, res) => {
  // Behind a reverse proxy (Docker/Render/Fly) honour the forwarded scheme/host
  // so signed /hls and /direct links point back at the public URL.
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  route(req, res, `${proto}://${host}`);
});

server.listen(PORT, () => {
  console.log(`[couch-aio] listening on :${PORT}  (manifest: http://localhost:${PORT}/manifest.json)`);
});

module.exports = server;
