/**
 * "How it works" 3-step explainer. Rendered on the
 * home page (and available to embed anywhere via a
 * prop flag) so a first-time user has a clear mental
 * model of the SuiPredict flow before they connect a
 * wallet. The card collapses to a single row on
 * mobile and the icon step badges stay readable down
 * to ~360px viewport widths (the same breakpoint
 * the rest of the app targets).
 *
 * R61 audit fix: prior build relied on the home
 * page's gamification row to teach the user, but
 * the row only renders meaningful content AFTER a
 * wallet connect. A user landing on `/` with no
 * wallet saw a "Connect a wallet to start" empty
 * state and no onboarding hint. The HowItWorks
 * card is the unconditional onboarding surface —
 * always visible, regardless of wallet state.
 */

import Link from "next/link";
import { Card } from "@/components/ui";

const STEPS: Array<{
  badge: string;
  title: string;
  body: string;
  href?: string;
  hrefLabel?: string;
}> = [
  {
    badge: "1",
    title: "Mint shares",
    body:
      "Pick a market. Convert DUSDC into a matched pair of YES + NO shares. " +
      "Every 1 DUSDC gives you 1 of each.",
    href: "/markets",
    hrefLabel: "Browse markets",
  },
  {
    badge: "2",
    title: "Trade on the CLOB",
    body:
      "Sell the side you don't want on the DeepBook V3 order book, or buy more " +
      "of the side you do. Live mid-prices + spreads, in-app.",
    href: "/worldcup",
    hrefLabel: "Try World Cup markets",
  },
  {
    badge: "3",
    title: "Redeem on resolution",
    body:
      "After a market expires, the autonomous resolver commits the outcome on-chain. " +
      "Winning shares redeem 1-for-1 into DUSDC. Streaks boost your winnings up to 3x.",
    href: "/leaderboard",
    hrefLabel: "See the leaderboard",
  },
];

export function HowItWorks({
  className = "",
  variant = "card",
}: {
  className?: string;
  /**
   * `card` wraps the steps in a glass card. `inline`
   * strips the wrapper and just renders the steps —
   * useful when embedded in a header / hero.
   */
  variant?: "card" | "inline";
}) {
  const stepsEl = (
    <ol className="grid gap-4 sm:grid-cols-3">
      {STEPS.map((s) => (
        <li
          key={s.badge}
          className="relative rounded-2xl border border-white/10 bg-white/[0.03] p-5"
        >
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-cyan-500/20 to-violet-500/20 text-sm font-bold text-white border border-white/10">
            {s.badge}
          </div>
          <h3 className="text-base font-bold text-white">{s.title}</h3>
          <p className="mt-2 text-sm text-zinc-400">{s.body}</p>
          {s.href && s.hrefLabel && (
            <Link
              href={s.href}
              className="mt-3 inline-flex items-center gap-1 text-xs font-bold text-cyan-300 hover:text-cyan-200 transition"
            >
              {s.hrefLabel} →
            </Link>
          )}
        </li>
      ))}
    </ol>
  );

  if (variant === "inline") return <div className={className}>{stepsEl}</div>;

  return (
    <Card className={`border-white/10 ${className}`}>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-extrabold text-white">How SuiPredict works</h2>
          <p className="text-xs text-zinc-500">Three steps. Three transactions. One wallet.</p>
        </div>
        <Link
          href="/markets"
          className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition"
        >
          Get started →
        </Link>
      </div>
      {stepsEl}
    </Card>
  );
}
