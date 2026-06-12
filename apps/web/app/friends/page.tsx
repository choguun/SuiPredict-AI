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
import { useEffect, useMemo, useState } from "react";
import { Card, Badge } from "@/components/ui";
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
      <div>
        <h1 className="text-2xl font-extrabold text-white sm:text-3xl">Friends</h1>
        <p className="text-sm text-zinc-500">
          Follow Sui addresses to see their open positions, copy their bets,
          and compete on a private leaderboard.
        </p>
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
          <div className="space-y-2 text-center py-4">
            <div className="text-4xl">👥</div>
            <h3 className="text-lg font-bold text-white">No friends yet</h3>
            <p className="text-sm text-zinc-400 max-w-sm mx-auto">
              Paste a friend&apos;s Sui wallet address above to see their open
              bets and challenge them to a head-to-head.
            </p>
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
