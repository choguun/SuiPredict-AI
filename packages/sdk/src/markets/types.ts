export interface MarketInfo {
  id: string;
  title: string;
  description: string;
  category: string;
  expiry_ms: number;
  resolution_source: string;
  // `"disputed"` is written by `markMarketDisputed` (position-indexer
  // polls `MarketDisputedEvent`); a disputed market is frozen on-chain
  // and `redeem`/`redeem_no` abort with `EMarketDisputed` until the
  // creator resolves the dispute. Excluded from the original union,
  // which forced `rowToMarket` to lie about a market the indexer
  // definitely knows is in dispute.
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
  // Mirrors the `disputed`, `dispute_count`, `dispute_evidence_uri`,
  // and `last_dispute_at_ms` columns in `markets` (apps/agents).
  // `dispute_count` is the cumulative number of disputes filed against
  // this market (preserved across `resolve_dispute` for the audit
  // trail); `dispute_evidence_uri` is the most recent evidence URI;
  // `last_dispute_at_ms` is the timestamp of the most recent dispute.
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

// R56.9 audit fix: the on-the-wire balance fields are
// `string` (bigint-as-string) rather than `number`. The
// R55 sweep coerced to `Number(raw.total_balance)` etc.
// to defend against a future bigint-as-string migration,
// but `Number(bigintString)` loses precision above
// 2^53 - 1 (DUSDC has 6 decimals, so 2^53 atoms = ~$9
// trillion). The type definition previously lied about
// the wire shape. Render the values on the admin / home
// / vault pages with `BigInt(s).toString()` and a
// `formatDusdc` helper that divides by 1e6 safely.
export interface VaultSummaryClob {
  vault_id: string;
  total_balance: string;
  allocated: string;
  available: string;
}
