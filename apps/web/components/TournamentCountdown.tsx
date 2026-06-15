/**
 * "Tournament countdown" — a compact
 * dd:hh:mm:ss counter for the FIFA
 * World Cup 2026 kickoff (2026-06-11
 * 17:00 UTC = MD1 opening match).
 *
 * R6X audit fix: previous home-page
 * banner said "🏆 Now live · 48 teams
 * · 104 matches · {N} active
 * markets" but had no time signal. A
 * user landing on the home page during
 * the tournament wants the "starts in
 * 2h 13m" signal at a glance, not a
 * vague "now live" string.
 *
 * Two render modes:
 *  - Pre-tournament (now < kickoff): "Starts in dd:hh:mm:ss"
 *  - In-tournament (now between kickoff and final): "Day N · 72 matches"
 *  - Post-tournament: hidden (no countdown to render)
 *
 * The component re-renders every
 * second via a `useEffect` with a
 * `setInterval(1000)`. The interval
 * is cleaned up on unmount. A
 * mounted-ref guard prevents
 * hydration mismatch (the server
 * renders "—" and the client fills
 * in the live countdown on the next
 * tick).
 */
"use client";

import { useEffect, useState } from "react";

// FIFA World Cup 2026 opening match (Mexico vs Czechia, June 11, 17:00 UTC).
// Hard-coded because the entire tournament starts and ends on known dates
// and the home page would otherwise need a per-page render-time fetch.
const WC_KICKOFF_MS = Date.UTC(2026, 5, 11, 17, 0, 0);
// 2026-07-19 final (52 days of group + knockout, well-known date).
const WC_FINAL_MS = Date.UTC(2026, 6, 19, 20, 0, 0);

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function countdownParts(msRemaining: number): {
  days: string;
  hours: string;
  minutes: string;
  seconds: string;
} {
  const totalSec = Math.max(0, Math.floor(msRemaining / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return {
    days: pad2(days),
    hours: pad2(hours),
    minutes: pad2(minutes),
    seconds: pad2(seconds),
  };
}

function dayIndex(): number {
  return Math.floor((Date.now() - WC_KICKOFF_MS) / 86_400_000) + 1;
}

export function TournamentCountdown({
  variant = "card",
}: {
  /** "card" = standalone card with title; "inline" = no title, just digits. */
  variant?: "card" | "inline";
}) {
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState<number>(0);

  useEffect(() => {
    setMounted(true);
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!mounted) {
    return (
      <div
        className="rounded-xl border border-white/10 bg-white/[0.03] p-3 text-center font-mono text-sm text-zinc-500"
        aria-label="Tournament countdown loading"
      >
        ⏱ —
      </div>
    );
  }

  // Post-tournament: hide the countdown entirely.
  if (now >= WC_FINAL_MS) {
    return null;
  }

  // In-tournament: show the day number instead of a countdown.
  if (now >= WC_KICKOFF_MS) {
    const day = dayIndex();
    return (
      <div
        className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-center"
        aria-label={`Tournament in progress, day ${day}`}
      >
        <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
          🏆 Tournament live
        </p>
        <p className="mt-1 font-mono text-lg font-extrabold text-emerald-200">
          Day {day} / 38
        </p>
      </div>
    );
  }

  // Pre-tournament countdown.
  const parts = countdownParts(WC_KICKOFF_MS - now);
  if (variant === "inline") {
    return (
      <span
        className="font-mono text-xs font-bold text-emerald-300"
        aria-label={`Tournament starts in ${parts.days} days ${parts.hours} hours`}
      >
        ⏱ {parts.days}d {parts.hours}:{parts.minutes}:{parts.seconds}
      </span>
    );
  }
  return (
    <div
      className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-amber-500/5 p-3"
      aria-label={`World Cup 2026 starts in ${parts.days} days ${parts.hours} hours`}
    >
      <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
        ⏱ Tournament starts in
      </p>
      <div className="mt-1 grid grid-cols-4 gap-1.5 text-center font-mono">
        {[
          { label: "days", v: parts.days },
          { label: "hrs", v: parts.hours },
          { label: "min", v: parts.minutes },
          { label: "sec", v: parts.seconds },
        ].map((cell) => (
          <div
            key={cell.label}
            className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-1 py-1.5"
          >
            <p className="text-base font-extrabold text-emerald-200">{cell.v}</p>
            <p className="text-[8px] uppercase tracking-wider text-emerald-400/70">
              {cell.label}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
