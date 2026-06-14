"use client";

/**
 * Friends page: manage the wallet addresses you follow, see their
 * open positions, and compare your prediction scores.
 *
 * Why wallet addresses? The MVP deliberately avoids a separate
 * social-graph contract. Sui addresses are the only identity we
 * need; a user who gives you their Sui address has given you
 * permission to look at their public on-chain positions, which is
 * the same data the `getPortfolio(addr)` REST endpoint returns.
 */

import Link from "next/link";
import { useEffect, useState } from "react";
import { Card } from "@/components/ui";
import { useFriends, shortAddr } from "@/lib/friends";

interface PortfolioRow {
  market_id: string;
  market_title?: string;
  yes: number;
  no: number;
  unrealized_pnl?: number;
}
interface FriendPosition {
  addr: string;
  loading: boolean;
  positions: PortfolioRow[];
  error: string | null;
}

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

function FriendCard({ addr, onRemove }: { addr: string; onRemove: () => void }) {
  const [data, setData] = useState<FriendPosition>({
    addr,
    loading: true,
    positions: [],
    error: null,
  });
  useEffect(() => {
    let mounted = true;
    fetch(`${AGENTS_URL}/portfolio/${addr}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: PortfolioRow[]) => {
        if (mounted) {
          setData({ addr, loading: false, positions: j, error: null });
        }
      })
      .catch((err) => {
        if (mounted) {
          setData({
            addr,
            loading: false,
            positions: [],
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      mounted = false;
    };
  }, [addr]);

  return (
    <div className="rounded-2xl border border-white/10 bg-[#0d1019] p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-bold text-white">{shortAddr(addr)}</div>
          <div className="text-[10px] uppercase tracking-wider text-zinc-500">
            {data.loading
              ? "Loading…"
              : data.error
                ? "Unreachable"
                : `${data.positions.length} position${data.positions.length === 1 ? "" : "s"}`}
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
        <button
          onClick={onRemove}
          className="rounded-lg bg-white/5 px-2 py-1 text-xs text-zinc-400 hover:bg-rose-500/20 hover:text-rose-300 transition"
          aria-label={`Unfollow ${shortAddr(addr)}`}
        >
          Unfollow
        </button>
      </div>
      {data.error && (
        <p className="mt-2 text-xs text-rose-300">
          Couldn&apos;t fetch positions. The agents service might be down.
        </p>
      )}
      {!data.loading && data.positions.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {data.positions.slice(0, 3).map((p) => (
            <li key={p.market_id} className="flex items-center justify-between gap-2 text-xs">
              <Link
                href={`/markets/${encodeURIComponent(p.market_id)}`}
                className="min-w-0 truncate text-zinc-300 hover:text-emerald-300"
              >
                {p.market_title ?? p.market_id.slice(0, 16)}
              </Link>
              <span className="shrink-0 text-[10px] text-zinc-500 font-mono">
                {p.yes > 0 ? `${p.yes}Y` : ""} {p.no > 0 ? `${p.no}N` : ""}
              </span>
            </li>
          ))}
          {data.positions.length > 3 && (
            <li className="text-[10px] text-zinc-500">
              +{data.positions.length - 3} more
            </li>
          )}
        </ul>
      )}
      {!data.loading && data.positions.length === 0 && !data.error && (
        <p className="mt-2 text-xs text-zinc-500">No open positions.</p>
      )}
    </div>
  );
}

export default function FriendsPage() {
  const { friends, add, remove, isValidAddress } = useFriends();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Enter a Sui address (0x…64 hex chars).");
      return;
    }
    if (!isValidAddress(trimmed)) {
      setError("That doesn't look like a Sui address.");
      return;
    }
    if (friends.includes(trimmed)) {
      setError("You're already following that address.");
      return;
    }
    add(trimmed);
    setDraft("");
  }

  const hasFriends = friends.length > 0;

  return (
    <div className="space-y-6 pb-12">
      {/* R30 sweep fix: gradient hero header,
          consistent with /markets, /worldcup,
          /parlay. The previous build was a bare
          1-line h1 with no visual weight. The new
          hero matches the rest of the app's
          aesthetic, names the social-graph
          feature explicitly, and the subtitle
          lists the 4 things the user gets
          (positions / copy / leaderboard / X
          share). */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10 shadow-2xl shadow-black/40">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="relative z-10 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wider text-violet-400">
              👥 Social Graph
            </div>
            <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-4xl">
              Friends
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-400 sm:text-base">
              Follow Sui addresses to see their open positions, copy their bets,
              and compete on a private leaderboard. No server-side social graph —
              your follow list lives in localStorage.
            </p>
          </div>
        </div>
      </div>

      <Card>
        <form onSubmit={handleAdd} className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex-1">
            <label htmlFor="addr" className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
              Sui address
            </label>
            <input
              id="addr"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="0x…"
              className="mt-1 w-full rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-emerald-500/50 focus:outline-none"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <button
            type="submit"
            className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-bold text-emerald-950 hover:bg-emerald-400 transition"
          >
            Follow
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
      </Card>

      {!hasFriends && (
        <Card>
          <div className="space-y-3 text-center py-6">
            <div className="text-5xl">👥</div>
            <h3 className="text-lg font-bold text-white">No friends yet</h3>
            <p className="text-sm text-zinc-400 max-w-sm mx-auto">
              Paste a friend&apos;s Sui wallet address above to see their open
              bets and challenge them to a head-to-head.
            </p>
            {/* R30 sweep fix: inline try-it link
                so a first-time visitor can see the
                UI render with a populated friend
                card (the demo address is a real Sui
                address — the
                /portfolio/:addr endpoint returns
                `[]` for anyone without positions,
                so the card renders the "no open
                positions" empty state cleanly). The
                CTA only appears when the friends
                list is empty so a returning user
                with 5+ follows never sees it. */}
            <div className="pt-2">
              <button
                type="button"
                onClick={() => {
                  add("0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716");
                  setDraft("");
                }}
                className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-4 py-2 text-xs font-bold text-cyan-200 hover:bg-cyan-500/20 transition"
              >
                👀 Try with demo address
              </button>
              <p className="mt-2 text-[10px] text-zinc-600">
                (Operators&apos; public wallet — read-only view, no follow costs.)
              </p>
            </div>
          </div>
        </Card>
      )}

      {hasFriends && (
        <section>
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 className="text-lg font-bold text-white">Following ({friends.length})</h2>
              <p className="text-xs text-zinc-500">Open positions per market</p>
            </div>
            <Link
              href="/leaderboard"
              className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/10"
            >
              Compare on leaderboard →
            </Link>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {friends.map((f) => (
              <FriendCard key={f} addr={f} onRemove={() => remove(f)} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
