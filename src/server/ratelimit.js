"use strict";

const MAX_BUCKETS = 128;

function createRateLimiter(max, windowMs, penaltyMs = 0) {
  const buckets = new Map();
  const sweep = now => {
    for (const [key, bucket] of buckets) { if (now >= bucket.resetAt) buckets.delete(key); }
  };
  return function retryAfterMs(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      if (!bucket && buckets.size >= MAX_BUCKETS) {
        sweep(now);
        while (buckets.size >= MAX_BUCKETS) buckets.delete(buckets.keys().next().value);
      }
      bucket = { count: 0, resetAt: now + windowMs, penalised: false };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      if (penaltyMs && !bucket.penalised) {
        bucket.penalised = true;
        bucket.resetAt = now + penaltyMs;
      }
      return Math.max(1, bucket.resetAt - now);
    }
    bucket.count++;
    return 0;
  };
}

module.exports = { createRateLimiter };
