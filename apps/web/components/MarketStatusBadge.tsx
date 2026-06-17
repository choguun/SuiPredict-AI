"use client";

/**
 * MarketStatusBadge.tsx
 * ============================================================================
 * Per-market status indicator showing whether the market is
 * "Live" (on-chain, tradeable) or "Preview" (SQLite-only, awaiting
 * on-chain creation).
 *
 * R-WC-1.2 fix: a single source of truth for the
 * "is this market actually tradeable?" predicate.
 * The market detail page, the /markets list, the
 * /worldcup dashboard, and the home page all use
 * this badge so a user always sees the same status
 * for a given market id.
 *
 * Predicates:
 *   - Live:       onchain_market_id is set AND deepbook_pool_id is set
 *                 AND status === "active"
 *   - Resolved:   status === "resolved"
 *   - Preview:    onchain_market_id is null AND status === "active"
 *                 (a "ghost" market — the SQLite row exists but
                 the on-chain PredictionMarket has not been
                 published. R-WC-1: a contract upgrade to
                 per-market coin types would let the wc-creator
                 publish these automatically.)
 *   - Expired:    status === "expired" (no resolution yet, past
 *                 the kickoff)
 *   - Cancelled:  status === "cancelled" (creator cancelled)
 *
 * Marked "use client" because it's rendered inside the
 * /markets/[id] page (which is a client component that
 * fetches market data via TanStack Query). The
 * component itself is a pure presentational leaf with
 * no state or effects, so the client directive is just
 * a compatibility marker.
 */

type MarketLike = {
  id: string;
  status?: string;
  onchain_market_id?: string | null;
  deepbook_pool_id?: string | null;
};

export type MarketTradeableState =
  | "live"
  | "preview"
  | "resolved"
  | "expired"
  | "cancelled";

export function getMarketTradeableState(m: MarketLike): MarketTradeableState {
  if (m.status === "resolved") return "resolved";
  if (m.status === "expired") return "expired";
  if (m.status === "cancelled") return "cancelled";
  // status === "active" (or unset) — differentiate by on-chain state
  if (m.onchain_market_id && m.deepbook_pool_id) return "live";
  return "preview";
}

const BADGE_STYLES: Record<MarketTradeableState, string> = {
  live:
    "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  preview:
    "bg-amber-500/15 text-amber-200 border-amber-500/30",
  resolved:
    "bg-zinc-500/20 text-zinc-300 border-zinc-500/30",
  expired:
    "bg-rose-500/15 text-rose-300 border-rose-500/30",
  cancelled:
    "bg-zinc-500/20 text-zinc-400 border-zinc-500/30",
};

const BADGE_LABELS: Record<MarketTradeableState, string> = {
  live: "Tradeable",
  preview: "Preview",
  resolved: "Resolved",
  expired: "Expired",
  cancelled: "Cancelled",
};

const BADGE_DOTS: Record<MarketTradeableState, string> = {
  live: "bg-emerald-400",
  preview: "bg-amber-400",
  resolved: "bg-zinc-400",
  expired: "bg-rose-400",
  cancelled: "bg-zinc-500",
};

export function MarketStatusBadge({
  market,
  className = "",
  showDot = true,
}: {
  market: MarketLike;
  className?: string;
  showDot?: boolean;
}) {
  const state = getMarketTradeableState(market);
  return (
    <span
      className={
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider " +
        BADGE_STYLES[state] +
        " " +
        className
      }
      title={
        state === "preview"
          ? "SQLite-only preview row. On-chain PredictionMarket not yet published. See /worldcup for the next tradeable match."
          : state === "live"
            ? "On-chain PredictionMarket with a DeepBook pool. Limit orders route to Sui testnet."
            : undefined
      }
    >
      {showDot && state === "live" && (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
      )}
      {showDot && state !== "live" && (
        <span className={`h-1.5 w-1.5 rounded-full ${BADGE_DOTS[state]}`} />
      )}
      {BADGE_LABELS[state]}
    </span>
  );
}
