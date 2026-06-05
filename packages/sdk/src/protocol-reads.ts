/**
 * Read functions for protocol-level shared objects.
 *
 * These wrap the public view functions on `FeeVault<Q>`,
 * `PrizePool<PrizeCoin>`, and `ProtocolVault<QuoteCoin>` so the web
 * admin UI and any off-chain monitor can surface live state without
 * parsing raw BCS. The functions mirror the `readParlayPoolBalance`
 * family in `parlay-client.ts`.
 *
 * All functions return safe defaults (`0n`, `""`, `[]`) when the
 * object is missing or the network call fails — the admin UI uses
 * these to drive pre-flight checks (e.g. disabling "Withdraw 1k
 * DUSDC" when the live vault balance is only 0.5k) and a transient
 * RPC failure shouldn't crash the page.
 */
import type { SuiClient } from "./predict-client.js";
import { u64ToSafeNumber } from "./utils.js";

async function readObject(
  client: SuiClient,
  objectId: string,
): Promise<Record<string, unknown> | null> {
  const { object } = await client.core.getObject({
    objectId,
    include: { json: true },
  });
  return (object.json as Record<string, unknown> | null) ?? null;
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
// R48 audit fix: exported so `parlay-client.ts:readParlayPoolBalance`
// can reuse the gRPC + legacy JSON-RPC dual-shape parser. The parlay
// helper was checking only the legacy `fields.value` shape and
// silently returning 0n on the modern gRPC `{value: "..."}` form,
// which made the pre-flight pool-balance check lie post gRPC
// migration.
export function asBalance(
  fields: Record<string, unknown> | null,
  key: string,
): bigint {
  if (!fields) return 0n;
  const v = fields[key];
  if (typeof v === "string" || typeof v === "number") return BigInt(v);
  if (v && typeof v === "object" && "value" in v) {
    const inner = (v as { value?: string | number }).value;
    if (inner != null) return BigInt(inner);
  }
  return 0n;
}

function asBig(fields: Record<string, unknown> | null, key: string): bigint {
  if (!fields) return 0n;
  return BigInt((fields[key] as string | number | undefined) ?? 0);
}

function asStr(fields: Record<string, unknown> | null, key: string): string {
  if (!fields) return "";
  return (fields[key] as string | undefined) ?? "";
}

/** Read `fee_balance` (u64, base units) for a `FeeVault<Q>`. */
export async function readFeeVaultBalance(
  client: SuiClient,
  vaultId: string,
): Promise<bigint> {
  return asBalance(await readObject(client, vaultId), "fee_balance");
}

/** Read `admin` (address) for a `FeeVault<Q>`. */
export async function readFeeVaultAdmin(
  client: SuiClient,
  vaultId: string,
): Promise<string> {
  return asStr(await readObject(client, vaultId), "admin");
}

/** Read `balance` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolBalance(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  return asBalance(await readObject(client, poolId), "balance");
}

/** Read `current_week` (u64) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolCurrentWeek(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  return asBig(await readObject(client, poolId), "current_week");
}

/** Read `weekly_prize` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export async function readPrizePoolWeeklyPrize(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  return asBig(await readObject(client, poolId), "weekly_prize");
}

/** Read `distribution_bps` (vector<u64>) for a `PrizePool<PrizeCoin>`.
 *  The values are the share of the weekly prize paid to each rank
 *  1..N, summing to 10_000 (1.0). The on-chain default is a
 *  power-law curve (50%, 20%, 10%, 5%, …).
 */
export async function readPrizePoolDistribution(
  client: SuiClient,
  poolId: string,
): Promise<number[]> {
  const fields = await readObject(client, poolId);
  if (!fields) return [];
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
export async function readProtocolVaultTotalBalance(
  client: SuiClient,
  vaultId: string,
): Promise<bigint> {
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
export async function readProtocolVaultAvailableBalance(
  client: SuiClient,
  vaultId: string,
): Promise<bigint> {
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
export async function readProtocolVaultAllocated(
  client: SuiClient,
  vaultId: string,
): Promise<bigint> {
  return asBig(await readObject(client, vaultId), "allocated");
}

/** Read `admin` (address) for a `ProtocolVault<QuoteCoin>` —
 *  the only address allowed to call `allocate_for_mm` /
 *  `return_from_mm`.
 */
export async function readProtocolVaultAdmin(
  client: SuiClient,
  vaultId: string,
): Promise<string> {
  return asStr(await readObject(client, vaultId), "admin");
}
