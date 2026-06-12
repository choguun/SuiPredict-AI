"use client";

/**
 * World Cup 2026 dashboard.
 *
 * Mobile-first design: single column on phones, three columns on
 * desktop. Top section is a live match ticker (auto-refreshes
 * every 60s), middle is the 12 groups with current standings
 * (auto-refreshes every 5min), bottom is the upcoming matches in
 * the next 24h with deep links to the betting market.
 *
 * All data comes from the agents REST endpoints
 * (`/wc/groups`, `/wc/schedule`, `/wc/upcoming`) so the web
 * bundle never has to talk to Sui directly.
 */

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Card, Badge } from "@/components/ui";

interface WcTeam {
  code: string;
  drawPosition: string;
  name: string;
  flag: string;
  confederation: string;
  pot: number;
}
interface WcGroup {
  letter: string;
  teams: WcTeam[];
}
interface WcMatch {
  id: string;
  group: string;
  homeCode: string;
  awayCode: string;
  homeName: string;
  awayName: string;
  homeFlag: string;
  awayFlag: string;
  kickoffMs: number;
  stadium: string;
  stage: "group";
}

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

function useJson<T>(url: string, deps: unknown[] = []): {
  data: T | null;
  loading: boolean;
  error: string | null;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    const fetchOnce = async () => {
      try {
        const r = await fetch(url, { headers: { accept: "application/json" } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as T;
        if (mounted) {
          setData(j);
          setError(null);
        }
      } catch (err) {
        if (mounted) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void fetchOnce();
    const t = setInterval(fetchOnce, 60_000);
    return () => {
      mounted = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, loading, error };
}

function formatKickoff(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days[d.getUTCDay()];
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const isToday = d.toDateString() === now.toDateString();
  const isTomorrow =
    new Date(now.getTime() + 24 * 60 * 60 * 1000).toDateString() ===
    d.toDateString();
  if (isToday) return `Today ${hh}:${mm} UTC`;
  if (isTomorrow) return `Tomorrow ${hh}:${mm} UTC`;
  return `${day} ${hh}:${mm} UTC`;
}

function kickoffIn(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "kickoff";
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(hours / 24);
  if (days > 1) return `${days}d`;
  if (hours > 0) return `${hours}h`;
  const minutes = Math.floor(diff / 60_000);
  return `${minutes}m`;
}

export default function WorldCupPage() {
  const groupsQ = useJson<{ groups: WcGroup[] }>(`${AGENTS_URL}/wc/groups`);
  const scheduleQ = useJson<{ matches: WcMatch[] }>(`${AGENTS_URL}/wc/schedule`);
  const upcomingQ = useJson<{ upcoming: Array<{ id: string; title: string; kickoffIn: number }> }>(
    `${AGENTS_URL}/wc/upcoming?windowMs=${24 * 60 * 60 * 1000}`,
  );

  const matchesByGroup = useMemo(() => {
    const map = new Map<string, WcMatch[]>();
    for (const m of scheduleQ.data?.matches ?? []) {
      const arr = map.get(m.group) ?? [];
      arr.push(m);
      map.set(m.group, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.kickoffMs - b.kickoffMs);
    }
    return map;
  }, [scheduleQ.data]);

  const nextMatch = useMemo(() => {
    const matches = (scheduleQ.data?.matches ?? [])
      .filter((m) => m.kickoffMs > Date.now())
      .sort((a, b) => a.kickoffMs - b.kickoffMs);
    return matches[0];
  }, [scheduleQ.data]);

  return (
    <div className="space-y-6 pb-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-900/40 via-[#0B0E14] to-[#0B0E14] p-6 sm:p-10">
        <div className="absolute -top-32 -right-32 h-80 w-80 rounded-full bg-emerald-500/20 blur-[100px] -z-10" />
        <div className="absolute -bottom-40 -left-20 h-80 w-80 rounded-full bg-amber-500/10 blur-[100px] -z-10" />
        <div className="relative z-10 max-w-2xl">
          <Badge variant="success" className="mb-4 bg-emerald-500/10 text-emerald-300 border-emerald-500/20">
            🏆 FIFA World Cup 2026 · 48 teams
          </Badge>
          <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white mb-3">
            Predict every match.<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-br from-emerald-300 via-amber-200 to-emerald-300">
              Win the bracket.
            </span>
          </h1>
          <p className="text-base text-zinc-300 sm:text-lg max-w-xl">
            The first gamified prediction market for the 2026 World Cup. Trade
            YES/NO on every group match, build parlays, climb the leaderboard,
            and beat your friends.
          </p>
          {nextMatch && (
            <div className="mt-6 inline-flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3 backdrop-blur-md">
              <span className="text-2xl">{nextMatch.homeFlag}</span>
              <span className="text-xs font-bold uppercase tracking-wider text-zinc-400">Next</span>
              <span className="text-sm font-semibold text-white">
                {nextMatch.homeName} vs {nextMatch.awayName} {nextMatch.awayFlag}
              </span>
              <span className="text-xs text-emerald-300 font-mono">
                {kickoffIn(nextMatch.kickoffMs)}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Live match ticker */}
      <section className="rounded-2xl border border-white/10 bg-[#0d1019] p-5 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-white">🔴 Live & Upcoming</h2>
            <p className="text-xs text-zinc-500">Auto-refreshes every minute · UTC</p>
          </div>
          <Link
            href="/markets?category=worldcup"
            className="rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs font-bold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
          >
            All WC markets →
          </Link>
        </div>
        {upcomingQ.loading && !upcomingQ.data && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-xl bg-white/5" />
            ))}
          </div>
        )}
        {upcomingQ.data && upcomingQ.data.upcoming.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 bg-white/5 p-6 text-center text-sm text-zinc-400">
            No World Cup markets live in the next 24h. The agents will create
            new ones 7 days before kickoff.
          </div>
        )}
        {upcomingQ.data && upcomingQ.data.upcoming.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {upcomingQ.data.upcoming.slice(0, 6).map((m) => (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent(m.id)}`}
                className="group flex flex-col gap-2 rounded-xl border border-white/10 bg-gradient-to-br from-white/[0.04] to-transparent p-4 hover:border-emerald-500/40 hover:bg-white/[0.06] transition"
              >
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                  {m.kickoffIn > 0 ? `Kicks off in ${kickoffIn(Date.now() + m.kickoffIn)}` : "Started"}
                </span>
                <span className="line-clamp-2 text-sm font-semibold text-white">
                  {m.title}
                </span>
                <span className="mt-auto text-xs text-zinc-500 group-hover:text-emerald-300">
                  Place your bet →
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* 12 groups */}
      <section className="space-y-4">
        <div>
          <h2 className="text-2xl font-bold text-white">Groups</h2>
          <p className="text-sm text-zinc-500">Tap a group to see fixtures and odds.</p>
        </div>
        {groupsQ.loading && !groupsQ.data && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-2xl bg-white/5" />
            ))}
          </div>
        )}
        {groupsQ.error && (
          <Card>
            <p className="text-sm text-rose-300">
              Couldn&apos;t reach the agents service ({groupsQ.error}). Start
              the agents with <code className="text-xs">pnpm dev:agents</code> to see live groups.
            </p>
          </Card>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(groupsQ.data?.groups ?? []).map((g) => {
            const matches = matchesByGroup.get(g.letter) ?? [];
            return (
              <Link
                key={g.letter}
                href={`/worldcup/group/${g.letter}`}
                className="group flex flex-col gap-3 rounded-2xl border border-white/10 bg-[#0d1019] p-4 hover:border-emerald-500/30 transition"
              >
                <div className="flex items-center justify-between">
                  <span className="text-lg font-extrabold text-white">Group {g.letter}</span>
                  <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                    {matches.length} matches
                  </span>
                </div>
                <ul className="space-y-1.5">
                  {g.teams.map((t) => (
                    <li
                      key={t.code}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="flex items-center gap-2 text-zinc-200">
                        <span className="text-base leading-none">{t.flag}</span>
                        <span className="truncate">{t.name}</span>
                      </span>
                      <span className="text-[10px] uppercase tracking-wider text-zinc-600">
                        Pot {t.pot}
                      </span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto text-xs text-emerald-400 group-hover:underline">
                  See fixtures →
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      {/* Schedule preview */}
      <section className="space-y-3">
        <div className="flex items-end justify-between">
          <div>
            <h2 className="text-2xl font-bold text-white">Matchday 1</h2>
            <p className="text-sm text-zinc-500">June 11–12, 2026 · 24 matches</p>
          </div>
        </div>
        <div className="space-y-2">
          {(scheduleQ.data?.matches ?? [])
            .filter((m) => m.kickoffMs < Date.UTC(2026, 5, 14))
            .slice(0, 12)
            .map((m) => (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent("wc26-" + m.id)}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0d1019] px-4 py-3 hover:border-emerald-500/30 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-2xl">{m.homeFlag}</span>
                  <span className="text-sm font-semibold text-white truncate">
                    {m.homeName}
                  </span>
                  <span className="text-[10px] uppercase text-zinc-500">vs</span>
                  <span className="text-sm font-semibold text-white truncate">
                    {m.awayName}
                  </span>
                  <span className="text-2xl">{m.awayFlag}</span>
                </div>
                <div className="flex items-center gap-2 text-right">
                  <span className="text-xs text-zinc-500">{formatKickoff(m.kickoffMs)}</span>
                  <span className="text-xs text-emerald-300 font-mono">
                    {kickoffIn(m.kickoffMs)}
                  </span>
                </div>
              </Link>
            ))}
        </div>
      </section>
    </div>
  );
}
