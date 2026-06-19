import { u64ToSafeNumber } from "./utils.js";
async function readObject(client, objectId) {
    const { object } = await client.core.getObject({
        objectId,
        include: { json: true },
    });
    return object.json ?? null;
}
// Sui's gRPC JSON view renders `Balance<T>` as a struct with a `value`
// field (`{"value": "..."}`), not a scalar. The legacy JSON-RPC
// renderer sometimes returned a raw string. Mirror
// `parlay-client.ts:248-272` which already handles both shapes so
// the same shared object (FeeVault, PrizePool, ProtocolVault) reads
// correctly under either client.
//
// R35 audit fix: previously every reader here assumed the scalar
// shape and threw on the gRPC `{value: "..."}` form, so the admin
// page's "—" fallback hid every shared-object balance and disabled
// the pre-flight checks.
// R57.9 audit fix: re-exported for cross-file use. The R48
// comment claimed the export was "for parlay-client.ts
// reuse" — that's still true, the import is direct
// (`./protocol-reads.js`) and we keep the export. Drop the
// R48 justification comment since the R57 audit found no
// app-level consumer (the barrel re-export through
// `export * from "./protocol-reads.js"` is dead, but the
// direct sibling-file import is live).
export function asBalance(fields, key) {
    if (!fields)
        return 0n;
    const v = fields[key];
    if (typeof v === "string" || typeof v === "number")
        return BigInt(v);
    if (v && typeof v === "object" && "value" in v) {
        const inner = v.value;
        if (inner != null)
            return BigInt(inner);
    }
    return 0n;
}
// R56.8 audit fix: mirror the gRPC `Balance<T>` shape handling
// from `asBalance` (above). A future Move module change that
// makes a field `asBig` reads (e.g. `allocated`, `current_week`)
// into a `Balance<T>` would surface as `{"value": "12345"}` and
// `BigInt({...})` throws "Cannot convert object to primitive
// value". Latent — currently safe because all `asBig` call sites
// read plain u64 fields — but the helper is private and shared
// with future readers.
function asBig(fields, key) {
    if (!fields)
        return 0n;
    const v = fields[key];
    if (typeof v === "string" || typeof v === "number")
        return BigInt(v);
    if (v && typeof v === "object" && "value" in v) {
        const inner = v.value;
        if (inner != null)
            return BigInt(inner);
    }
    return 0n;
}
function asStr(fields, key) {
    if (!fields)
        return "";
    return fields[key] ?? "";
}
/** Read `fee_balance` (u64, base units) for a `FeeVault<Q>`. */
export async function readFeeVaultBalance(client, vaultId) {
    return asBalance(await readObject(client, vaultId), "fee_balance");
}
/** Read `admin` (address) for a `FeeVault<Q>`. */
export async function readFeeVaultAdmin(client, vaultId) {
    return asStr(await readObject(client, vaultId), "admin");
}
/** Read `balance` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolBalance(client, poolId) {
    return asBalance(await readObject(client, poolId), "balance");
}
/** Read `current_week` (u64) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolCurrentWeek(client, poolId) {
    return asBig(await readObject(client, poolId), "current_week");
}
/** Read `weekly_prize` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolWeeklyPrize(client, poolId) {
    return asBig(await readObject(client, poolId), "weekly_prize");
}
/** Read `distribution_bps` (vector<u64>) for a `PrizePool<PrizeCoin>`.
 *  The values are the share of the weekly prize paid to each rank
 *  1..N, summing to 10_000 (1.0). The on-chain default is a
 *  power-law curve (50%, 20%, 10%, 5%, …).
 */
export async function readPrizePoolDistribution(client, poolId) {
    const fields = await readObject(client, poolId);
    if (!fields)
        return [];
    const raw = fields.distribution_bps;
    if (Array.isArray(raw)) {
        // R46 audit fix: route each bps through
        // `u64ToSafeNumber` so a value above 2^53-1
        // logs a warning instead of silently
        // truncating. The current default distribution
        // is a power-law vector in [0, 10_000] so this
        // is dead code in practice, but the public
        // read shouldn't bake in a future schema
        // change that lets an operator set, say, a
        // 1e18-sat-denominated bps on a custom pool.
        return raw.map((v) => u64ToSafeNumber(v, "distribution_bps", poolId));
    }
    return [];
}
/** Read `total_balance` (u64, base units) for a `ProtocolVault<QuoteCoin>`.
 *  Includes both the available balance and the market-maker allocated
 *  amount — for the operator's "what's the protocol TVL" view. The
 *  `available_balance` reader is the same minus `allocated`.
 */
export async function readProtocolVaultTotalBalance(client, vaultId) {
    // R35 audit fix: previously the total reader returned the same
    // value as the available reader (both called `asBig(fields, "balance")`).
    // The on-chain `total_balance` view is `balance::value(&vault.balance) + vault.allocated`
    // (vault.move:144-146), so add the `allocated` u64 to the
    // available-balance read.
    const fields = await readObject(client, vaultId);
    const avail = asBalance(fields, "balance");
    const allocated = asBig(fields, "allocated");
    return avail + allocated;
}
/** Read `balance` (u64, base units) for a `ProtocolVault<QuoteCoin>` —
 *  the portion NOT allocated to market-making. This is the amount
 *  the deposit/withdraw flow can move.
 */
export async function readProtocolVaultAvailableBalance(client, vaultId) {
    // The `ProtocolVault` struct stores `balance: Balance<QuoteCoin>`
    // and `allocated: u64`. The on-chain `available_balance` view
    // function returns `balance::value(&vault.balance)`. Sui's JSON
    // renderer wraps the `Balance<T>` in a `{value: "..."}` struct;
    // `asBalance` above handles both shapes.
    return asBalance(await readObject(client, vaultId), "balance");
}
/** Read `allocated` (u64, base units) for a `ProtocolVault<QuoteCoin>` —
 *  the market-maker allocation. Surfaced on the admin panel so
 *  operators can see how much is locked in MM positions.
 */
export async function readProtocolVaultAllocated(client, vaultId) {
    return asBig(await readObject(client, vaultId), "allocated");
}
/** Read `admin` (address) for a `ProtocolVault<QuoteCoin>` —
 *  the only address allowed to call `allocate_for_mm` /
 *  `return_from_mm`.
 */
export async function readProtocolVaultAdmin(client, vaultId) {
    return asStr(await readObject(client, vaultId), "admin");
}
//# sourceMappingURL=protocol-reads.js.map