import type { MarketInfo, OrderBookSnapshot, PortfolioPosition, TradeRecord, VaultSummaryClob } from "./types.js";
export declare function listMarkets(): Promise<MarketInfo[]>;
export declare function getMarket(id: string): Promise<MarketInfo>;
export declare function getMarketOrderBook(id: string): Promise<OrderBookSnapshot>;
/**
 * R32 sweep fix: fetch recent trades for a
 * market. The agents indexer has been
 * recording trades in the `trades` table
 * since the position-indexer landed
 * (round 22), but no SDK helper exposed
 * them — and no UI surface consumed the
 * data. This getter is the SDK side of
 * the new `/markets/<id>/trades` route;
 * the market detail page can use it to
 * render a "Recent trades" panel below
 * the order book. The indexer returns
 * `{ trades: TradeRecord[] }`; we
 * unwrap the envelope here so callers
 * get a plain array. `limit` defaults
 * to 50 and is capped at 200 to match
 * the agents-route cap.
 */
export declare function getMarketTrades(id: string, limit?: number): Promise<TradeRecord[]>;
/**
 * Convert a [price, quantity] tuple from DeepBook's `getLevel2Range`
 * into an OrderBookSnapshot compatible with the rest of the SDK. The
 * `order_id` field is empty since the direct pool read does not
 * return order ids — only price levels and aggregated quantities.
 */
declare function tupleBookToSnapshot(marketId: string, bids: [number, number][], asks: [number, number][]): OrderBookSnapshot;
export declare function getPortfolio(address: string): Promise<PortfolioPosition[]>;
export declare function getVaultSummaryClob(): Promise<VaultSummaryClob>;
export { tupleBookToSnapshot };
//# sourceMappingURL=indexer-client.d.ts.map