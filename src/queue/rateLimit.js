'use strict';

const { LRUCache } = require('lru-cache');

const CACHE_MAX = Number(process.env.QUERY_CACHE_MAX || 2000);

const queryCache = new LRUCache({
  max: CACHE_MAX,
  ttl: 1000 * 60 * 60 * 4,
  updateAgeOnGet: true,
});

const RATE_WINDOW_MS = 1000;
const RATE_LIMIT_PER_WINDOW = 28;

const bucket = {
  windowStart: 0,
  used: 0,
  queue: [],
  drainTimer: null,
};

function now() {
  return Date.now();
}

function scheduleDrain() {
  if (bucket.drainTimer) return;
  bucket.drainTimer = setInterval(() => {
    try {
      if (bucket.queue.length === 0) return;
      const t = now();
      if (t - bucket.windowStart >= RATE_WINDOW_MS) {
        bucket.windowStart = t;
        bucket.used = 0;
      }
      while (bucket.used < RATE_LIMIT_PER_WINDOW && bucket.queue.length > 0) {
        const next = bucket.queue.shift();
        bucket.used += 1;
        Promise.resolve()
          .then(() => next.fn())
          .then((v) => next.resolve(v))
          .catch((e) => next.reject(e));
      }
    } catch (err) {
      console.error('[ratelimit] drain error:', err?.message || err);
    }
  }, 15);
  if (bucket.drainTimer.unref) bucket.drainTimer.unref();
}

function rateLimited(fn) {
  scheduleDrain();
  return new Promise((resolve, reject) => {
    bucket.queue.push({ fn, resolve, reject, ts: now() });
  });
}

module.exports = {
  queryCache,
  rateLimited,
};
