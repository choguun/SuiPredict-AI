"use client";

/**
 * Friend positions widget.
 *
 * Shown on the market detail page below the order book. Lists the
 * followed friends who have an open position on this market, with
 * their YES/NO balance and a one-tap "copy their bet" CTA.
 *
 * "Copy their bet" is a non-functional stub in MVP — it just copies
 * the friend's side to the order ticket (the user still signs the
 * PTB). v2 will wire a one-tap sponsored PTB that mirrors the
 * friend's last fill size, with a cap at the user's available
 * BalanceManager balance.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { useFriends, shortAddr } from "@/lib/friends";
import { Card } from "@/components/ui";

interface PortfolioRow {
  market_id: string;
  yes: number;
  no: number;
}

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

interface FriendState {
  loading: boolean;
  yes: number;
  no: number;
  error: string | null;
}

export function FriendPositionsWidget({
  marketId,
  onCopyBet,
}: {
  marketId: string;
  onCopyBet?: (side: "yes" | "no", size: number) => void;
}) {
  const { friends } = useFriends();
  const [positions, setPositions] = useState<Record<string, FriendState>>({});

  useEffect(() => {
    if (friends.length === 0) {
      setPositions({});
      return;
    }
    const ac = new AbortController();
    (async () => {
      const next: Record<string, FriendState> = {};
      await Promise.all(
        friends.map(async (addr) => {
          try {
            const r = await fetch(`${AGENTS_URL}/portfolio/${addr}`, {
              signal: ac.signal,
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const rows = (await r.json()) as PortfolioRow[];
            const row = rows.find((x) => x.market_id === marketId);
            next[addr] = {
              loading: false,
              yes: row?.yes ?? 0,
              no: row?.no ?? 0,
              error: null,
            };
          } catch (err) {
            if (ac.signal.aborted) return;
            next[addr] = {
              loading: false,
              yes: 0,
              no: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );
      setPositions(next);
    })();
    return () => ac.abort();
  }, [friends, marketId]);

  if (friends.length === 0) {
    return (
      <Card>
        <div className="flex items-center gap-3">
          <span className="text-2xl">👥</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white">
              No friends yet
            </p>
            <p className="text-xs text-zinc-500">
              Follow Sui addresses to see what they&apos;re betting on this market.
            </p>
          </div>
          <Link
            href="/friends"
            className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
          >
            Add friends
          </Link>
        </div>
      </Card>
    );
  }

  const withPositions = friends.filter(
    (a) => positions[a] && (positions[a]!.yes > 0 || positions[a]!.no > 0),
  );

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-bold text-white">👥 Friends on this market</h3>
            <p className="text-[10px] text-zinc-500">
              {withPositions.length} of {friends.length} have a position
            </p>
          </div>
          <Link
            href="/friends"
            className="rounded-md px-2 py-1 text-[10px] font-medium text-zinc-500 hover:text-emerald-300"
          >
            Manage
          </Link>
        </div>
        {withPositions.length === 0 ? (
          <p className="text-xs text-zinc-500">
            None of your friends have a position on this market yet. Be the
            first to set the line.
          </p>
        ) : (
          <ul className="space-y-2">
            {/* Sort by biggest position first so the most
                committed friend is at the top of the list. */}
            {[...withPositions]
              .sort((a, b) => {
                const aPos = positions[a]!;
                const bPos = positions[b]!;
                const aSize = Math.max(aPos.yes, aPos.no);
                const bSize = Math.max(bPos.yes, bPos.no);
                return bSize - aSize;
              })
              .map((addr) => {
              const p = positions[addr]!;
              const side: "yes" | "no" = p.yes >= p.no ? "yes" : "no";
              const size = side === "yes" ? p.yes : p.no;
              return (
                <li
                  key={addr}
                  className="flex items-center justify-between gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-white">
                      {shortAddr(addr)}
                    </div>
                    <div className="text-[10px] text-zinc-500 font-mono">
                      {p.yes > 0 && (
                        <span className="text-emerald-400">{p.yes / 1e6} YES</span>
                      )}
                      {p.yes > 0 && p.no > 0 && " · "}
                      {p.no > 0 && (
                        <span className="text-rose-400">{p.no / 1e6} NO</span>
                      )}
                    </div>
                    <a
                      href={`https://${process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet"}.suivision.xyz/address/${addr}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mt-0.5 inline-block text-[10px] text-cyan-400/70 hover:text-cyan-300"
                    >
                      View on SuiVision ↗
                    </a>
                  </div>
                  {size > 0 && (
                    <button
                      onClick={() =>
                        onCopyBet
                          ? onCopyBet(side, size)
                          : defaultCopyBet(marketId, side)
                      }
                      className="shrink-0 rounded-md bg-white/5 px-2 py-1 text-[10px] font-bold text-white hover:bg-emerald-500/20 hover:text-emerald-300"
                    >
                      Copy {side.toUpperCase()} →
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** Build a share-to-X URL for a market position. */
export function sharePositionUrl(opts: {
  marketTitle: string;
  side: "yes" | "no";
  quantity: number;
  marketUrl: string;
}): string {
  const text = `I just bet ${opts.side.toUpperCase()} on "${opts.marketTitle}" — ${opts.quantity} shares. Beat me:`;
  const params = new URLSearchParams({ text, url: opts.marketUrl });
  return `https://twitter.com/intent/tweet?${params.toString()}`;
}

/**
 * R61 audit fix: the `onCopyBet` callback was
 * declared in the props but never *received* by
 * the markets/[id] page (a caller `onCopyBet?.(...)`
 * was guarded against undefined, and no one
 * supplied one). A user who tapped "Copy YES →"
 * got no feedback at all. The friend card now
 * ships a default onCopyBet that, when no
 * parent-side handler is provided, navigates to
 * the same market with `?side=...&order=buy` set
 * so the trade panel opens pre-selected (the
 * markets/[id] page reads those params in R61).
 * The page-mount call site in
 * `app/markets/[id]/page.tsx` still passes its
 * own onCopyBet (a future enhanced copy-trade
 * sponsor flow), so behaviour there is
 * unchanged.
 */
function defaultCopyBet(
  marketId: string,
  side: "yes" | "no",
  // R61 audit fix: drop the unused `_size` from
  // the parameter list. The previous signature
  // accepted a `size` value to match the
  // parent's `onCopyBet` shape, but the default
  // fallback never used it (we only nav to the
  // market with the side pre-selected, and
  // `qty` is set by the page on the parent
  // handler's call site). The leading underscore
  // suppressed the lint warning under the
  // "argsIgnorePattern" convention, but the
  // destructure still costs a frame per call.
  // The parent handler in `markets/[id]/page.tsx`
  // continues to receive `size` via its own
  // `onCopyBet={(_, size) => setQty(...)}`
  // closure — no behaviour change for the
  // parent call site.
) {
  if (typeof window === "undefined") return;
  const url = `/markets/${encodeURIComponent(marketId)}?side=${side}&order=buy`;
  // Use `location.assign` so the back button still
  // returns to the previous page (a `<Link>`
  // click would also work, but the friend card
  // may render inside a `<Link>` parent, and a
  // nested link is invalid HTML).
  window.location.assign(url);
}
