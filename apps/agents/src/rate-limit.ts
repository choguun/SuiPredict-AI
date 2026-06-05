/**
 * Per-process in-memory token-bucket rate limiter.
 *
 * R50 audit fix: `/prize/signature` and `POST /prize/claims`
 * were unmetered. Each call performs an on-chain
 * `getObjects` RPC read + ed25519 sign (or a SQLite
 * write), so a bot could saturate the public RPC, blow
 * the SDK's rate limiter, or spam the SQLite write
 * lock. The on-chain `claimed[user]` map prevents
 * double-payout but CPU/IO is still spent.
 *
 * Strategy: per-`(ip, route)` + per-`(user, route)`
 * token buckets. The user bucket is the stricter of
 * the two (a single user shouldn't be able to claim
 * 1000 sigs/min even from different IPs). Buckets
 * refills at a steady rate; over-budget requests
 * return 429.
 *
 * The limiter is intentionally in-memory. Across
 * multiple Railway replicas the global cap is
 * multiplied by replica count — the on-chain
 * invariants (the `claimed[user]` map) are still
 * respected, so the worst case is "more CPU spent",
 * not "double payout". A future Redis-backed
 * limiter would be a strict tightening.
 */

interface Bucket {
  tokens: number;
  // Epoch ms of the last refill.
  lastRefillMs: number;
}

interface LimitConfig {
  // Maximum tokens a bucket can hold (the burst).
  capacity: number;
  // Tokens added per minute.
  refillPerMinute: number;
}

const buckets = new Map<string, Bucket>();

const DEFAULT_CONFIG: LimitConfig = {
  capacity: 5,
  refillPerMinute: 5,
};

/**
 * Try to take a single token from the bucket
 * identified by `key`. Returns `true` if the
 * caller is under the limit and the token was
 * consumed; `false` if the request should be
 * rejected with 429.
 */
export function tryConsume(
  key: string,
  config: LimitConfig = DEFAULT_CONFIG,
): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: config.capacity, lastRefillMs: now };
    buckets.set(key, b);
  } else {
    // Refill: how many whole minutes since the
    // last refill? Multiply by the per-minute rate
    // (fractional tokens are floored so the bucket
    // can never exceed `capacity`).
    const minutes = (now - b.lastRefillMs) / 60_000;
    const refilled = Math.floor(minutes * config.refillPerMinute);
    if (refilled > 0) {
      b.tokens = Math.min(config.capacity, b.tokens + refilled);
      b.lastRefillMs = now;
    }
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

/**
 * Read the current token count for a bucket
 * (without consuming). Useful for the `Retry-After`
 * header on 429 responses.
 */
export function tokensAvailable(key: string): number {
  return buckets.get(key)?.tokens ?? 0;
}

/**
 * Forget all buckets. Used by the test suite.
 */
export function _resetForTests(): void {
  buckets.clear();
}
