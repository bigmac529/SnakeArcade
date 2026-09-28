"use strict";
// Small in-memory fixed-window rate limiter. The app runs as one Node process
// behind IIS, so memory is enough; limits reset on restart, which is fine.
function createRateLimiter() {
  const buckets = new Map();

  function sweep(now) {
    if (buckets.size < 5000) {
      return;
    }
    for (const [key, b] of buckets) {
      if (b.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }

  // Returns { ok, retryAfterSeconds }. Counts the attempt when ok.
  function hit(key, limit, windowMs, now = Date.now()) {
    sweep(now);
    let b = buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      buckets.set(key, b);
    }
    if (limit > 0 && b.count >= limit) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) };
    }
    b.count += 1;
    return { ok: true, retryAfterSeconds: 0 };
  }

  function reset(key) {
    buckets.delete(key);
  }

  return { hit, reset, clear: () => buckets.clear() };
}

module.exports = { createRateLimiter };
