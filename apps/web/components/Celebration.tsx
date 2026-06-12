"use client";

/**
 * Streak milestone celebration.
 *
 * Plays a 2s confetti-style animation when `trigger` flips to a
 * new milestone value (3, 7, 14, 30, 60, 100, 365). The
 * implementation is pure CSS animations on a fixed-position
 * overlay; the React tree doesn't re-render. We also fire
 * `navigator.vibrate(40)` once if the browser supports the
 * Vibration API (iOS Safari does not, Android Chrome does) so the
 * user gets tactile feedback.
 *
 * Why not a library? Most "confetti" libraries are 30-50KB
 * gzipped. This is 1.5KB and the visual is just 24 falling
 * particles with three distinct colors.
 */

import { useEffect, useRef, useState } from "react";

const COLORS = ["#10b981", "#fbbf24", "#f43f5e", "#06b6d4", "#a855f7"];

export function Celebration({
  streak,
}: {
  /** The current streak count. Plays the animation only when this crosses a milestone. */
  streak: number;
}) {
  const MILESTONES = [3, 7, 14, 30, 60, 100, 365];
  const lastMilestoneRef = useRef<number>(0);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const next = MILESTONES.find((m) => m > lastMilestoneRef.current && m <= streak);
    if (next === undefined) return;
    lastMilestoneRef.current = next;
    setActive(true);
    // Best-effort haptic feedback. The API is undefined on
    // Safari iOS, so guard with optional chaining.
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try {
        // The Vibration API is non-standard; the `in` check above
        // narrows the type for TS but `navigator.vibrate` itself
        // isn't in the lib.dom.d.ts we ship, so a plain call
        // errors out. Cast once.
        (navigator as Navigator & { vibrate?: (ms: number) => boolean }).vibrate?.(40);
      } catch {
        /* noop */
      }
    }
    const t = setTimeout(() => setActive(false), 2200);
    return () => clearTimeout(t);
  }, [streak]);

  if (!active) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-[100] overflow-hidden"
    >
      <div className="absolute inset-0 flex items-start justify-center pt-20">
        <div className="rounded-2xl border border-emerald-500/40 bg-black/70 px-6 py-4 text-center backdrop-blur-md shadow-2xl shadow-emerald-500/20">
          <div className="text-3xl">🔥</div>
          <div className="mt-1 text-lg font-extrabold text-white">
            {streak}-day streak!
          </div>
          <div className="text-xs text-zinc-400">Multiplier unlocked</div>
        </div>
      </div>
      {Array.from({ length: 32 }).map((_, i) => {
        const left = (i * 13) % 100;
        const delay = (i % 8) * 60;
        const duration = 1500 + (i % 5) * 200;
        const color = COLORS[i % COLORS.length]!;
        return (
          <span
            key={i}
            className="absolute top-0 block h-2 w-2 rounded-sm"
            style={{
              left: `${left}%`,
              backgroundColor: color,
              animation: `wc26-confetti-fall ${duration}ms ease-out ${delay}ms forwards`,
              transform: `rotate(${(i * 37) % 360}deg)`,
            }}
          />
        );
      })}
      <style jsx>{`
        @keyframes wc26-confetti-fall {
          0% {
            transform: translateY(-20px) rotate(0deg);
            opacity: 1;
          }
          100% {
            transform: translateY(110vh) rotate(720deg);
            opacity: 0;
          }
        }
      `}</style>
    </div>
  );
}
