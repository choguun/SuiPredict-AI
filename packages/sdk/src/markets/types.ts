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
  /**
   * On-chain market object id (the digest-derived one returned by
   * `extractCreatedObjectId` after a successful `buildCreateMarketTx`).
   * Set by the WC creator for the consolidated `wc26-<matchId>` row;
   * the WC resolver uses this for `buildResolveMarketTx` and the WC
   * maker uses this for `buildPlaceOrderTx`. Optional because demo
   * markets (no on-chain creation) leave it null.
   */
  onchain_market_id?: string | null;
  /**
   * R-WC-3.4: per-market phantom `M` (a 32-byte hex address from
   * `marketTypeSeed`). Written by the creator at create time and
   * read back by the maker / resolver so they thread the
   * *exact* same `M` into `buildPlaceOrderTx` /
   * `buildResolveMarketTx` / `buildMintSharesTx` — without
   * agreeing on `M`, the on-chain `<Q, M>` signature aborts with
   * a `TypeMismatch` on the second PTB.
   *
   * NULL for pre-R-WC-3.4 rows. The resolver falls back to
   * `marketTypeSeed(id)` for `wc26-*` rows (where `id` IS the
   * creator-time seed) and to `undefined` for legacy
   * single-phantom markets.
   */
  pool_type_seed?: string | null;
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
