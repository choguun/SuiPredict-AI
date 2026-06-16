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
interface LimitConfig {
    capacity: number;
    refillPerMinute: number;
}
/**
 * Try to take a single token from the bucket
 * identified by `key`. Returns `true` if the
 * caller is under the limit and the token was
 * consumed; `false` if the request should be
 * rejected with 429.
 */
export declare function tryConsume(key: string, config?: LimitConfig): boolean;
/**
 * Read the current token count for a bucket
 * (without consuming). Useful for the `Retry-After`
 * header on 429 responses.
 */
export declare function tokensAvailable(key: string): number;
/**
 * Forget all buckets. Used by the test suite.
 */
export declare function _resetForTests(): void;
export {};
//# sourceMappingURL=rate-limit.d.ts.map