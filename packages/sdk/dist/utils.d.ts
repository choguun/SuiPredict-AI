export declare function getSpotPrice(oracleId: string): Promise<number | null>;
export declare function pickAtmStrike(oracleId: string, minStrike: number, tickSize: number): Promise<number>;
/**
 * True if `addr` is a syntactically valid Sui address AND is not the
 * `0x0…000` placeholder. Used by the admin / referral-keeper / vault
 * forward paths to skip a tx rather than abort on a non-existent
 * recipient. Sui addresses are case-insensitive; the strict form is
 * `0x` + 64 hex chars.
 */
export declare function isValidSuiAddress(addr: string | null | undefined): boolean;
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
export declare function normalizeObjectId(id: string | null | undefined): string;
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
export declare function u64ToSafeNumber(value: bigint | string | number, fieldName: string, objectId: string): number;
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
export declare function validateCoinType(coinType: string | null | undefined): string;
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
export declare function listAllCoins<T extends {
    core: {
        listCoins: (args: {
            owner: string;
            coinType: string;
            limit?: number;
            cursor?: string | null;
        }) => Promise<{
            objects: any[];
            nextCursor?: string | null;
        }>;
    };
}>(client: T, owner: string, coinType: string, options?: {
    pageSize?: number;
    maxPages?: number;
}): Promise<any[]>;
//# sourceMappingURL=utils.d.ts.map