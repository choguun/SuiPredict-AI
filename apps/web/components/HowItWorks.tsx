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
 *
 * R30 sweep fix: the home page only rendered this
 * card when `markets.length === 0`, so any deploy
 * with seeded demo markets hid the onboarding
 * entirely. The new `HowItWorksDismissable` wrapper
 * shows the card once for first-time visitors
 * (gated by localStorage), dismissable forever
 * via the X button. The plain `HowItWorks` is
 * still exported for the empty-markets fallback.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
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

  // return (
  //   <Card className={`border-white/10 ${className}`}>
  //     <div className="mb-4 flex items-center justify-between">
  //       <div>
  //         <h2 className="text-lg font-extrabold text-white">How SuiPredict works</h2>
  //         <p className="text-xs text-zinc-500">Three steps. Three transactions. One wallet.</p>
  //       </div>
  //       <Link
  //         href="/markets"
  //         className="shrink-0 rounded-lg bg-emerald-500/20 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition"
  //       >
  //         Get started →
  //       </Link>
  //     </div>
  //     {stepsEl}
  //   </Card>
  // );
}

const HOW_IT_WORKS_DISMISSED_KEY = "suipredict.howItWorks.dismissed";

/**
 * Dismissable wrapper. Renders the HowItWorks card once
 * per browser (localStorage-gated). A returning user
 * who dismissed it never sees it again. The mounted-ref
 * pattern avoids an SSR/CSR flash — the card only
 * appears after the client-side mount reads localStorage.
 */
export function HowItWorksDismissable() {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setMounted(true);
    try {
      if (window.localStorage.getItem(HOW_IT_WORKS_DISMISSED_KEY) === "1") {
        setDismissed(true);
      }
    } catch {
      // private mode / quota — default to showing the card
    }
  }, []);
  if (!mounted || dismissed) return null;
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => {
          try {
            window.localStorage.setItem(HOW_IT_WORKS_DISMISSED_KEY, "1");
          } catch {
            // private mode — dismissal only lasts this session
          }
          setDismissed(true);
        }}
        aria-label="Dismiss how-it-works card"
        className="absolute right-3 top-3 z-10 rounded-md p-1.5 text-zinc-500 hover:bg-white/10 hover:text-white transition"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
        </svg>
      </button>
      <HowItWorks />
    </div>
  );
}
