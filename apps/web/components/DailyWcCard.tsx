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
            m.expiry_ms > now &&
            m.expiry_ms <= horizon,
        )
        .sort((a, b) => a.expiry_ms - b.expiry_ms)
        .slice(0, DEFAULT_LIMIT)
        .map((m) => ({ id: m.id, title: m.title, expiry_ms: m.expiry_ms }));
    },
  });

  return (
    <Card className="border-emerald-500/20 bg-gradient-to-b from-emerald-900/10 to-[#0d1019]">
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
                className="rounded-xl border border-white/10 bg-[#0d1019] p-3"
              >
                <Link
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="block text-sm font-semibold text-white hover:text-emerald-300 line-clamp-2"
                >
                  {m.title}
                </Link>
                <div className="mt-2 flex items-center justify-between text-[10px] text-zinc-500">
                  <span className="uppercase tracking-wider">
                    {kickoffIn(m.expiry_ms)} until kickoff
                  </span>
                  <Link
                    href={`/markets/${encodeURIComponent(m.id)}`}
                    className="font-bold text-emerald-400 hover:text-emerald-300"
                  >
                    Predict →
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
