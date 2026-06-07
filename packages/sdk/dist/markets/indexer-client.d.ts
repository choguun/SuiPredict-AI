import type { MarketInfo, OrderBookSnapshot, PortfolioPosition, VaultSummaryClob } from "./types.js";
export declare function listMarkets(): Promise<MarketInfo[]>;
export declare function getMarket(id: string): Promise<MarketInfo>;
export declare function getMarketOrderBook(id: string): Promise<OrderBookSnapshot>;
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