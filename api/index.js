'use strict';
// Vercel serverless entrypoint. vercel.json rewrites all paths here.
const { handleRequest } = require('../lib/addon');
const landing = require('../lib/landing');

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const path = (req.url || '/').split('?')[0];

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (path === '/' || path === '/configure') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = 200;
    return res.end(landing(host));
  }

  const result = await handleRequest(path);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.statusCode = result.status;
  res.end(JSON.stringify(result.json));
};
