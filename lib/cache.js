'use strict';
// Tiny in-memory TTL cache. On serverless (Vercel/Workers) each cold instance
// starts empty and warm instances reuse it — good enough for catalog/stream
// short-term memoization without any external store.
const store = new Map();

function get(key) {
  const e = store.get(key);
  if (!e) return undefined;
  if (Date.now() > e.exp) { store.delete(key); return undefined; }
  return e.val;
}

function set(key, val, ttlMs) {
  store.set(key, { val, exp: Date.now() + ttlMs });
  return val;
}

// memoize an async fn by key
async function wrap(key, ttlMs, fn) {
  const hit = get(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  return set(key, val, ttlMs);
}

module.exports = { get, set, wrap };
