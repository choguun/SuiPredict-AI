"use client";

/**
 * "Recent trades" panel for a single market.
 * Renders the most recent N on-chain /
 * indexer-mirrored trades for the market
 * id, with a relative timestamp, side
 * (bid / ask), price, and quantity.
 *
 * R32 sweep fix: the agents indexer
 * populated the `trades` table but the
 * market detail page had no UI to surface
 * it. Without a trade history, a user
 * landing on a market page mid-session
 * had no way to gauge recent activity
 * ("has anyone traded this in the last
 * hour? what's the price drift?"). The
 * new panel is a thin client wrapper
 * over `getMarketTrades()` and renders
 * 3 states:
 *   - loading skeleton (3 rows)
 *   - empty state with explanatory copy
 *   - list of trades, newest first
 *
 * Visibility-aware refresh: the
 * 10-second polling pauses when the tab
 * is backgrounded (R42 pattern shared
 * with /portfolio and /vault) so a
 * 1-hour backgrounded tab doesn't fire
 * 360 API calls. The initial fetch
 * runs on mount, not on a timer, so
 * the first paint always shows real
 * data.
 *
 * R-FIX-RT layout: the component no
 * longer renders its own outer <Card>.
 * Previously it was rendered as a
 * nested Card inside the YES ORDER
 * BOOK card's footer flex row, which
 * produced a broken layout where the
 * "Recent trades" Card competed for
 * flex-row space with the "Updated
 * HH:MM:SS" timestamp and the
 * "↻ Refresh" button. The card now
 * renders a self-contained <section>
 * with its own title row, and the
 * call site wraps it in a border-t
 * divider inside the order book
 * card. This makes the panel usable
 * both as a subsection of the order
 * book card and as a standalone
 * panel if a future page wants to
 * drop it in.
 */
import { useQuery } from "@tanstack/react-query";
import { getMarketTrades } from "@suipredict/sdk";

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Shorten a Sui order id (a 0x-prefixed
 * hex string) to its last 6 hex chars.
 * The full id is 66+ chars and would
 * overflow the narrow Order column on
 * mobile. The hash-prefixed form
 * (`#a1b2c3`) is enough for a user to
 * cross-reference against the indexer
 * / SuiVision if they need to dig
 * deeper.
 */
function shortOrderId(id: string): string {
  if (!id) return "—";
  // `0x` prefix + at least 4 hex chars
  // → keep the last 6 hex chars.
  if (id.startsWith("0x") && id.length > 8) {
    return `#${id.slice(-6)}`;
  }
  // Demo / SQLite ids like `wc26-A1v4`
  // — already short, render verbatim.
  return `#${id}`;
}

export function RecentTrades({
  marketId,
  limit = 10,
}: {
  marketId: string;
  limit?: number;
}) {
  const { data, isLoading, error, isFetching } = useQuery({
    queryKey: ["marketTrades", marketId, limit],
    queryFn: () => getMarketTrades(marketId, limit),
    // 10s polling on a visible tab. Pause when hidden.
    refetchInterval: () => {
      if (typeof document === "undefined") return 10_000;
      return document.visibilityState === "visible" ? 10_000 : false;
    },
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const trades = data ?? [];

  return (
    <section aria-label="Recent trades" className="space-y-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
          Recent trades
          {!isLoading && !error && trades.length > 0 && (
            <span className="ml-1.5 text-zinc-600">({trades.length})</span>
          )}
        </h3>
        {isFetching && !isLoading && (
          <span className="text-[10px] text-zinc-600">Refreshing…</span>
        )}
      </div>

      {isLoading && (
        <div className="space-y-2" aria-label="Loading recent trades">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-9 animate-pulse rounded-md bg-white/[0.03]"
            />
          ))}
        </div>
      )}
      {error && !isLoading && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          Could not load recent trades. The agents indexer is unreachable.
        </p>
      )}
      {!isLoading && !error && trades.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-zinc-500">
          No trades yet. The first fill will appear here within ~60 seconds
          of the market going live.
        </p>
      )}
      {trades.length > 0 && (
        <div className="space-y-1">
          <div className="grid grid-cols-12 gap-2 border-b border-white/10 px-2 pb-2 text-[10px] font-bold uppercase tracking-wider text-zinc-500">
            <span className="col-span-2">Time</span>
            <span className="col-span-2">Side</span>
            <span className="col-span-3 text-right">Price</span>
            <span className="col-span-3 text-right">Quantity</span>
            <span className="col-span-2 text-right">Order</span>
          </div>
          {trades.map((t, idx) => {
            const isBid = Boolean(t.is_bid);
            const priceCents = (t.price_bps / 100).toFixed(1);
            return (
              <div
                // Key on a stable composite: market_id + order_id +
                // timestamp_ms. TradeRecord doesn't have a unique
                // `id` field but a single fill of a given order can
                // only produce one row, so (order_id, timestamp_ms)
                // is unique within a market. Fall back to `idx` for
                // the rare pre-R32 row that lacks either field.
                key={`${t.order_id}-${t.timestamp_ms}-${idx}`}
                className="grid grid-cols-12 gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-white/[0.04] transition-colors"
              >
                <span className="col-span-2 text-zinc-500 tabular-nums">
                  {timeAgo(t.timestamp_ms)}
                </span>
                <span className="col-span-2">
                  <span
                    className={`inline-flex rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                      isBid
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-rose-500/15 text-rose-300 border border-rose-500/30"
                    }`}
                  >
                    {isBid ? "Bid" : "Ask"}
                  </span>
                </span>
                <span
                  className={`col-span-3 text-right font-mono tabular-nums ${
                    isBid ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {priceCents}¢
                </span>
                <span className="col-span-3 text-right font-mono tabular-nums text-zinc-300">
                  {Number(t.quantity).toLocaleString()}
                </span>
                <span
                  className="col-span-2 truncate text-right font-mono text-[10px] text-zinc-500"
                  title={t.order_id}
                >
                  {shortOrderId(t.order_id)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}