/**
 * "Top forecasters" widget for the home page. Pulls the
 * top-5 leaderboard rows from the agents REST and
 * surfaces them as a compact podium + list. A first-time
 * visitor lands on `/` and sees (a) a live activity feed
 * showing the agents are running, (b) a "Top forecasters"
 * widget showing real players are trading, and (c) the
 * featured markets bento — three complementary "is this
 * thing alive?" signals.
 *
 * Visibility-aware 60s polling. The widget is best-effort:
 * a 5xx from the agents service renders a single-row hint
 * instead of crashing the home page. The same data also
 * lives on /leaderboard (full table) — this widget is the
 * compact version for the home page.
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
const TOP_N = 5;
const POLL_MS = 60_000;

interface WeeklyRow {
  user: string;
  week_index: number;
  score: number;
  rank: number;
  correct_days: number;
  longest_streak: number;
  category: number;
  claimed?: boolean;
}

function shortAddr(a: string): string {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function rankEmoji(rank: number): string {
  if (rank === 1) return "🥇";
  if (rank === 2) return "🥈";
  if (rank === 3) return "🥉";
  return `#${rank}`;
}

export function TopForecasters() {
  const [rows, setRows] = useState<WeeklyRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${AGENTS_URL}/leaderboard/week?limit=${TOP_N}`, {
        cache: "no-store",
      })
        .then(async (r) => {
          if (cancelled) return;
          if (!r.ok) {
            setError(`Agents responded ${r.status}`);
            return;
          }
          const j = (await r.json()) as { rows: WeeklyRow[] };
          setRows(j.rows ?? []);
          setError(null);
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : "Fetch failed");
        })
        .finally(() => {
          if (!cancelled) setLoaded(true);
        });
    };
    load();
    const t = setInterval(() => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      load();
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-white">
            <span aria-hidden="true">🏆</span>
            <span>Top forecasters</span>
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            Best streak scorers this week.{" "}
            {rows.length > 0 && (
              <span className="font-mono text-[10px] text-cyan-400/80">
                · Week #{rows[0]!.week_index}
              </span>
            )}
          </p>
        </div>
        <Link
          href="/leaderboard"
          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10"
        >
          Full board →
        </Link>
      </div>

      {!loaded && (
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-10 animate-pulse rounded-lg bg-white/[0.03]"
            />
          ))}
        </div>
      )}

      {loaded && error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {error}. The agents service may be down — start it with{" "}
          <code className="text-[10px]">pnpm dev:agents</code>.
        </p>
      )}

      {loaded && !error && rows.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-zinc-500">
          No forecasters on the board yet. Make a daily prediction to claim rank #1.
        </p>
      )}

      {rows.length > 0 && (
        <ol className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.user}
              className={`flex items-center gap-3 rounded-lg border p-2.5 ${
                r.rank === 1
                  ? "border-amber-500/30 bg-gradient-to-r from-amber-500/10 to-transparent"
                  : "border-white/5 bg-white/[0.02]"
              }`}
            >
              <span className="w-7 text-center text-sm font-bold text-zinc-300" aria-label={`Rank ${r.rank}`}>
                {rankEmoji(r.rank)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-xs font-semibold text-cyan-300">
                    {shortAddr(r.user)}
                  </span>
                  {r.claimed && (
                    <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-emerald-300">
                      ✓ Claimed
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-zinc-500">
                  {r.correct_days} correct days · {r.longest_streak}d longest streak
                </p>
              </div>
              <div className="text-right">
                <p className="font-mono text-sm font-bold text-white">
                  {r.score.toFixed(2)}
                </p>
                <p className="text-[9px] uppercase tracking-wider text-zinc-500">
                  points
                </p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
