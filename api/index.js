'use strict';
// Vercel serverless entrypoint. vercel.json rewrites all paths here.
const { handleRequest } = require('../lib/addon');
const landing = require('../lib/landing');
const { handleProxy } = require('../lib/proxy');

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const selfHost = `${proto}://${host}`;
  const url = new URL(req.url || '/', selfHost);
  const path = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (path === '/' || path === '/configure') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    return res.end(landing(host));
  }

  if (path === '/proxy' || path.startsWith('/proxy/')) {
    res.__range = req.headers.range;
    // Node res on Vercel supports writeHead/setHeader/end like http.ServerResponse.
    if (!res.writeHead) res.writeHead = (s) => { res.statusCode = s; };
    return handleProxy(url.searchParams, selfHost, res);
  }

  const result = await handleRequest(path, selfHost);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = result.status;
  res.end(JSON.stringify(result.json));
};
