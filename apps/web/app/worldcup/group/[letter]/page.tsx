"use client";

/**
 * Per-group World Cup page: shows the 4 teams, the 6 group-stage
 * matches, and lets the user tap into any match's prediction
 * market. Uses the same WC fetcher data as the dashboard.
 */

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Card, Badge } from "@/components/ui";
import { AgentsDownBanner } from "@/components/AgentsDownBanner";

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
}

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

function useJson<T>(url: string): { data: T | null; loading: boolean; error: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  // UAT-FN-07 fix: capture the fetch
  // error so the caller can render the
  // agents-down banner. The pre-fix
  // hook only set `loading: false` on
  // error and silently rendered an
  // empty page.
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    fetch(url, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: T) => {
        if (mounted) {
          setData(j);
          setError(null);
        }
      })
      .catch((err) => {
        if (mounted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [url]);
  return { data, loading, error };
}

function matchdayLabel(md: number): string {
  return ['', 'MD1 · June 11-12', 'MD2 · June 17-18', 'MD3 · June 23-24'][md] ?? `MD${md}`;
}

function matchdayFor(matchId: string): number {
  // R1: 1v3, 4v2
  if (matchId.endsWith("v3") || matchId.endsWith("v2")) return 1;
  if (matchId.endsWith("v4")) return 2;
  return 3;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export default function GroupPage() {
  const params = useParams<{ letter: string }>();
  const letter = (params.letter ?? "").toUpperCase();

  const groupsQ = useJson<{ groups: WcGroup[] }>(`${AGENTS_URL}/wc/groups`);
  const scheduleQ = useJson<{ matches: WcMatch[] }>(`${AGENTS_URL}/wc/schedule`);

  const group = (groupsQ.data?.groups ?? []).find((g) => g.letter === letter);
  const matches = (scheduleQ.data?.matches ?? [])
    .filter((m) => m.group === letter)
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  // R53 audit fix: validate the URL letter against the allowed
  // set BEFORE rendering. A typo'd /worldcup/group/Z would
  // otherwise render a "Group Z" page with no teams, no
  // matches, and a confusing "Loading…" forever. The 12 valid
  // group letters are A–L (per the December 5, 2025 draw with
  // the expanded 48-team format).
  const VALID_GROUP_LETTERS = ["A","B","C","D","E","F","G","H","I","J","K","L"];
  if (!VALID_GROUP_LETTERS.includes(letter)) {
    return (
      <div className="space-y-4">
        <Link href="/worldcup" className="text-xs text-zinc-500 hover:text-emerald-300">
          ← Back to dashboard
        </Link>
        <Card>
          <div className="space-y-2 py-4 text-center">
            <h2 className="text-lg font-semibold text-white">Group not found</h2>
            <p className="text-sm text-zinc-400">
              The 2026 World Cup has groups A through L (12 groups, 48 teams).
              &quot;{letter}&quot; is not a valid group.
            </p>
            <Link
              href="/worldcup"
              className="mt-2 inline-block rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
            >
              See all groups
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  // Group matches by matchday
  const byMD = new Map<number, WcMatch[]>();
  for (const m of matches) {
    const md = matchdayFor(m.id);
    const arr = byMD.get(md) ?? [];
    arr.push(m);
    byMD.set(md, arr);
  }

  return (
    <div className="space-y-6 pb-12">
      {/* UAT-FN-07 fix: agents-down banner
         on the group page when both
         upstream endpoints fail. Pre-fix
         the user saw a "Group F" page
         with no teams and no fixtures
         and no explanation. The banner
         renders above the group header
         so the user gets a clear "agents
         service is unreachable" hint. */}
      {!groupsQ.loading &&
        !scheduleQ.loading &&
        groupsQ.error &&
        scheduleQ.error && (
          <AgentsDownBanner
            message={groupsQ.error ?? scheduleQ.error ?? undefined}
          />
        )}
      <div className="flex items-start justify-between gap-3">
        <div>
          <Link
            href="/worldcup"
            className="text-xs text-zinc-500 hover:text-emerald-300"
          >
            ← Back to dashboard
          </Link>
          <h1 className="mt-2 text-3xl font-extrabold text-white">
            Group {letter}
          </h1>
          <p className="text-sm text-zinc-500">All 6 fixtures, 3 matchdays.</p>
        </div>
        {/* R62 audit fix: "All WC markets"
           shortcut in the group header. A user
           landing on /worldcup/group/H wanted
           to also browse the WC-only markets
           list with the live order book (not
           the team-fixtures view), but had to
           back out twice (group → dashboard →
           markets) to get there. The shortcut
           pre-applies the worldcup category
           filter and the markets list picks
           it up from the `?category=` query
           string. */}
        <Link
          href="/markets?category=worldcup"
          className="shrink-0 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 hover:bg-emerald-500/20 transition"
        >
          All WC markets →
        </Link>
      </div>

      {/* R62 audit fix: surface the next
         upcoming match in this group as a
         hero strip. A user landing on a
         group page mid-tournament had no
         immediate signal of what's next —
         the fixtures below are sorted by
         matchday, so MD1 (the earliest
         matchday with a past or future
         fixture) was at the top but the
         "next" match might be MD2 / MD3
         depending on the calendar. The
         strip computes the next match with
         `kickoffMs > now`, shows both
         teams + the kickoff time + a
         countdown, and links straight to
         the betting market. Hidden when
         all 6 fixtures are already
         played (knockout stage). */}
      {(() => {
        const next = (matches ?? [])
          .filter((m) => m.kickoffMs > Date.now())
          .sort((a, b) => a.kickoffMs - b.kickoffMs)[0];
        if (!next) return null;
        const diff = next.kickoffMs - Date.now();
        const days = Math.floor(diff / (24 * 60 * 60 * 1000));
        const hours = Math.floor((diff % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
        const minutes = Math.floor((diff % (60 * 60 * 1000)) / (60 * 1000));
        return (
          <Link
            href={`/markets/${encodeURIComponent("wc26-" + next.id)}`}
            className="group block rounded-2xl border border-emerald-500/20 bg-gradient-to-r from-emerald-900/20 via-panel to-cyan-900/10 p-4 sm:p-5 transition hover:border-emerald-500/40"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="text-3xl leading-none">{next.homeFlag}</span>
                <div className="min-w-0">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
                    Next match in Group {letter}
                  </p>
                  <p className="text-sm font-bold text-white sm:text-base">
                    {next.homeName} <span className="text-zinc-500">vs</span> {next.awayName} {next.awayFlag}
                  </p>
                  <p className="text-[10px] text-zinc-500">{formatDate(next.kickoffMs)}</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-400">Kickoff in</p>
                  <p className="font-mono text-sm font-bold text-emerald-200">
                    {days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`}
                  </p>
                </div>
                <span className="rounded-xl bg-emerald-500 px-3 py-1.5 text-xs font-bold text-emerald-950 group-hover:bg-emerald-400 transition">
                  Trade →
                </span>
              </div>
            </div>
          </Link>
        );
      })()}

      {group && (
        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {group.teams.map((t) => (
            <div
              key={t.code}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-panel p-4"
            >
              <span className="text-3xl leading-none">{t.flag}</span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white truncate">{t.name}</div>
                <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                  {t.drawPosition} · {t.confederation} · Pot {t.pot}
                </div>
              </div>
            </div>
          ))}
        </section>
      )}

      {scheduleQ.loading && (
        <div className="space-y-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      )}

      {[1, 2, 3].map((md) => {
        const arr = byMD.get(md) ?? [];
        if (arr.length === 0) return null;
        return (
          <section key={md} className="space-y-2">
            <h2 className="text-sm font-bold uppercase tracking-wider text-emerald-400">
              {matchdayLabel(md)}
            </h2>
            {arr.map((m) => (
              <div
                key={m.id}
                className="rounded-2xl border border-white/10 bg-panel hover:border-emerald-500/30 transition"
              >
                <Link
                  href={`/markets/${encodeURIComponent("wc26-" + m.id)}`}
                  className="flex items-center justify-between gap-3 px-4 py-4"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-2xl">{m.homeFlag}</span>
                    <span className="text-sm font-semibold text-white truncate">
                      {m.homeName}
                    </span>
                    <span className="text-[10px] uppercase text-zinc-500 px-1">vs</span>
                    <span className="text-sm font-semibold text-white truncate">
                      {m.awayName}
                    </span>
                    <span className="text-2xl">{m.awayFlag}</span>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                      {formatDate(m.kickoffMs)}
                    </span>
                    <Badge variant="success" className="bg-emerald-500/20 text-emerald-300 border-emerald-500/30 text-[10px]">
                      Trade YES/NO →
                    </Badge>
                  </div>
                </Link>
                {/* R61 audit fix: 1-tap YES/NO buttons
                    on every match row. The pre-R61
                    build had a single "Trade YES/NO
                    →" badge that deep-linked to the
                    market page with the side
                    unselected; a user had to
                    drill in, tap YES or NO, then
                    set the size. The pair of buttons
                    below the row matches the
                    DailyWcCard flow and pre-selects
                    the side on the market detail
                    page so the user is one tap + one
                    wallet-confirm from a placed
                    trade. Mobile users on small
                    screens benefit most — fewer
                    round-trips. */}
                <div className="grid grid-cols-2 gap-2 border-t border-white/5 p-3">
                  <Link
                    href={`/markets/${encodeURIComponent("wc26-" + m.id)}?side=yes&order=buy`}
                    className="rounded-lg bg-emerald-500/15 px-3 py-2 text-center text-xs font-bold text-emerald-300 hover:bg-emerald-500/25 transition"
                  >
                    YES · {m.homeName}
                  </Link>
                  <Link
                    href={`/markets/${encodeURIComponent("wc26-" + m.id)}?side=no&order=buy`}
                    className="rounded-lg bg-rose-500/15 px-3 py-2 text-center text-xs font-bold text-rose-300 hover:bg-rose-500/25 transition"
                  >
                    NO · {m.awayName}
                  </Link>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
