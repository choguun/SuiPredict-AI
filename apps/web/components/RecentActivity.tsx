/**
 * "Recent Activity" feed. Pulls the 5 most recent
 * agent decisions from the agents' `/decisions`
 * endpoint so a landing user can see that the
 * platform is alive ("the bot just made a market
 * 4 minutes ago") without having to click through
 * to the /agents page. Renders inline with the
 * other home-page widgets.
 *
 * R61 audit fix: previous build had no
 * user-facing "platform is live" signal on the
 * home page beyond the world-cup dashboard. A
 * user landing on `/` for the first time saw
 * the static hero + gamification row + featured
 * markets but had no way to tell whether the
 * 14-agent fleet was actually running. A 4-line
 * "live activity" panel below the WC strip closes
 * that gap — a 1-tap "View all" link deep-links
 * to the full `/agents` page for the curious
 * operator.
 *
 * The feed is best-effort: a 5xx from the agents
 * service (or the indexer's `decisions` table
 * being momentarily empty) renders an empty
 * state with a "no recent activity" hint, not an
 * error banner. Errors that we *do* want to
 * surface (a config drift) are already in the
 * /agents page's banner; duplicating them on the
 * home page would be noisy.
 */

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const AGENTS_URL = process.env.NEXT_PUBLIC_AGENTS_URL ?? "http://localhost:3001";

interface Decision {
  id: string;
  agent: string;
  action: string;
  reasoning: string;
  confidence?: number;
  txDigest?: string;
  timestamp: number;
}

const DEFAULT_LIMIT = 5;

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

const ACTION_VARIANT: Record<
  string,
  { bg: string; text: string; label: string }
> = {
  create_market: { bg: "bg-emerald-500/15", text: "text-emerald-300", label: "Created" },
  create_wc: { bg: "bg-emerald-500/15", text: "text-emerald-300", label: "WC created" },
  resolve_market: { bg: "bg-cyan-500/15", text: "text-cyan-300", label: "Resolved" },
  resolve: { bg: "bg-cyan-500/15", text: "text-cyan-300", label: "Resolved" },
  place_quotes: { bg: "bg-violet-500/15", text: "text-violet-300", label: "Quoted" },
  quote: { bg: "bg-violet-500/15", text: "text-violet-300", label: "Quoted" },
  quote_failed: { bg: "bg-rose-500/15", text: "text-rose-300", label: "Quote failed" },
  pause_failed: { bg: "bg-rose-500/15", text: "text-rose-300", label: "Pause failed" },
  monitor: { bg: "bg-zinc-500/15", text: "text-zinc-300", label: "Monitor" },
  noop: { bg: "bg-zinc-500/15", text: "text-zinc-300", label: "No-op" },
  skip: { bg: "bg-zinc-500/15", text: "text-zinc-300", label: "Skipped" },
  demo_market: { bg: "bg-amber-500/15", text: "text-amber-300", label: "Demo" },
  create_demo: { bg: "bg-amber-500/15", text: "text-amber-300", label: "Demo" },
};

function variantFor(action: string) {
  return ACTION_VARIANT[action] ?? {
    bg: "bg-white/10",
    text: "text-zinc-300",
    label: action,
  };
}

export function RecentActivity() {
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Fetch a wider window than DEFAULT_LIMIT so a
    // "no-op" / "monitor" / "skip" / "stale cursor"
    // flurry doesn't crowd out the interesting
    // decisions (create / resolve / quote). The
    // agents endpoint is /decisions?limit=…
    // server-side, but the SDK's indexer table
    // doesn't have a noise-filter column; the
    // filter happens client-side.
    fetch(`${AGENTS_URL}/decisions?limit=50`, {
      cache: "no-store",
    })
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) {
          setError(`Agents responded ${r.status}`);
          return;
        }
        const data = (await r.json()) as Decision[];
        // Drop entries whose action is the
        // everyday churn (noop / skip / monitor
        // / indexer poll). Keep the first 5
        // *meaningful* decisions; if every
        // decision is noise (rare), fall
        // back to the most recent 5
        // regardless.
        const NOISE = new Set([
          "noop",
          "skip",
          "monitor",
          "indexer_poll",
        ]);
        const meaningful = data.filter(
          (d) => !NOISE.has(d.action),
        );
        const slice = (meaningful.length > 0 ? meaningful : data).slice(
          0,
          DEFAULT_LIMIT,
        );
        setDecisions(slice);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Fetch failed",
        );
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="space-y-3">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-white">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            <span>Live agent activity</span>
          </h2>
          <p className="mt-0.5 text-xs text-zinc-500">
            What the autonomous fleet is doing right now.
          </p>
        </div>
        <Link
          href="/agents"
          className="rounded-lg bg-white/5 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:bg-white/10"
        >
          All decisions →
        </Link>
      </div>

      {!loaded && (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-12 animate-pulse rounded-lg bg-white/[0.03]"
            />
          ))}
        </div>
      )}

      {loaded && error && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          {error}. The agents service may be down — start it with{" "}
          <code className="text-[10px]">pnpm dev:agents</code>.
        </p>
      )}

      {loaded && !error && decisions.length === 0 && (
        <p className="rounded-md border border-dashed border-white/10 bg-white/[0.02] px-3 py-4 text-center text-xs text-zinc-500">
          No agent decisions yet. The first tick of the fleet lands within
          a minute of starting the agents service.
        </p>
      )}

      {decisions.length > 0 && (
        <ul className="space-y-2">
          {decisions.map((d) => {
            const v = variantFor(d.action);
            return (
              <li
                key={d.id}
                className="flex items-start gap-3 rounded-lg border border-white/5 bg-white/[0.02] p-3"
              >
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${v.bg} ${v.text}`}
                >
                  {v.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-white">
                      {d.agent}
                    </span>
                    <span className="shrink-0 text-[10px] text-zinc-500">
                      {timeAgo(d.timestamp)}
                    </span>
                  </div>
                  <p className="line-clamp-1 text-xs text-zinc-400">
                    {d.reasoning}
                  </p>
                </div>
                {d.txDigest && (
                  <a
                    href={`https://${process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet"}.suivision.xyz/txblock/${d.txDigest}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0 text-[10px] font-mono text-cyan-400 hover:text-cyan-300"
                    title={d.txDigest}
                  >
                    tx ↗
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
