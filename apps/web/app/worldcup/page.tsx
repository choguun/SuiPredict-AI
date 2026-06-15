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

// Per-page metadata is exported from the
// segment-level `layout.tsx` (see
// `app/worldcup/layout.tsx`) because this
// file is marked `"use client"` and Next.js
// disallows `metadata` exports from
// client components.

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
    const t = setInterval(() => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      void fetchOnce();
    }, 60_000);
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
  // R30 sweep fix: the home-page "Live &
  // Upcoming" strip and the World Cup
  // dashboard both used a 24h window. With
  // group matches kicking off every 3-4 days
  // and a typical user visiting the dashboard
  // 1-2x per day, a 24h window was almost
  // always empty pre-tournament and
  // always-empty mid-tournament on
  // "non-matchday" days. Bump to 7 days so
  // the user always sees the next 6-12 group
  // matches (with relative kickoff time), and
  // the empty state truly is the rare
  // exception (e.g. all 72 group matches
  // already played). The home page ticker
  // gets the same 7d window.
  const upcomingQ = useJson<{ upcoming: Array<{ id: string; title: string; kickoffIn: number }> }>(
    `${AGENTS_URL}/wc/upcoming?windowMs=${7 * 24 * 60 * 60 * 1000}`,
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

  // R61 audit fix: surface the in-play matches
  // (kickoff in the past, expiry 2h ahead) at the
  // top of the World Cup dashboard so a user
  // landing mid-tournament sees "LIVE" content
  // immediately, instead of a 24h empty upcoming
  // ticker. The "live matches" pill is pure CSS
  // (animated pulse via Tailwind) — no JS timer.
  // The `useMemo` keeps the filter stable across
  // re-renders; recomputing on every render would
  // re-allocate the array and break the `key` prop
  // stability for the upcoming ticker.
  const liveMatches = useMemo(() => {
    const now = Date.now();
    return (scheduleQ.data?.matches ?? [])
      .filter(
        (m) =>
          m.kickoffMs <= now &&
          m.kickoffMs > now - 2 * 60 * 60 * 1000,
      )
      .sort((a, b) => b.kickoffMs - a.kickoffMs);
  }, [scheduleQ.data]);

  return (
    <div className="space-y-6 pb-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-900/40 via-[#0B0E14] to-[#0B0E14] p-6 sm:p-10">
        <div className="absolute -top-32 -right-32 h-80 w-80 rounded-full bg-emerald-500/20 blur-[100px] -z-10" />
        <div className="absolute -bottom-40 -left-20 h-80 w-80 rounded-full bg-amber-500/10 blur-[100px] -z-10" />
        <div className="relative z-10 max-w-2xl">
          <Badge variant="success" className="mb-4 bg-emerald-500/10 text-emerald-300 border-emerald-500/20">
            {/* R62 audit fix: surface the
               actual match count (72
               group-stage + 32
               knockout = 104 total
               matches in a 48-team
               tournament) so the user
               can see the size of the
               WC vertical they're
               about to trade. The
               pre-R62 "48 teams" badge
               was technically correct
               but didn't say how many
               markets the agents would
               seed — a 48-team
               tournament is twice the
               size of a 32-team one and
               the user has no scale
               cue. The home banner uses
               the same "48 teams · 104
               matches" string and the
               "See all 72 group
               matches" footer below
               makes the 72/32 split
               explicit. The R62 audit
               also noticed the badge
               said "104 group matches"
               which is wrong (104 is
               the total tournament
               match count, not the
               group-stage count) — the
               corrected string is
               "48 teams · 104 matches"
               with the breakdown
               explained below. */}
            🏆 FIFA World Cup 2026 · 48 teams · 104 matches
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

      {/* R61 audit fix: dedicated "Live now" strip
         above the upcoming ticker. The pre-R61
         layout only showed the upcoming ticker; a
         user landing mid-tournament (the live demo
         case) saw an empty upcoming list and had no
         signal that the WC is in play. The new strip
         renders above the upcoming ticker with an
         animated pulse dot, the "x matches live"
         counter, and a deep-link to the markets
         list filtered to "live" status. Conditional
         render — the strip disappears when no match
         is in play so it doesn't take up space
         pre-tournament. */}
      {liveMatches.length > 0 && (
        <section className="relative overflow-hidden rounded-2xl border border-rose-500/30 bg-gradient-to-r from-rose-500/10 via-[#0d1019] to-rose-500/5 p-4 sm:p-5">
          <div className="absolute -top-20 -right-20 h-40 w-40 rounded-full bg-rose-500/20 blur-[60px] -z-10" />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <span className="relative flex h-3 w-3">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500 opacity-75" />
                <span className="relative inline-flex h-3 w-3 rounded-full bg-rose-500" />
              </span>
              <div>
                <h2 className="text-base font-extrabold text-white">
                  {liveMatches.length} match{liveMatches.length === 1 ? "" : "es"} live now
                </h2>
                <p className="text-xs text-zinc-400">
                  Trading stays open until 2h after the final whistle.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {liveMatches.slice(0, 3).map((m) => (
                <Link
                  key={m.id}
                  href={`/markets/${encodeURIComponent("wc26-" + m.id)}`}
                  className="inline-flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition"
                >
                  <span>{m.homeFlag} {m.homeName}</span>
                  <span className="text-[10px] text-rose-300/70">vs</span>
                  <span>{m.awayName} {m.awayFlag}</span>
                </Link>
              ))}
              {liveMatches.length > 3 && (
                <Link
                  href="/markets?category=worldcup&status=live"
                  className="inline-flex items-center rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-bold text-rose-200 hover:bg-rose-500/20 transition"
                >
                  +{liveMatches.length - 3} more
                </Link>
              )}
            </div>
          </div>
        </section>
      )}

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
            .slice(0, 24)
            .map((m) => {
              // R61 audit fix: surface a "Live" badge
              // when the match is in-play (kickoff
              // within the regulation+ET window) so
              // a user landing on the World Cup page
              // can spot the in-play matches at a
              // glance. Without this, a Matchday-1
              // mid-tournament user saw 24 identical
              // "vs" rows and had to drill into each
              // to know which one was live. Pure
              // client-side computation (now() is
              // stable across re-renders) and the
              // badge is purely visual — it does not
              // change the data.
              const isLive = m.kickoffMs <= Date.now() && m.kickoffMs > Date.now() - 2 * 60 * 60 * 1000;
              // R62 audit fix: "starts in <1h" amber
              // pill. Same pattern the DailyWcCard
              // uses — a match kicking off in the
              // next 60 minutes is high-intent
              // browsing. The badge is purely
              // visual and uses the same amber
              // gradient the live-now strip uses
              // for the wider tournament-wide
              // in-play indicator.
              const isStartingSoon = !isLive && m.kickoffMs > Date.now() && m.kickoffMs - Date.now() < 60 * 60 * 1000;
              return (
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent("wc26-" + m.id)}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0d1019] px-4 py-3 hover:border-emerald-500/30 transition"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {isLive && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 border border-rose-500/30">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                      Live
                    </span>
                  )}
                  {isStartingSoon && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-300 border border-amber-500/30">
                      Soon
                    </span>
                  )}
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
              );
            })}
        </div>
        {/* R62 audit fix: a "See all 72 group
           matches" footer link. The
           schedule preview hard-codes
           the first 24 matches (Matchday
           1) — a user who wanted to
           browse Matchday 2 or 3 had no
           on-page affordance. The link
           goes to `/markets?category=worldcup`
           (the same shortcut the WC
           group page uses) where the
           full 72-match WC market list
           is filtered down by the
           kickoff_ms timestamps the
           markets list /etc page sort
           on. The "72" number is the
           hard total of group-stage
           matches in a 48-team
           tournament (6 matches × 12
           groups). */}
        <div className="mt-3 text-center">
          <Link
            href="/markets?category=worldcup"
            className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500/20 transition"
          >
            See all 72 group matches →
          </Link>
        </div>
      </section>
    </div>
  );
}
