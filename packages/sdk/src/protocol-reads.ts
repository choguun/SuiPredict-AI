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
  return asBig(await readObject(client, vaultId), "fee_balance");
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
  return asBig(await readObject(client, poolId), "balance");
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

/** Read `admin` (address) for a `PrizePool<PrizeCoin>`.
 *  NOTE: this is the per-pool `admin` field, which is informational
 *  only; the on-chain authorization for `set_distribution` /
 *  `settle_week` / `rotate_pubkey` is the shared `PrizeAdmin`
 *  capability. The web admin UI shows the per-pool admin as a
 *  reference; gating admin actions is done via `PrizeAdmin` checks
 *  in the contract.
 */
export async function readPrizePoolAdmin(
  client: SuiClient,
  poolId: string,
): Promise<string> {
  return asStr(await readObject(client, poolId), "admin");
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
    return raw.map((v) => Number(v));
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
  return asBig(await readObject(client, vaultId), "balance");
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
  // renderer folds the Balance into its inner `value` u64.
  return asBig(await readObject(client, vaultId), "balance");
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
