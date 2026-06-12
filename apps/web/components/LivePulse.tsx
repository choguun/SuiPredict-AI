"use client";

/**
 * A live-pulse indicator. Animates a 1.5s pulse around a colored
 * dot. Used for "match starting in <1h", "match in progress",
 * and "live now" indicators. Pure CSS, no JS animation loop, so
 * it stays cheap on mobile.
 *
 * Colors:
 *   green = "live now"
 *   amber = "starting soon" (within 1h)
 *   red   = "about to expire" (within 30min of market close)
 */
import { ReactNode } from "react";

export type PulseColor = "green" | "amber" | "red" | "emerald" | "rose";

const COLOR_CLASSES: Record<PulseColor, { dot: string; ping: string }> = {
  green:   { dot: "bg-green-500",   ping: "bg-green-500"   },
  amber:   { dot: "bg-amber-500",   ping: "bg-amber-500"   },
  red:     { dot: "bg-red-500",     ping: "bg-red-500"     },
  emerald: { dot: "bg-emerald-500", ping: "bg-emerald-500" },
  rose:    { dot: "bg-rose-500",    ping: "bg-rose-500"    },
};

export function LivePulse({
  color = "emerald",
  label,
  className = "",
}: {
  color?: PulseColor;
  label?: ReactNode;
  className?: string;
}) {
  const c = COLOR_CLASSES[color];
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span className="relative flex h-2 w-2">
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${c.ping}`}
        />
        <span className={`relative inline-flex h-2 w-2 rounded-full ${c.dot}`} />
      </span>
      {label && (
        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">
          {label}
        </span>
      )}
    </span>
  );
}
