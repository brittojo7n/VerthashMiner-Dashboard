"use strict";

const MAX_BUCKETS = 128;

function createRateLimiter(max, windowMs, penaltyMs = 0, maxPenaltyMs = 0) {
  const buckets = new Map();
  const sweep = (now) => {
    for (const [key, bucket] of buckets) {
      if (now >= bucket.resetAt) buckets.delete(key);
    }
  };
  return function retryAfterMs(key) {
    const now = Date.now();
    let bucket = buckets.get(key);
    if (bucket && now >= bucket.resetAt) {
      bucket = undefined;
    }
    if (!bucket) {
      if (buckets.size >= MAX_BUCKETS) {
        sweep(now);
        const bktIter = buckets.keys();
        while (buckets.size >= MAX_BUCKETS) buckets.delete(bktIter.next().value);
      }
      bucket = { count: 0, resetAt: now + windowMs, penalised: false, currentPenalty: penaltyMs };
      buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
      if (penaltyMs) {
        if (!bucket.penalised) {
          bucket.penalised = true;
          bucket.resetAt = now + bucket.currentPenalty;
        } else if (maxPenaltyMs > penaltyMs) {
          bucket.currentPenalty = Math.min(maxPenaltyMs, bucket.currentPenalty + 1000);
          bucket.resetAt = now + bucket.currentPenalty;
        }
      }
      return Math.max(1, bucket.resetAt - now);
    }
    bucket.count++;
    return 0;
  };
}

module.exports = { createRateLimiter };
