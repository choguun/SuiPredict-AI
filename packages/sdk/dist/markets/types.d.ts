export interface MarketInfo {
    id: string;
    title: string;
    description: string;
    category: string;
    expiry_ms: number;
    /**
     * R61 audit fix: derived kickoff timestamp. For
     * World Cup markets the contract sets
     * `expiry_ms = kickoff + 2h` (regulation + extra
     * time + the resolver's 2-hour post-match window),
     * so `kickoff_ms = expiry_ms - 2h`. For non-WC
     * markets the agent creator can use a different
     * `expiry_days` (1-30) and the kickoff is "now",
     * so the field is computed as `expiry_ms - 1min`
     * for non-WC markets to keep the value present.
     *
     * The field is populated by the agents service's
     * `rowToMarket` so existing SDK consumers (web,
     * future indexer) don't have to recompute the
     * 2-hour window — the WC daily card, the WC
     * dashboard, and the markets/[id] page all
     * display "X until kickoff" using this value.
     */
    kickoff_ms?: number;
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
    /**
     * On-chain market object id (the digest-derived one returned by
     * `extractCreatedObjectId` after a successful `buildCreateMarketTx`).
     * Set by the WC creator for the consolidated `wc26-<matchId>` row;
     * the WC resolver uses this for `buildResolveMarketTx` and the WC
     * maker uses this for `buildPlaceOrderTx`. Optional because demo
     * markets (no on-chain creation) leave it null.
     */
    onchain_market_id?: string | null;
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
    onchain_market_id?: string | null;
}
export interface VaultSummaryClob {
    vault_id: string;
    total_balance: string;
    allocated: string;
    available: string;
}
//# sourceMappingURL=types.d.ts.map