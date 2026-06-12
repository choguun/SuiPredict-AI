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

function useJson<T>(url: string): { data: T | null; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    fetch(url, { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: T) => {
        if (mounted) {
          setData(j);
          setLoading(false);
        }
      })
      .catch(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [url]);
  return { data, loading };
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

      {group && (
        <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {group.teams.map((t) => (
            <div
              key={t.code}
              className="flex items-center gap-3 rounded-2xl border border-white/10 bg-[#0d1019] p-4"
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
              <Link
                key={m.id}
                href={`/markets/${encodeURIComponent("wc26-" + m.id)}`}
                className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#0d1019] px-4 py-4 hover:border-emerald-500/30 transition"
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
            ))}
          </section>
        );
      })}
    </div>
  );
}
