import { getOraclePriceLatest, getOracleState } from "./predict-server.js";
import { strikeToDollars } from "./constants.js";
export async function getSpotPrice(oracleId) {
    // R54 audit fix: log the underlying error on each failed call.
    // The previous `catch {}` blocks silently swallowed every error;
    // a 2-hour predict-server outage would silently degrade the
    // web's strike-picker to the safest strike (`pickAtmStrike` line
    // 32) without any operator alert. The drift-detector health
    // check would never fire because nothing threw. Log so an
    // operator grepping the agents' stdout can see the cause.
    try {
        const latest = await getOraclePriceLatest(oracleId);
        const spot = latest.spot;
        if (spot != null)
            return spot / 1e9;
    }
    catch (err) {
        console.warn(`[sdk] getSpotPrice(${oracleId}) /latest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
        const state = await getOracleState(oracleId);
        const nested = state;
        const raw = nested.latest_price?.spot ?? nested.spot;
        if (raw != null)
            return raw / 1e9;
    }
    catch (err) {
        console.warn(`[sdk] getSpotPrice(${oracleId}) /state failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return null;
}
export async function pickAtmStrike(oracleId, minStrike, tickSize) {
    const spot = await getSpotPrice(oracleId);
    if (!spot)
        return strikeToDollars(BigInt(minStrike));
    const tickDollars = tickSize / 1e9;
    const rounded = Math.round(spot / tickDollars) * tickDollars;
    return Math.max(rounded, strikeToDollars(BigInt(minStrike)));
}
/**
 * True if `addr` is a syntactically valid Sui address AND is not the
 * `0x0…000` placeholder. Used by the admin / referral-keeper / vault
 * forward paths to skip a tx rather than abort on a non-existent
 * recipient. Sui addresses are case-insensitive; the strict form is
 * `0x` + 64 hex chars.
 */
export function isValidSuiAddress(addr) {
    if (!addr)
        return false;
    const normalized = addr.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(normalized))
        return false;
    // Reject the all-zeros placeholder. The address technically
    // validates, but transferring to it is a guaranteed abort.
    if (/^0x0{64}$/.test(normalized))
        return false;
    return true;
}
/**
 * Normalize a Sui object id to the canonical form: `0x` + 64 lowercase
 * hex chars. Sui's BCS / object resolver is case-insensitive in some
 * paths and case-sensitive in others; the gRPC `ObjectReference` /
 * `Input` form is strict. Wallets and indexers occasionally hand us
 * mixed-case ids (e.g. from display copy/paste or BE-encoded JSON), and
 * passing the raw string into `tx.object()` / `client.getObject()` can
 * fail with `invalid input object` or `object not found`. Trim
 * whitespace, strip an optional leading `0X`, and lower-case.
 *
 * R42 audit fix: builders across the SDK were forwarding raw `marketId`
 * / `poolId` / `vaultId` strings. Adding the helper here and applying
 * it to the public-facing builders (resolve, dispute, redeem, settle,
 * …) gives callers a single place to fix copy-pasted ids.
 *
 * Throws on syntactically invalid input so the build-time error is
 * readable rather than a cryptic move-abort at the wallet.
 */
export function normalizeObjectId(id) {
    if (id == null) {
        throw new Error("normalizeObjectId: id is required");
    }
    const trimmed = id.trim();
    if (!trimmed) {
        throw new Error("normalizeObjectId: id is empty");
    }
    const lowered = trimmed.toLowerCase();
    const stripped = lowered.startsWith("0x") ? lowered : `0x${lowered}`;
    if (!/^0x[0-9a-f]{64}$/.test(stripped)) {
        throw new Error(`normalizeObjectId: "${trimmed}" is not a valid Sui object id ` +
            `(expected 0x + 64 hex chars)`);
    }
    return stripped;
}
/**
 * Convert a u64 BigInt (or string, as the gRPC / indexer
 * sometimes hands us) to a JavaScript number, logging a
 * warning if the value exceeds `Number.MAX_SAFE_INTEGER`
 * (2^53-1). R46 audit fix: the previous `Number(...)` /
 * `parseInt(...)` calls in `streak-client.ts` and
 * `protocol-reads.ts` would silently lose precision above
 * 2^53 before the caller's number-typed field ever saw
 * the value. Today's streak counters and the prize-pool
 * `distribution_bps` vector all fit comfortably below 2^53
 * (a streak counter of 2^53 days is 285 billion years), but
 * `total_participated` / `total_correct` on a long-running
 * `UserStreak` could in principle grow unbounded, and a
 * future `distribution_bps` schema change (e.g. an additional
 * rank entry) is a silent-corruption trap. Centralize the
 * conversion here so the read paths get the same warning the
 * indexer's write path already emits.
 *
 * `fieldName` and `objectId` are used only in the warning
 * message so an operator chasing a "this value looks wrong"
 * report can map the truncated number back to the on-chain
 * object it came from.
 */
export function u64ToSafeNumber(value, fieldName, objectId) {
    const asBig = typeof value === "bigint"
        ? value
        : BigInt(typeof value === "string" ? value : String(value));
    const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
    if (asBig > MAX_SAFE) {
        // eslint-disable-next-line no-console
        console.warn(`[sdk] ${fieldName} for ${objectId} (${asBig}) exceeds ` +
            "Number.MAX_SAFE_INTEGER; truncating. The on-chain field is u64; " +
            "if you need exact precision, surface this as a BigInt and " +
            "render with a custom formatter.");
    }
    return Number(asBig);
}
/**
 * Validate a candidate coin type tag (e.g. DUSDC_TYPE, VLP_TYPE,
 * `<PKG>::dbusdc::DBUSDC`). Rejects empty, non-`0x` prefixed, missing
 * `::module::Struct` separator, or whitespace-padded values. The
 * generic `Q` parameter on the parlay / prize / vault Move modules
 * is type-argument-checked by the BCS encoder; a `typeArguments: [""]`
 * PTB aborts at signature with an opaque "Invalid type argument".
 * Caller-supplied coinType strings that come from env vars
 * (`PARLAY_COIN_TYPE`, `PRIZE_COIN_TYPE`, …) or admin scripts
 * benefit from a single, loud check at builder time.
 *
 * R57.2 audit fix: the seven parlay builders and the
 * `buildClaimPrizeTx` builder used to forward `coinType` to
 * `typeArguments` without any validation. The prize client
 * had a partial check (R54); the parlay siblings were silent.
 * Centralize the rule here.
 */
export function validateCoinType(coinType) {
    if (coinType == null) {
        throw new Error("validateCoinType: coinType is required");
    }
    const trimmed = coinType.trim();
    if (!trimmed) {
        throw new Error("validateCoinType: coinType is empty");
    }
    if (!trimmed.startsWith("0x")) {
        throw new Error(`validateCoinType: "${coinType}" must start with "0x"`);
    }
    if (!trimmed.includes("::")) {
        throw new Error(`validateCoinType: "${coinType}" must include "::module::Struct"`);
    }
    return trimmed;
}
/**
 * Iterate `client.core.listCoins` to exhaustion, returning every
 * Coin<T> object owned by `owner`. The gRPC `listCoins` defaults to
 * 50 objects per page; a wallet with more than 50 dust coins (e.g.
 * after a busy day of redeems) would otherwise see only the first
 * page, and the caller's `total = objects.reduce(...)` would report
 * a balance missing the tail of the page chain.
 *
 * R52 audit fix: the previous callers (`mergeAndSplitDusdc`,
 * `getDusdcBalance`, `getPlpCoins`) took the first page and assumed
 * it was complete. A user with 51+ DUSDC coins was silently told
 * "Insufficient DUSDC" when in fact they had plenty.
 *
 * @param client  SuiGrpcClient (or anything with a `core.listCoins`
 *                method that returns `{ objects, nextCursor? }`)
 * @param owner   Sui address
 * @param coinType  fully-qualified coin type (e.g. DUSDC_TYPE)
 * @param options.pageSize  how many coins to fetch per round-trip
 *                          (default 50, max 1000)
 * @param options.maxPages  safety cap on pagination depth
 *                          (default 20 = 1000 coins; raise for
 *                          pathological wallets)
 */
export async function listAllCoins(client, owner, coinType, options = {}) {
    const { pageSize = 50, maxPages = 20 } = options;
    const all = [];
    let cursor = null;
    for (let page = 0; page < maxPages; page++) {
        const res = await client.core.listCoins({ owner, coinType, limit: pageSize, cursor: cursor ?? undefined });
        all.push(...res.objects);
        cursor = res.nextCursor;
        if (!cursor)
            break;
    }
    return all;
}
//# sourceMappingURL=utils.js.map