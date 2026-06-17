"use client";

/**
 * R-WC-2: "Team analysis" card rendered behind every
 * World Cup market card on `/markets`. Shows each
 * team's Elo rating, strength tier, confederation,
 * pot, and the head-to-head prediction.
 *
 * Data source: `GET ${AGENTS_URL}/wc/team-analysis`,
 * which returns 48 teams + 72 match rows in a
 * single response. We cache the response in
 * localStorage for 1h (the schedule and Elo values
 * only change on a re-draw, which the agents
 * invalidate via a process restart).
 *
 * The card is purely presentational — every
 * interactive element (clicking the card, expanding
 * the details) bubbles up to the parent <Link> and
 * navigates to the market detail page. The card has
 * no <button> elements so there's no risk of
 * double-firing the parent link.
 *
 * Rendering modes:
 *   - loading: 3-row skeleton
 *   - error:   compact 1-line hint pointing to
 *              /agents for diagnosis
 *   - ready:   the full card
 *   - no-match: the wc26 id doesn't resolve to a
 *              match in the cached data (e.g. the
 *              agents service is in a different
 *              network or the id is malformed);
 *              renders a single muted line so the
 *              page never has a hole
 */

import { useEffect, useMemo, useState } from "react";

const AGENTS_URL =
  process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";
const CACHE_KEY = "wc-team-analysis:v1";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h

type Tier = "elite" | "strong" | "competitive" | "underdog";

interface TeamRow {
  code: string;
  name: string;
  flag: string;
  confederation: string;
  pot: number;
  drawPosition: string;
  group: string;
  elo: number;
  tier: Tier;
  rank: number;
  winProbVsAvg: number;
}

interface MatchRow {
  id: string;
  group: string;
  matchday: 1 | 2 | 3;
  kickoffMs: number;
  homeCode: string;
  awayCode: string;
  homeName: string;
  homeFlag: string;
  homeElo: number;
  homeTier: Tier;
  awayName: string;
  awayFlag: string;
  awayElo: number;
  awayTier: Tier;
  homeWinProb: number;
  drawProb: number;
  awayWinProb: number;
  favorite: "home" | "away" | "toss-up";
  eloDiff: number;
}

interface TeamAnalysisResponse {
  generatedAtMs: number;
  teams: TeamRow[];
  matches: MatchRow[];
}

interface CacheEntry {
  fetchedAt: number;
  data: TeamAnalysisResponse;
}

const TIER_STYLES: Record<Tier, { pill: string; bar: string; label: string }> = {
  elite: {
    pill: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    bar: "bg-emerald-500",
    label: "Elite",
  },
  strong: {
    pill: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
    bar: "bg-cyan-500",
    label: "Strong",
  },
  competitive: {
    pill: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    bar: "bg-amber-500",
    label: "Competitive",
  },
  underdog: {
    pill: "bg-zinc-500/15 text-zinc-400 border-zinc-500/30",
    bar: "bg-zinc-500",
    label: "Underdog",
  },
};

