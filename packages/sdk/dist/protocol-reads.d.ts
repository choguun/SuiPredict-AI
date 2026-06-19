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
export declare function asBalance(fields: Record<string, unknown> | null, key: string): bigint;
/** Read `fee_balance` (u64, base units) for a `FeeVault<Q>`. */
export declare function readFeeVaultBalance(client: SuiClient, vaultId: string): Promise<bigint>;
/** Read `admin` (address) for a `FeeVault<Q>`. */
export declare function readFeeVaultAdmin(client: SuiClient, vaultId: string): Promise<string>;
/** Read `balance` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export declare function readPrizePoolBalance(client: SuiClient, poolId: string): Promise<bigint>;
/** Read `current_week` (u64) for a `PrizePool<PrizeCoin>`. */
export declare function readPrizePoolCurrentWeek(client: SuiClient, poolId: string): Promise<bigint>;
/** Read `weekly_prize` (u64, base units) for a `PrizePool<PrizeCoin>`. */
export declare function readPrizePoolWeeklyPrize(client: SuiClient, poolId: string): Promise<bigint>;
/** Read `distribution_bps` (vector<u64>) for a `PrizePool<PrizeCoin>`.
 *  The values are the share of the weekly prize paid to each rank
 *  1..N, summing to 10_000 (1.0). The on-chain default is a
 *  power-law curve (50%, 20%, 10%, 5%, …).
 */
export declare function readPrizePoolDistribution(client: SuiClient, poolId: string): Promise<number[]>;
/** Read `total_balance` (u64, base units) for a `ProtocolVault<QuoteCoin>`.
 *  Includes both the available balance and the market-maker allocated
 *  amount — for the operator's "what's the protocol TVL" view. The
 *  `available_balance` reader is the same minus `allocated`.
 */
export declare function readProtocolVaultTotalBalance(client: SuiClient, vaultId: string): Promise<bigint>;
/** Read `balance` (u64, base units) for a `ProtocolVault<QuoteCoin>` —
 *  the portion NOT allocated to market-making. This is the amount
 *  the deposit/withdraw flow can move.
 */
export declare function readProtocolVaultAvailableBalance(client: SuiClient, vaultId: string): Promise<bigint>;
/** Read `allocated` (u64, base units) for a `ProtocolVault<QuoteCoin>` —
 *  the market-maker allocation. Surfaced on the admin panel so
 *  operators can see how much is locked in MM positions.
 */
export declare function readProtocolVaultAllocated(client: SuiClient, vaultId: string): Promise<bigint>;
/** Read `admin` (address) for a `ProtocolVault<QuoteCoin>` —
 *  the only address allowed to call `allocate_for_mm` /
 *  `return_from_mm`.
 */
export declare function readProtocolVaultAdmin(client: SuiClient, vaultId: string): Promise<string>;
//# sourceMappingURL=protocol-reads.d.ts.map