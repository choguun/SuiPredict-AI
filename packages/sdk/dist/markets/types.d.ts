export interface MarketInfo {
    id: string;
    title: string;
    description: string;
    category: string;
    expiry_ms: number;
    resolution_source: string;
    status: "active" | "resolved" | "cancelled" | "disputed";
    outcome?: "yes" | "no" | null;
    pool_id?: string | null;
    order_book_id?: string | null;
    deepbook_pool_key?: string | null;
    deepbook_pool_id?: string | null;
    deepbook_base_coin_type?: string | null;
    deepbook_quote_coin_type?: string | null;
    deepbook_base_scalar?: number | null;
    deepbook_quote_scalar?: number | null;
    /** DeepBook referral ID for claiming trading fee rebates */
    referral_id?: string | null;
    created_at_ms?: number;
    disputed?: boolean;
    dispute_count?: number;
    dispute_evidence_uri?: string | null;
    last_dispute_at_ms?: number | null;
}
export interface OrderBookLevel {
    price: number;
    price_bps: number;
    quantity: number;
    order_id?: string;
}
export interface OrderBookSnapshot {
    market_id: string;
    bids: OrderBookLevel[];
    asks: OrderBookLevel[];
    spread_bps: number;
    mid_price: number;
}
export interface TradeRecord {
    market_id: string;
    order_id: string;
    price_bps: number;
    quantity: number;
    is_bid: boolean;
    timestamp_ms: number;
}
export interface PortfolioPosition {
    market_id: string;
    title: string;
    yes: number;
    no: number;
    status: string;
    outcome?: string | null;
}
export interface VaultSummaryClob {
    vault_id: string;
    total_balance: string;
    allocated: string;
    available: string;
}
//# sourceMappingURL=types.d.ts.map