function readCache(): TeamAnalysisResponse | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (!parsed?.data?.matches?.length) return null;
    if (Date.now() - parsed.fetchedAt > CACHE_TTL_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeCache(data: TeamAnalysisResponse): void {
  if (typeof window === "undefined") return;
  try {
    const entry: CacheEntry = { fetchedAt: Date.now(), data };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Quota exceeded (large response + other
    // tabs' state) — non-fatal, we just lose the
    // cache and re-fetch next time.
  }
}

async function fetchAnalysis(): Promise<TeamAnalysisResponse | null> {
  try {
    const r = await fetch(`${AGENTS_URL}/wc/team-analysis`, {
      cache: "no-store",
    });
    if (!r.ok) return null;
    const body = (await r.json()) as TeamAnalysisResponse;
    if (!body?.matches?.length) return null;
    return body;
  } catch {
    return null;
  }
}

function eloBarWidth(elo: number): number {
  // Normalize to [0, 100] using the realistic WC
  // range. The weakest 2026 team is CUW/KSA at
  // 1500; the strongest (ARG/FRA) is 1870. Use
  // 1400 as the floor and 1900 as the ceiling so
  // a hypothetical 1900+ team still maxes the bar
  // and a 1400- team shows 0%.
  const pct = ((elo - 1400) / (1900 - 1400)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function favoriteLabel(fav: "home" | "away" | "toss-up", homeName: string, awayName: string): string {
  if (fav === "home") return `${homeName} favored`;
  if (fav === "away") return `${awayName} favored`;
  return "Toss-up";
}

export function WcTeamAnalysisCard({ marketId }: { marketId: string }) {
  // The wc26 market id format is `wc26-<matchId>`
  // (e.g. `wc26-A1vA3`). Strip the prefix to look
  // the match up in the cached data. The match id
  // is the schedule's `WcMatch.id` field.
  const matchKey = marketId.startsWith("wc26-") ? marketId.slice("wc26-".length) : marketId;
  const [data, setData] = useState<TeamAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const cached = readCache();
    if (cached) {
      setData(cached);
      setLoading(false);
    }
    // Always revalidate in the background; the
    // cache is a 1h TTL but a re-draw could happen
    // mid-window. The cached value renders
    // instantly (no skeleton) and the revalidate
    // is silent on success.
    void (async () => {
      const fresh = await fetchAnalysis();
      if (!mounted) return;
      if (fresh) {
        setData(fresh);
        setError(null);
        writeCache(fresh);
      } else if (!cached) {
        setError("Couldn't reach the agents service");
      }
      setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const match = useMemo(
    () => data?.matches.find((m) => m.id === matchKey) ?? null,
    [data, matchKey],
  );

  // Skeleton state: only show a real skeleton on
  // the first paint (no cached data). The cached
  // path renders the card immediately even while
  // revalidating in the background.
  if (loading && !data) {
    return (
      <div
        aria-hidden="true"
        className="mt-4 rounded-xl border border-white/5 bg-black/20 p-4"
      >
        <div className="mb-3 h-3 w-32 animate-pulse rounded bg-white/10" />
        <div className="space-y-2.5">
          <div className="h-9 animate-pulse rounded-lg bg-white/[0.04]" />
          <div className="h-9 animate-pulse rounded-lg bg-white/[0.04]" />
          <div className="mt-3 h-7 animate-pulse rounded-lg bg-white/[0.04]" />
        </div>
      </div>
    );
  }

  // Error state: render a compact hint, not a hole
  // in the layout.
  if (error) {
    return (
      <div
        role="status"
        className="mt-4 rounded-xl border border-white/5 bg-black/20 px-4 py-2.5 text-[11px] text-zinc-500"
      >
        Team analysis unavailable · check{" "}
        <a href="/agents" className="text-cyan-400 hover:underline">
          agents service
        </a>
      </div>
    );
  }

  // No-match state: the wc26 id is well-formed
  // but the agents service doesn't know about the
  // match (e.g. a manual SQLite row that bypassed
  // the schedule). Render a single muted line so
  // the page never has a hole.
  if (!match) {
    return (
      <div className="mt-4 rounded-xl border border-white/5 bg-black/20 px-4 py-2.5 text-[11px] text-zinc-500">
        No team analysis for this match.
      </div>
    );
  }

  const homeStyle = TIER_STYLES[match.homeTier];
  const awayStyle = TIER_STYLES[match.awayTier];

  return (
    <div
      className="mt-4 rounded-xl border border-white/5 bg-black/20 p-4"
      // R-WC-2: signal to assistive tech that this
      // is supplementary read-only data. The
      // parent <Link> handles all click/keyboard
      // navigation; this card is a child landmark.
      role="group"
      aria-label={`Team analysis: ${match.homeName} vs ${match.awayName}`}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-500">
          📊 Team Analysis
        </span>
        <span className="text-[10px] font-mono text-zinc-500">
          Group {match.group} · MD{match.matchday}
        </span>
      </div>

      <div className="space-y-2.5">
        <TeamRow
          flag={match.homeFlag}
          name={match.homeName}
          elo={match.homeElo}
          tier={match.homeTier}
          pillClass={homeStyle.pill}
          barClass={homeStyle.bar}
        />
        <TeamRow
          flag={match.awayFlag}
          name={match.awayName}
          elo={match.awayElo}
          tier={match.awayTier}
          pillClass={awayStyle.pill}
          barClass={awayStyle.bar}
        />
      </div>

      {/* Head-to-head summary. The three probabilities
         sum to 1.0 (enforced in the agent route's
         tests) so the stacked bar fills the track
         exactly. */}
      <div className="mt-3 rounded-lg border border-white/5 bg-white/[0.02] p-3">
        <div className="flex items-center justify-between text-[11px] font-semibold text-zinc-300">
          <span>
            {favoriteLabel(match.favorite, match.homeName, match.awayName)}
          </span>
          <span className="font-mono text-[10px] text-zinc-500">
            Elo {match.eloDiff > 0 ? "+" : ""}
            {match.eloDiff}
          </span>
        </div>
        {/* R-WC-2: stacked probability bar. The
           three segments use flex-basis: 0 +
           flex-grow: <pct> so the proportions are
           faithful to the underlying numbers
           (e.g. a 70/18/12 split fills 70% / 18%
           / 12% of the track, not 70% / 18% / 12%
           of the leftover space). */}
        <div className="mt-2 flex h-2 w-full overflow-hidden rounded-full bg-black/40">
          <div
            className="bg-emerald-500"
            style={{ flexGrow: match.homeWinProb, flexBasis: 0 }}
            aria-label={`${match.homeName} win probability`}
          />
          <div
            className="bg-zinc-500"
            style={{ flexGrow: match.drawProb, flexBasis: 0 }}
            aria-label="draw probability"
          />
          <div
            className="bg-rose-500"
            style={{ flexGrow: match.awayWinProb, flexBasis: 0 }}
            aria-label={`${match.awayName} win probability`}
          />
        </div>
        <div className="mt-1.5 flex justify-between text-[10px] text-zinc-500">
          <span className="text-emerald-400">{pct(match.homeWinProb)}</span>
          <span className="text-zinc-400">Draw {pct(match.drawProb)}</span>
          <span className="text-rose-400">{pct(match.awayWinProb)}</span>
        </div>
      </div>
    </div>
  );
}

function TeamRow({
  flag,
  name,
  elo,
  tier,
  pillClass,
  barClass,
}: {
  flag: string;
  name: string;
  elo: number;
  tier: Tier;
  pillClass: string;
  barClass: string;
}) {
  const tierLabel = TIER_STYLES[tier].label;
  return (
    <div className="flex items-center gap-3">
      <span className="text-2xl leading-none" aria-hidden="true">
        {flag}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-white">
            {name}
          </span>
          <span
            className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${pillClass}`}
          >
            {tierLabel}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/40"
            aria-hidden="true"
          >
            <div
              className={`h-full ${barClass}`}
              style={{ width: `${eloBarWidth(elo)}%` }}
            />
          </div>
          <span className="shrink-0 font-mono text-[10px] text-zinc-400">
            {elo} Elo
          </span>
        </div>
      </div>
    </div>
  );
}
