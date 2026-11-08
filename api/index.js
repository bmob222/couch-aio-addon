'use strict';
// Vercel serverless entrypoint. vercel.json rewrites all paths here.
// Set PROXY_SECRET in the Vercel project env so signed /hls + /direct links
// verify across cold starts / instances.
const { route } = require('../lib/router');

module.exports = async (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return route(req, res, `${proto}://${host}`);
};
