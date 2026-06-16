"use client";

/**
 * Daily World Cup card.
 *
 * Picks the 5 next-upcoming group matches (in the next 48h) and
 * presents them as 1-tap YES/NO quick picks. Each YES/NO tap
 * deep-links to the market detail page with the side
 * pre-selected, where the user signs a single PTB per market.
 *
 * We deliberately do NOT batch the mints in this widget: the
 * underlying `buildMintSharesBatchTx` requires the user to pass a
 * real owned DBUSDC coin id, and the wallet UI flow for picking
 * one is awkward on mobile. The per-market "pick & confirm"
 * flow (already battle-tested on the markets/[id] page) gives a
 * cleaner mobile UX with one transaction per market and a
 * "place all" CTA at the bottom that links to the all-WC list.
 */

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { listMarkets } from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { LivePulse } from "@/components/LivePulse";

interface WcMatchLite {
  id: string;
  title: string;
  // R61 audit fix: surface `kickoff_ms` so the
  // "X until kickoff" label is accurate. The
  // previous build took `expiry_ms` (which is
  // actually `kickoff + 2h` per the WC contract)
  // and labeled the resulting diff as "until
  // kickoff" — a 2-hour off-by-one that misled
  // users about when the market was about to
  // start. The `kickoff_ms` field is computed by
  // the agents `rowToMarket` (R61) so the WC
  // market category's 2-hour offset is correct.
  kickoff_ms: number;
  expiry_ms: number;
}

const DEFAULT_LIMIT = 5;

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

export function DailyWcCard() {
  const wcQuery = useQuery({
    queryKey: ["dailyWcMarkets"],
    staleTime: 30_000,
    queryFn: async (): Promise<WcMatchLite[]> => {
      const markets = await listMarkets();
      const now = Date.now();
      const horizon = now + 48 * 60 * 60 * 1000;
      return markets
        .filter(
          (m) =>
            m.category === "worldcup" &&
            m.status === "active" &&
            // Filter on the kickoff time, not the
            // expiry time, so a market whose kickoff
            // is in 47h but whose resolution is in 49h
            // is still surfaced in the 48h ticker.
            // `kickoff_ms` is only set for WC markets
            // (R61 audit fix); a future category that
            // wants the same field can derive it
            // similarly.
            m.kickoff_ms !== undefined &&
            m.kickoff_ms > now &&
            m.kickoff_ms <= horizon,
        )
        .sort((a, b) => (a.kickoff_ms ?? 0) - (b.kickoff_ms ?? 0))
        .slice(0, DEFAULT_LIMIT)
        .map((m) => ({
          id: m.id,
          title: m.title,
          // R61 audit fix: trust the SDK's
          // `kickoff_ms` derivation. The fallback
          // `expiry_ms - 2h` is only here for
          // robustness — a row written by a
          // pre-R61 agents service won't have
          // the field set, and the user still
          // wants a sensible "until kickoff"
          // label rather than a blank string.
          kickoff_ms: m.kickoff_ms ?? m.expiry_ms - 2 * 60 * 60 * 1000,
          expiry_ms: m.expiry_ms,
        }));
    },
  });

  return (
    <Card className="border-emerald-500/20 bg-gradient-to-b from-emerald-900/10 to-panel">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-extrabold text-white">
              <span>⚽</span>
              <span>Daily World Cup</span>
              <LivePulse color="emerald" label="Live" />
            </h2>
            <p className="text-xs text-zinc-500">
              Next 5 group matches · tap YES/NO to predict
            </p>
          </div>
          <Link
            href="/worldcup"
            className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30"
          >
            All WC →
          </Link>
        </div>

        {wcQuery.isLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-20 animate-pulse rounded-xl bg-white/5" />
            ))}
          </div>
        )}

        {wcQuery.isError && (
          <div
            role="alert"
            className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
          >
            <p className="font-semibold">Couldn&apos;t load World Cup markets</p>
            <p className="mt-1 text-rose-300/80">
              {wcQuery.error instanceof Error
                ? wcQuery.error.message
                : "Unknown error"}. Start the agents service with{" "}
              <code className="text-xs">pnpm dev:agents</code>.
            </p>
          </div>
        )}

        {wcQuery.data && wcQuery.data.length === 0 && (
          <p className="rounded-xl border border-dashed border-white/10 bg-white/5 p-6 text-center text-sm text-zinc-400">
            No World Cup matches in the next 48h. The agents will seed
            markets 7 days before each fixture.
          </p>
        )}

        {wcQuery.data && wcQuery.data.length > 0 && (
          <ul className="space-y-3">
            {wcQuery.data.map((m) => (
              <li
                key={m.id}
                className="rounded-xl border border-white/10 bg-panel p-3"
              >
                <Link
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="block text-sm font-semibold text-white hover:text-emerald-300 line-clamp-2"
                >
                  {m.title}
                </Link>
                {/* R61 audit fix: 1-tap YES/NO deep-link
                    buttons. The pre-R61 card was a
                    pure read-only list — the user had
                    to drill into the market detail page
                    to even *see* a trade panel. The
                    buttons deep-link to the market with
                    the side pre-selected via the
                    `?side=...&order=buy` query the
                    markets/[id] page reads (it ignores
                    unknown params, so the link is
                    forward-compatible with a future
                    auto-fill pass). The visible label
                    also tells the user what they're
                    betting on without forcing a second
                    tap to read the title. */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <Link
                    href={`/markets/${encodeURIComponent(m.id)}?side=yes&order=buy`}
                    className="rounded-lg bg-emerald-500/20 px-3 py-2 text-center text-xs font-bold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition"
                  >
                    YES
                  </Link>
                  <Link
                    href={`/markets/${encodeURIComponent(m.id)}?side=no&order=buy`}
                    className="rounded-lg bg-rose-500/20 px-3 py-2 text-center text-xs font-bold text-rose-300 border border-rose-500/30 hover:bg-rose-500/30 transition"
                  >
                    NO
                  </Link>
                </div>
                <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
                  <span className="uppercase tracking-wider">
                    {/* R62 audit fix: distinguish
                       matches that have already
                       started from those kicking
                       off soon. The pre-R62 code
                       unconditionally rendered
                       "{kickoffIn(...)} until
                       kickoff" — for an in-play
                       match the diff is negative
                       and `kickoffIn` returned the
                       literal string "kickoff",
                       which read as "kickoff
                       until kickoff". Now we
                       branch on `m.kickoff_ms
                       <= now` and render
                       "Live now" for the in-play
                       case, and colour the
                       "starting in <1h" case
                       amber to nudge the user to
                       the YES/NO buttons. */}
                    {m.kickoff_ms <= Date.now()
                      ? <span className="font-bold text-rose-300">Live now</span>
                      : m.kickoff_ms - Date.now() < 60 * 60 * 1000
                        ? <span className="font-bold text-amber-300">Starts in {kickoffIn(m.kickoff_ms)}</span>
                        : <span>{kickoffIn(m.kickoff_ms)} until kickoff</span>}
                  </span>
                  <Link
                    href={`/markets/${encodeURIComponent(m.id)}`}
                    className="font-bold text-emerald-400 hover:text-emerald-300"
                  >
                    Details →
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}

        {wcQuery.data && wcQuery.data.length > 0 && (
          <Link
            href="/markets?category=worldcup"
            className="block w-full min-h-12 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-center text-sm font-bold text-emerald-300 hover:bg-emerald-500/20 transition"
          >
            See all WC markets →
          </Link>
        )}
      </div>
    </Card>
  );
}
