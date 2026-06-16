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
import { randomBytes } from "node:crypto";
const NONCE_TTL_MS = 60_000;
const MAX_NONCES = 10_000;
/**
 * Evict expired entries whenever the map exceeds this fraction
 * of `MAX_NONCES`. Set well below 1 so a flood of issues
 * doesn't get interspersed with constant sweep pauses.
 */
const EVICT_THRESHOLD_RATIO = 0.5;
const issuedNonces = new Map();
/**
 * Map `user` → `nonce` so we can also look up by user
 * (for the rate limit + debug).
 *
 * R52 audit fix: also store the
 * `user` on the `IssuedNonce` row so
 * the `opportunisticSweep` can clean
 * up the reverse map. The previous
 * shape left stale entries in
 * `userToNonce` after a sweep, and a
 * bot that hammers
 * `/prize/signature/challenge` with
 * random user addresses grew the
 * reverse map unboundedly — a slow
 * OOM over weeks of uptime.
 */
const userToNonce = new Map();
/**
 * Issue a fresh nonce for `user`. Returns the new nonce,
 * the canonical message the client must sign, and the
 * expiry timestamp. A user can have at most one unconsumed
 * nonce at a time — re-issuing evicts the prior one.
 */
export function issueNonce(user) {
    // Evict the prior unconsumed nonce for this user, if any,
    // to prevent nonce-stuffing. The eviction is best-effort:
    // if the prior nonce was already consumed we leave its row
    // alone and let TTL handle it.
    const prior = userToNonce.get(user);
    if (prior) {
        const row = issuedNonces.get(prior);
        if (row && !row.consumed) {
            issuedNonces.delete(prior);
        }
        userToNonce.delete(user);
    }
    const nonce = randomBytes(32).toString("hex");
    const issuedAtMs = Date.now();
    issuedNonces.set(nonce, { nonce, issuedAtMs, consumed: false });
    userToNonce.set(user, nonce);
    // Canonical message: keep it ASCII-printable so signing
    // libraries that default to UTF-8 don't choke on weird
    // bytes. The nonce is the binding token; the user field
    // prevents a stolen nonce from being used against a
    // different address.
    const message = `SuiPredict Prize Claim\nnonce: ${nonce}\nuser: ${user}`;
    opportunisticSweep();
    return {
        nonce,
        message,
        expiresAtMs: issuedAtMs + NONCE_TTL_MS,
    };
}
/**
 * Verify that `nonce` was issued for `user`, hasn't been
 * consumed, and hasn't expired. On success, mark consumed
 * and return. On failure, return an error code.
 */
export function consumeNonce(nonce, user) {
    const row = issuedNonces.get(nonce);
    if (!row)
        return { ok: false, reason: "not_found" };
    if (row.consumed)
        return { ok: false, reason: "already_consumed" };
    // Bind the nonce to the address that was used to issue it.
    // The user↔nonce map is the source of truth for binding.
    const bound = userToNonce.get(user);
    if (bound !== nonce)
        return { ok: false, reason: "user_mismatch" };
    if (Date.now() - row.issuedAtMs > NONCE_TTL_MS) {
        issuedNonces.delete(nonce);
        userToNonce.delete(user);
        return { ok: false, reason: "expired" };
    }
    // Consume: mark + delete so the same nonce can't be used
    // twice even if the request handler crashes mid-sign.
    row.consumed = true;
    issuedNonces.delete(nonce);
    userToNonce.delete(user);
    return { ok: true };
}
/**
 * Forget all issued nonces. Used by the test suite.
 */
export function _resetForTests() {
    issuedNonces.clear();
    userToNonce.clear();
}
function opportunisticSweep() {
    if (issuedNonces.size < MAX_NONCES * EVICT_THRESHOLD_RATIO)
        return;
    const cutoff = Date.now() - NONCE_TTL_MS;
    // R52 audit fix: build a set of
    // the nonces that are about to be
    // evicted, then walk `userToNonce`
    // and drop any entry whose value
    // is in the set. Without this the
    // reverse map grew unboundedly as
    // a bot issued challenges for
    // random addresses — a slow OOM
    // over weeks of uptime.
    const evicting = [];
    for (const [k, v] of issuedNonces) {
        if (v.issuedAtMs < cutoff) {
            evicting.push(k);
            issuedNonces.delete(k);
        }
    }
    if (evicting.length === 0)
        return;
    const evictSet = new Set(evicting);
    for (const [u, n] of userToNonce) {
        if (evictSet.has(n))
            userToNonce.delete(u);
    }
}
//# sourceMappingURL=nonce-store.js.map