import Database from "better-sqlite3";
import type { MarketInfo, OrderBookSnapshot, PortfolioPosition, TradeRecord } from "@suipredict/sdk";
export declare function closeDb(): void;
export declare function getDb(): Database.Database;
/** Append a vault activity row. Used by the position-indexer. */
export declare function recordVaultFlow(flow: {
    vault_id: string;
    kind: "created" | "deposit" | "withdraw" | "allocate" | "deallocate";
    actor?: string;
    amount?: number;
    vlp_delta?: number;
    total_allocated?: number;
    ts_ms: number;
}): void;
export interface VaultFlow {
    id: number;
    vault_id: string;
    kind: "created" | "deposit" | "withdraw" | "allocate" | "deallocate";
    actor: string | null;
    amount: number;
    vlp_delta: number;
    total_allocated: number | null;
    ts_ms: number;
}
/** Recent vault flows, newest first. */
export declare function listVaultFlows(vaultId?: string, limit?: number): VaultFlow[];
/** Idempotent insert of a RegistryCreated event. */
export declare function recordRegistry(row: {
    id: string;
    admin: string;
    ts_ms: number;
}): void;
/** Idempotent insert of a MarketRegistered event. */
export declare function recordRegisteredMarket(row: {
    market_id: string;
    market_index: number;
    ts_ms: number;
}): void;
export interface RegisteredMarketRow {
    market_id: string;
    market_index: number;
    ts_ms: number;
}
export declare function listRegisteredMarkets(limit?: number): RegisteredMarketRow[];
export declare function getRegistry(): {
    id: string;
    admin: string;
    ts_ms: number;
} | null;
export declare function upsertMarket(market: MarketInfo): void;
export declare function listMarkets(): MarketInfo[];
export declare function getMarket(id: string): MarketInfo | null;
export declare function markMarketResolved(marketId: string, outcome: "yes" | "no"): void;
export declare function patchMarketReferralId(marketId: string, referralId: string): void;
export declare function markMarketDisputed(marketId: string, evidenceUri: string, disputeCount: number, timestampMs: number): void;
export declare function markMarketUndisputed(marketId: string, finalOutcome: "yes" | "no"): void;
export declare function upsertOrder(order: {
    market_id: string;
    order_id: number;
    owner: string;
    is_bid: boolean;
    price_bps: number;
    quantity: number;
    filled?: number;
    timestamp_ms: number;
}): void;
/**
 * R56 audit fix: per-market monotonic `order_id` for the demo
 * path, backed by the `demo_order_counters` table. The previous
 * in-process `Map` (R47) was cleared on every redeploy, so the
 * next tick re-seeded from `Date.now()` and could collide with
 * a previously-written `order_id` (a fast Railway redeploy keeps
 * `Date.now()` the same or smaller), flipping a cancelled row
 * back to `filled=0` via the `ON CONFLICT` clause in
 * `upsertOrder`. Atomic UPSERT inside a transaction so two MM
 * ticks racing across replicas (if the agents service is ever
 * horizontally scaled) cannot both read the same `next_id`.
 *
 * The `MAX(order_id)+1` seed is a safety net for the case where
 * a row was written directly to `demo_orders` (bypassing this
 * helper, e.g. by a future migration script) and the counter
 * table is empty. The `RETURNING next_id` returns the new
 * value for the caller's next bid/ask pair.
 */
export declare function nextDemoOrderId(marketId: string): number;
export declare function recordTrade(trade: Omit<TradeRecord, "market_id"> & {
    market_id: string;
}): void;
export declare function getOrderBook(marketId: string): OrderBookSnapshot;
export declare function getTrades(marketId: string, limit?: number): TradeRecord[];
export declare function upsertPosition(marketId: string, address: string, yes: number, no: number): void;
export declare function decrementPosition(marketId: string, address: string, side: "yes" | "no", amount: number): void;
export declare function getPosition(marketId: string, address: string): {
    yes: number;
    no: number;
} | null;
export declare function getPortfolio(address: string): PortfolioPosition[];
export declare function getVaultSummaryFromEnv(): {
    vault_id: string;
    total_balance: number;
    allocated: number;
    available: number;
};
export declare function recordChainOrder(o: {
    market_id: string;
    order_id: string;
    pool_id: string;
    client_order_id: string;
    is_bid: boolean;
    price: number;
    quantity: number;
    timestamp_ms: number;
}): void;
export declare function recordSettlement(s: {
    market_id: string;
    pool_id: string;
    trader: string;
    timestamp_ms: number;
}): void;
/**
 * Mark a chain order as cancelled. Idempotent: a second call for the
 * same `(market_id, order_id)` is a no-op. Required by the UI's
 * "open orders" view, which otherwise keeps a cancelled row visible
 * until the next page load.
 */
export declare function markOrderCancelled(marketId: string, orderId: string, timestampMs: number): void;
export declare function listChainOrders(marketId: string, limit?: number): Array<{
    market_id: string;
    order_id: string;
    pool_id: string;
    client_order_id: string;
    is_bid: boolean;
    price: number;
    quantity: number;
    timestamp_ms: number;
}>;
//# sourceMappingURL=store.d.ts.map