/**
 * In-memory nonce store for the wallet-challenge flow on
 * `/prize/signature`.
 *
 * R51 audit fix: the previous `/prize/signature` endpoint
 * accepted any `(user, rank)` and re-derived the leaderboard
 * membership server-side. The remaining gap was that *anyone*
 * who knew a rank-1 user's address could request a signature
 * for them — a script could watch the leaderboard, see that
 * `0xA…` is rank-1 in week 12, and call
 * `GET /prize/signature?user=0xA…&rank=1&week=12` to drain
 * the pool if the user later signed whatever tx the server
 * produced.
 *
 * The fix is a 2-call challenge/response flow:
 *
 *   1. Client calls `GET /prize/signature/challenge?user=:addr`
 *      → server returns `{ nonce, message, expiresAt }` and
 *        records the nonce in this map keyed by `user`.
 *   2. Client signs `message` with the wallet's ed25519 key
 *      (proving they own the private key for `user`) and
 *      POSTs back the nonce + signature + public key.
 *   3. Server verifies the signature, looks up the nonce here
 *      to ensure it was issued, hasn't been consumed, and
 *      hasn't expired, then proceeds with the prize claim
 *      signing.
 *
 * The nonce is single-use; once consumed, it's removed from
 * the map. A 60-second TTL caps the lifetime of an issued
 * nonce (a stale nonce can't be replayed, and a user who
 * took 5 minutes to think about the claim can simply
 * re-request a challenge).
 *
 * Eviction: the map is bounded by `MAX_NONCES = 10_000` and
 * an opportunistic sweep evicts expired entries whenever
 * `lookupOrConsume` or `issueNonce` is called and the map
 * exceeds 50% capacity. The map is in-memory only, so a
 * process restart clears all issued nonces — clients see a
 * 401/403 and re-request, which is the right UX.
 *
 * Cross-replica caveat: same as `rate-limit.ts` — nonces are
 * per-replica. A user who requests a challenge on replica A
 * and submits the signature to replica B will get 403
 * "nonce not found". The honest client handles this by
 * retrying the challenge on the same replica; the rate
 * limiter caps the retry blast. A future Redis-backed
 * store would tighten this.
 */
/**
 * Issue a fresh nonce for `user`. Returns the new nonce,
 * the canonical message the client must sign, and the
 * expiry timestamp. A user can have at most one unconsumed
 * nonce at a time — re-issuing evicts the prior one.
 */
export declare function issueNonce(user: string): {
    nonce: string;
    message: string;
    expiresAtMs: number;
};
/**
 * Verify that `nonce` was issued for `user`, hasn't been
 * consumed, and hasn't expired. On success, mark consumed
 * and return. On failure, return an error code.
 */
export declare function consumeNonce(nonce: string, user: string): {
    ok: true;
} | {
    ok: false;
    reason: "not_found" | "user_mismatch" | "expired" | "already_consumed";
};
/**
 * Forget all issued nonces. Used by the test suite.
 */
export declare function _resetForTests(): void;
//# sourceMappingURL=nonce-store.d.ts.map