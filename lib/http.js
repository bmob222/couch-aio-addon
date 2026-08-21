'use strict';
// Dependency-free HTTP helpers. All target sites (recon Aug 2026) are behind
// Cloudflare in PASSIVE mode — a normal browser UA gets 200 with full HTML, no
// JS challenge. Keep a browser-like header set so googlevideo/embed CDNs and CF
// don't 403 us.
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 ' +
  '(KHTML, like Gecko) Version/17.5 Safari/605.1.15';

function baseHeaders(extra = {}) {
  return {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    ...extra,
  };
}

// GET a URL, following redirects, returning { status, headers, body, finalUrl }.
function request(rawUrl, opts = {}) {
  const { headers = {}, method = 'GET', body = null, timeout = 12000, maxRedirects = 6, binary = false } = opts;
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (urlStr) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(e); }
      const mod = u.protocol === 'http:' ? http : https;
      const req = mod.request(
        u,
        { method, headers: baseHeaders(headers), timeout },
        (res) => {
          const loc = res.headers.location;
          if (loc && res.statusCode >= 300 && res.statusCode < 400) {
            if (redirects++ >= maxRedirects) return reject(new Error('too many redirects'));
            res.resume();
            return go(new URL(loc, u).toString());
          }
          const chunks = [];
          let stream = res;
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
          stream.on('data', (c) => chunks.push(c));
          stream.on('end', () => {
            const buf = Buffer.concat(chunks);
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: binary ? buf : buf.toString('utf8'),
              finalUrl: u.toString(),
            });
          });
          stream.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    go(rawUrl);
  });
}

async function getText(url, opts) {
  const r = await request(url, opts);
  return r.body;
}

async function getJson(url, opts) {
  const r = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts && opts.headers) } });
  try { return JSON.parse(r.body); } catch (e) { return null; }
}

module.exports = { request, getText, getJson, baseHeaders, UA };
