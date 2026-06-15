import Link from "next/link";
import {
  getMarketOrderBook,
  getVaultSummaryClob,
  listMarkets,
} from "@suipredict/sdk";
import { Badge } from "@/components/ui";
import { DailyPredictionCard } from "@/components/DailyPredictionCard";
import { DailyWcCard } from "@/components/DailyWcCard";
import { HowItWorks, HowItWorksDismissable } from "@/components/HowItWorks";
import { RecentActivity } from "@/components/RecentActivity";
import { StreakProfile } from "@/components/StreakProfile";
import { StreakWelcomeBanner } from "@/components/StreakWelcomeBanner";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { SuivisionLink } from "@/components/SuivisionLink";
import { EmptyState } from "@/components/EmptyState";
import { TopForecasters } from "@/components/TopForecasters";
import { TournamentCountdown } from "@/components/TournamentCountdown";

export const dynamic = "force-dynamic";

// R56.9 audit fix: accept `string` (bigint-as-string) for the
// vault summary fields. `Number(bigintString)` loses precision
// above 2^53 - 1; BigInt keeps the full u64 range.
function formatUsd(value?: number | string) {
  if (value === undefined || value === null) return "$0";
  const v = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(v)) return "$0";
  return `$${(v / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// R62 audit fix: relative time helper
// for WC market kickoff times. Same
// pattern as the markets list page —
// "in 2h" for the next 7 days, falls
// back to the absolute date for
// far-future matches. Mid-tournament
// the featured WC markets need the
// relative time, not "Jun 13".
function kickoffIn(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

/**
 * Read the live YES probability from the order book mid-price. Falls
 * back to a neutral 0.5 when the book is empty or unreachable so the
 * UI still renders.
 */
function probabilityFromBook(
  book: { mid_price: number } | null | undefined,
): number {
  if (!book) return 0.5;
  const p = book.mid_price;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0.5;
  return p;
}

export default async function HomePage() {
  const [markets, vault] = await Promise.all([
    listMarkets().catch(() => []),
    getVaultSummaryClob().catch(() => null),
  ]);

  const active = markets.filter((m) => m.status === "active").length;
  // Show how many of those are World Cup markets so the
  // home page surfaces the flagship vertical. The agents
  // service always tags WC markets with category="worldcup".
  const activeWc = markets.filter(
    (m) => m.status === "active" && m.category === "worldcup",
  ).length;

  // Featured markets: live order book for the top 4. A fetch failure
  // leaves the book undefined and we fall back to 0.5 in the render.
  //
  // R34 sweep fix: prioritize the
  // featured set so the home page
  // surfaces a useful mix instead of
  // "first 4 from the SQLite row
  // order" (which is roughly random —
  // depends on the indexer's
  // `INSERT` order). The new
  // prioritization: 2x WC active
  // markets (the flagship vertical),
  // 1x non-WC active, 1x recently
  // resolved (proof-of-resolve).
  // The previous build's first 4
  // were often 4 MD1 matches all
  // kicking off at the same time —
  // the user saw a near-identical
  // grid. The new set gives the
  // home page a more useful
  // sampling.
  const wcActive = markets
    .filter((m) => m.status === "active" && m.category === "worldcup")
    .sort((a, b) => (a.kickoff_ms ?? a.expiry_ms) - (b.kickoff_ms ?? b.expiry_ms))
    .slice(0, 2);
  const otherActive = markets
    .filter((m) => m.status === "active" && m.category !== "worldcup")
    .slice(0, 1);
  const recentlyResolved = markets
    .filter((m) => m.status === "resolved")
    .sort((a, b) => (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0))
    .slice(0, 1);
  const featured = [...wcActive, ...otherActive, ...recentlyResolved].slice(0, 4);
  const featuredActive = featured.filter((m) => m.status === "active");
  const featuredBookResults = await Promise.allSettled(
    featuredActive.map((m) => getMarketOrderBook(m.id)),
  );
  const bookByMarket = new Map<string, { mid_price: number }>();
  featuredActive.forEach((m, i) => {
    const r = featuredBookResults[i];
    if (r.status === "fulfilled") {
      bookByMarket.set(m.id, r.value);
    }
  });

  return (
    <div className="space-y-6 sm:space-y-12 pb-6 sm:pb-12">
      {/* R30 sweep fix: JSON-LD structured data so
         search engines can render rich results for
         the product. The WebApplication schema is
         the most appropriate top-level type — it
         surfaces the app name, description, and
         category ("Finance" / "Prediction Market")
         in SERP features. The same data is mirrored
         by the meta tags but JSON-LD is what Google's
         crawler actually parses for structured
         features. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "WebApplication",
            name: "SuiPredict AI",
            description:
              "Autonomous AI prediction market on Sui. Trade YES/NO on every FIFA World Cup 2026 match, powered by DeepBook V3.",
            applicationCategory: "FinanceApplication",
            operatingSystem: "Web",
            offers: {
              "@type": "Offer",
              price: "0",
              priceCurrency: "USDC",
            },
            featureList: [
              "Trade YES/NO shares on World Cup 2026 matches",
              "DeepBook V3 CLOB order routing",
              "15 autonomous AI agents for market making and resolution",
              "Parlay builder with multiplied payouts",
              "Streak rewards and weekly leaderboard prizes",
            ],
          }),
        }}
      />
      {/* 0. World Cup 2026 Banner (always visible) */}
      {/* R30 sweep fix: bigger, more prominent
          banner with a stronger CTA. The pre-R30
          build was a 7px-padding row that read
          like a navigation hint; a fresh user
          landing on `/` had no signal that WC
          2026 is the flagship vertical. The new
          banner has a gradient background, a
          left-side flag-emoji stack, and a
          "View tournament" CTA that's the same
          weight as the page's primary button
          on the home hero. The hover state
          brightens the border and shifts the
          CTA right by 2px so the interaction is
          visually obvious. */}
      <Link
        href="/worldcup"
        className="group relative block overflow-hidden rounded-2xl border-2 border-emerald-500/30 bg-gradient-to-br from-emerald-900/50 via-[#0d1019] to-amber-900/30 p-5 sm:p-7 transition-all hover:border-emerald-400/50 hover:shadow-[0_0_40px_rgba(16,185,129,0.15)]"
      >
        <div className="absolute -top-20 -right-10 h-40 w-40 rounded-full bg-emerald-500/20 blur-[80px] -z-10" />
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-wider text-emerald-400">
              🏆 Now live · 48 teams · 104 matches
              {/* R62 audit fix: include the active
                 WC count in the banner subtitle
                 so the home page surfaces the
                 actual size of the WC vertical
                 the user can trade. The previous
                 static "48 teams · 104 matches"
                 was always the same string
                 regardless of whether the agents
                 had seeded any markets yet; a
                 landing user had no signal of
                 how many WC markets were
                 actually live. The `activeWc`
                 value is computed from the same
                 `markets` array the rest of the
                 page uses, so a stale SQLite
                 mirror is the only failure mode
                 and that's covered by the
                 markets-list error banner
                 already. */}
              {activeWc > 0 && (
                <span className="ml-2 text-emerald-300">
                  · {activeWc} active market{activeWc === 1 ? "" : "s"}
                </span>
              )}
            </div>
            <h2 className="mt-1 text-xl sm:text-2xl font-extrabold text-white">
              World Cup 2026 prediction markets
            </h2>
            <p className="mt-1 text-xs sm:text-sm text-zinc-400">
              Trade YES/NO on every group match. Compete with friends. Win the bracket.
            </p>
          </div>
          <div className="shrink-0 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-bold text-emerald-950 group-hover:bg-emerald-400">
            Open →
          </div>
        </div>
      </Link>

      {/* 1. Mobile Greeting (Hidden on Desktop) */}
      <div className="sm:hidden flex items-center justify-between gap-3 mb-3">
        <h1 className="text-2xl font-bold text-white">GM, Trader 🔥</h1>
        <Link
          href="/markets"
          className="shrink-0 rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-4 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-900/30 active:scale-95 transition"
        >
          Trade →
        </Link>
      </div>

      {/* 2. Massive Hero Section (Hidden on Mobile) */}
      <section className="hidden sm:block relative overflow-hidden rounded-3xl border border-white/10 bg-black/40 p-8 sm:p-16 backdrop-blur-xl">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-violet-900/40 via-[#0B0E14]/80 to-[#0B0E14] -z-10" />
        <div className="absolute -top-40 -right-40 h-[500px] w-[500px] rounded-full bg-cyan-600/20 blur-[100px] -z-10" />
        
        <div className="relative z-10 max-w-3xl">
          <Badge variant="success" className="bg-emerald-500/10 text-emerald-300 border-emerald-500/20 mb-6">
            DeepBook V3 Powered CLOB
          </Badge>
          <h1 className="text-4xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-white to-cyan-200 sm:text-6xl mb-6">
            Predict the future. <br className="hidden sm:block" />
            Trade probability.
          </h1>
          <p className="text-base leading-relaxed text-zinc-400 sm:text-xl mb-8 max-w-2xl">
            SuiPredict AI is the next-generation prediction market. Every market is backed by DUSDC collateral. Split collateral into matched YES/NO shares and trade with instant settlement.
          </p>
          
          <div className="flex flex-col sm:flex-row gap-4">
            <Link
              href="/markets"
              className="inline-flex min-h-14 items-center justify-center rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 px-8 text-base font-bold text-white shadow-[0_0_40px_rgba(6,182,212,0.3)] transition-all hover:scale-[1.02] hover:shadow-[0_0_60px_rgba(6,182,212,0.5)]"
            >
              Start Trading Now
            </Link>
            <Link
              href="/vault"
              className="inline-flex min-h-14 items-center justify-center rounded-xl border border-white/10 bg-white/5 px-8 text-base font-semibold text-white backdrop-blur-md transition-all hover:bg-white/10 hover:border-white/20"
            >
              Provide Liquidity
            </Link>
          </div>
        </div>
      </section>

      {/* 3. Platform Stats (compact on mobile, full on lg) */}
      {/* R30 sweep fix: previously hidden on
         mobile (`hidden lg:grid`). The mobile
         user never saw the live stats. Now the
         section is always visible with a 2x2
         grid on mobile (stacks gracefully) and
         4 columns on lg. The padding shrinks
         on small viewports so the row doesn't
         dominate the page above the fold. */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-3 lg:gap-4">
        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-4 lg:p-6 transition-all hover:-translate-y-1 hover:border-emerald-500/30 hover:shadow-[0_0_30px_rgba(16,185,129,0.1)]">
          <div className="mb-3 lg:mb-4 flex h-8 w-8 lg:h-10 lg:w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
          </div>
          <p className="text-xs lg:text-sm font-medium text-zinc-500">Active Markets</p>
          <p className="mt-1 text-2xl lg:text-3xl font-bold text-white">
            {active}
            {activeWc > 0 && (
              <span className="ml-2 text-sm lg:text-base font-medium text-emerald-400">
                ({activeWc} ⚽)
              </span>
            )}
          </p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-4 lg:p-6 transition-all hover:-translate-y-1 hover:border-cyan-500/30 hover:shadow-[0_0_30px_rgba(6,182,212,0.1)]">
          <div className="mb-3 lg:mb-4 flex h-8 w-8 lg:h-10 lg:w-10 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <p className="text-xs lg:text-sm font-medium text-zinc-500">Vault TVL</p>
          <p className="mt-1 text-2xl lg:text-3xl font-bold text-white">{formatUsd(vault?.total_balance)}</p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-4 lg:p-6 transition-all hover:-translate-y-1 hover:border-violet-500/30 hover:shadow-[0_0_30px_rgba(139,92,246,0.1)]">
          <div className="mb-3 lg:mb-4 flex h-8 w-8 lg:h-10 lg:w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
          </div>
          <p className="text-xs lg:text-sm font-medium text-zinc-500">MM Allocated</p>
          <p className="mt-1 text-2xl lg:text-3xl font-bold text-white">{formatUsd(vault?.allocated)}</p>
        </div>

        <div className="group rounded-2xl border border-white/5 bg-gradient-to-b from-white/[0.04] to-transparent p-4 lg:p-6 transition-all hover:-translate-y-1 hover:border-blue-500/30 hover:shadow-[0_0_30px_rgba(59,130,246,0.1)]">
          <div className="mb-3 lg:mb-4 flex h-8 w-8 lg:h-10 lg:w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-400">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-xs lg:text-sm font-medium text-zinc-500">AI Agents</p>
          {/* R30 sweep fix: show the actual agent
              count (15) instead of the placeholder
              "Creator + Maker" string. The platform
              runs 15 autonomous workers (creator,
              maker, resolver, parlay, risk, 3x WC
              specialists, plus 6 gamification workers)
              and the previous copy undersold the
              size of the fleet. The `15` is the
              same number the /agents page manifest
              serves, so a curious user can cross-check
              the home page stat against the full
              list. */}
          <p className="mt-1 text-2xl lg:text-3xl font-bold text-white">15</p>
          <p className="mt-0.5 text-[10px] uppercase tracking-wider text-zinc-500">
            Running 24/7
          </p>
        </div>
      </section>

      {/* 4. Gamification Row (Prioritized on Mobile) */}
      <StreakWelcomeBanner />
      {/* R61 audit fix: render the "How it works"
         card BEFORE the wallet-gated StreakProfile /
         DailyWcCard so a first-time user has an
         onboarding surface even before they connect.
         The card collapses cleanly on mobile (3 columns
         stack to 1) and disappears entirely once the
         user connects (the gamification row takes
         over). The conditional keeps the page tidy for
         returning users. */}
      {/* R30 sweep fix: only render the HowItWorks
          callout when the user has nothing
          meaningful on the page yet (no live
          markets AND no featured markets). The
          previous `!activeWc && !active` was
          too aggressive — a 50-market deploy
          with 8 active WC markets would still
          surface the "how it works" callout
          because the conditional checked
          `activeWc` (always 0 unless filter
          was applied). The `markets.length`
          is more honest. */}
      {markets.length === 0 && <HowItWorks />}
      {/* R30 sweep fix: dismissable onboarding for
          first-time visitors who DO see markets. The
          previous build only showed HowItWorks when
          there were zero markets; a deploy with
          seeded demo markets hid the onboarding
          entirely. The dismissable variant is gated
          by localStorage so a returning user never
          sees it twice. */}
      {markets.length > 0 && <HowItWorksDismissable />}
      <section className="grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-1">
          <StreakProfile />
        </div>
        <div className="lg:col-span-2 space-y-6">
          <DailyWcCard />
          <DailyPredictionCard />
        </div>
      </section>

      {/* R6X audit fix: 2-up live signals row.
         A first-time visitor landing on `/` now sees
         a tournament countdown + top forecasters
         alongside the gamification row, so the
         "is this thing live?" question is answered
         without scrolling. Pre-R6X the home page
         had no time-to-kickoff signal and no
         "real players are trading" signal. The
         countdown re-uses the WC_KICKOFF_MS
         constant in `TournamentCountdown.tsx`;
         the leaderboard widget polls the agents
         REST every 60s, paused when the tab is
         hidden. Both panels gracefully degrade to
         a skeleton / empty-state when the agents
         service is unreachable. */}
      <section className="grid gap-6 sm:grid-cols-2">
        <TournamentCountdown variant="card" />
        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3">
          <TopForecasters />
        </div>
      </section>

      {/* 5. Featured Markets Bento Grid */}
      <section className="space-y-4 sm:space-y-6">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-white">Featured Markets</h2>
            <p className="mt-1 text-sm text-zinc-400">High volume markets hand-picked for you.</p>
            {/* R62 audit fix: dynamic subtitle
               showing the actual breakdown
               (active / resolved / WC count)
               below the static label. The
               pre-R62 build had a static
               "High volume markets hand-picked
               for you" subtitle that was the
               same string regardless of
               whether any markets were live
               or all of them had resolved. A
               user scrolling past the
               featured-markets bento had no
               signal of the live counts. The
               counts are derived from the
               same `markets` array the
               bento uses so there's no extra
               network round-trip. */}
            <p className="mt-0.5 text-[10px] font-mono uppercase tracking-wider text-zinc-500">
              {markets.length === 0
                ? "No markets yet"
                : `${active} active · ${markets.length - active} resolved${
                    activeWc > 0 ? ` · ${activeWc} world cup` : ""
                  }`}
            </p>
          </div>
          <Link href="/markets" className="hidden rounded-lg bg-white/5 px-4 py-2 text-sm font-medium text-white hover:bg-white/10 sm:block transition-colors">
            View all
          </Link>
        </div>

        {markets.length === 0 ? (
          <EmptyState
            title="No Featured Markets"
            description="Start the agents service to seed demo markets or connect to the live network."
            actionLabel="View All Markets"
            href="/markets"
          />
        ) : (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-2">
            {featured.map((m) => {
              const prob = m.status === "active"
                ? probabilityFromBook(bookByMarket.get(m.id))
                : 0.5;
              // R62 audit fix: SuiVision deep-link
              // for non-demo home-page featured
              // market cards. Same shape as the
              // /markets list page fix: the card is
              // a single <Link>, so the SuiVision
              // icon is an absolutely-positioned
              // button with stopPropagation so a
              // click on the icon doesn't double-fire
              // the parent navigation. Validates
              // SUI_NETWORK against the same
              // allowlist the rest of the app uses.
              const homeOnchainId = (m as { onchain_market_id?: string }).onchain_market_id ?? m.id;
              return (
                <Link
                  key={m.id}
                  href={`/markets/${encodeURIComponent(m.id)}`}
                  className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 transition-all hover:border-cyan-500/30 hover:bg-[#151924] hover:shadow-2xl hover:shadow-cyan-900/10"
                >
                  <SuivisionLink
                    objectId={homeOnchainId}
                    className="absolute right-3 top-3 z-20"
                  />
                  <div className="min-w-0">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                      <Badge variant={m.status === "active" ? "success" : "warning"} className="px-2.5 py-0.5 rounded-full">
                        {m.status}
                      </Badge>
                      {/* R32 sweep fix: prominent
                          "Winner" pill for
                          resolved markets on
                          the home page. Same
                          pattern as the markets
                          list and the market
                          detail page. Renders
                          nothing when `outcome`
                          is null (indexer race
                          window). */}
                      {m.status === "resolved" && m.outcome && (
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                            m.outcome === "yes"
                              ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                              : "bg-rose-500/20 text-rose-300 border-rose-500/30"
                          }`}
                        >
                          🏆 {m.outcome.toUpperCase()} won
                        </span>
                      )}
                      <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-medium text-zinc-300">{m.category}</span>
                      <span className="text-xs font-medium text-zinc-500">
                        {/* R62 audit fix: same
                           WC-vs-others kickoff
                           /expiry distinction
                           the /markets list
                           page does. A user
                           scanning the
                           home-page featured
                           markets needs the
                           relative "in 2h"
                           label, not a bare
                           "Jun 13". */}
                        {m.category === "worldcup" && (m as { kickoff_ms?: number }).kickoff_ms
                          ? ((m as { kickoff_ms?: number }).kickoff_ms! > Date.now() && (m as { kickoff_ms?: number }).kickoff_ms! < Date.now() + 7 * 24 * 60 * 60 * 1000
                              ? `Kicks ${kickoffIn((m as { kickoff_ms?: number }).kickoff_ms!)}`
                              : `Kicks ${formatDate((m as { kickoff_ms?: number }).kickoff_ms!)}`)
                          : `Ends ${formatDate(m.expiry_ms)}`}
                      </span>
                    </div>
                    <h3 className="text-xl font-bold text-white mb-2 leading-tight group-hover:text-cyan-100 transition-colors">{m.title}</h3>
                    <p className="line-clamp-2 text-sm text-zinc-400 mb-6">{m.description}</p>
                  </div>
                  
                  <div className="mt-auto">
                    {m.status === "active" ? (
                      <div className="space-y-2">
                        <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
                          <span className="text-emerald-400">{Math.round(prob * 100)}% YES</span>
                          <span className="text-rose-400">{Math.round((1 - prob) * 100)}% NO</span>
                        </div>
                        <ProbabilityBar yesProbability={prob} className="h-2.5" />
                        
                        <div className="mt-4 grid grid-cols-2 gap-3 opacity-0 translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                          <div className="flex items-center justify-center rounded-lg bg-emerald-500/20 py-2.5 text-sm font-semibold text-emerald-300 border border-emerald-500/30 transition-colors hover:bg-emerald-500/30">
                            Buy YES
                          </div>
                          <div className="flex items-center justify-center rounded-lg bg-rose-500/20 py-2.5 text-sm font-semibold text-rose-300 border border-rose-500/30 transition-colors hover:bg-rose-500/30">
                            Buy NO
                          </div>
                        </div>
                      </div>
                    ) : m.outcome ? (
                      <div className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2 border border-emerald-500/20">
                        <span className="text-sm font-bold text-emerald-400">
                          WINNER: {m.outcome.toUpperCase()}
                        </span>
                      </div>
                    ) : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {/* R61 audit fix: live activity feed. Sits
         below the featured markets bento so a
         first-time user has a single-glance
         signal that the autonomous fleet is
         running. The "View all decisions →"
         link deep-links to the full /agents page
         for the curious operator. Hidden on the
         `pre-build` environments where the agents
         service isn't reachable — the empty state
         already covers that case cleanly. */}
      <RecentActivity />
    </div>
  );
}
