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
const buckets = new Map();
const DEFAULT_CONFIG = {
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
export function tryConsume(key, config = DEFAULT_CONFIG) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
        b = { tokens: config.capacity, lastRefillMs: now };
        buckets.set(key, b);
    }
    else {
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
    if (b.tokens <= 0) {
        opportunisticSweep();
        return false;
    }
    b.tokens -= 1;
    opportunisticSweep();
    return true;
}
/**
 * Read the current token count for a bucket
 * (without consuming). Useful for the `Retry-After`
 * header on 429 responses.
 */
export function tokensAvailable(key) {
    return buckets.get(key)?.tokens ?? 0;
}
/**
 * Forget all buckets. Used by the test suite.
 */
export function _resetForTests() {
    buckets.clear();
}
/**
 * R51 audit fix: opportunistic sweep of idle buckets.
 * The `buckets` Map is keyed by `(ip|user):route:address`
 * and grows unbounded — a long-running process with many
 * distinct user addresses (e.g. a bot that rotates through
 * fake user IDs to evade the per-user rate limit) would
 * fill memory with one-token-full buckets that never get
 * touched again.
 *
 * Strategy: when the Map exceeds `EVICT_THRESHOLD`, walk
 * the entries and drop any whose `lastRefillMs` is more
 * than `IDLE_MS` ago. A bucket that hasn't been touched
 * in an hour is overwhelmingly likely to be from a
 * different user/IP; the active callers have new buckets
 * by now. The sweep runs in O(n) but only when the Map is
 * already at 80% capacity, so the amortized cost is
 * O(1) per `tryConsume` call. A future Redis-backed
 * limiter would be a strict tightening (TTL on the keys
 * instead of an in-process sweep).
 */
const EVICT_THRESHOLD = 8_000;
const IDLE_MS = 60 * 60 * 1000;
function opportunisticSweep() {
    if (buckets.size < EVICT_THRESHOLD)
        return;
    const cutoff = Date.now() - IDLE_MS;
    for (const [k, b] of buckets) {
        if (b.lastRefillMs < cutoff)
            buckets.delete(k);
    }
}
//# sourceMappingURL=rate-limit.js.map