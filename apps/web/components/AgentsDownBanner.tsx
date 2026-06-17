/**
 * Reusable "agents service is down" banner.
 *
 * UAT-FN-07 fix: the pre-fix build had a friendly
 * "Failed to load markets" error on /markets but every
 * other route (/leaderboard, /portfolio, /parlay,
 * /friends, /settings, /agents, /vault) returned a raw
 * 21-byte "Internal Server Error" body when the agents
 * service was unreachable. The page-specific error UI on
 * /leaderboard (an amber box) and /agents (a drift
 * panel) was duplicated inconsistently; /portfolio,
 * /parlay, /friends, /settings, and /vault had no error
 * UI at all.
 *
 * The new AgentsDownBanner is a single component that
 * any server page renders at the top when its upstream
 * agents fetch fails. The message is identical across
 * pages (no more "this page silently 500s, that page
 * shows a coloured box, the other has a custom modal"),
 * and the copy leads with the user-actionable fix
 * ("Start the agents service with pnpm dev:agents")
 * instead of a technical Move-abort error.
 *
 * The optional `compact` variant is a one-line inline
 * error that fits inside a Card header without taking
 * up a full row. The default variant is a 2-line
 * banner with the "Start the agents service" hint.
 *
 * The "Check service status" link targets the agents
 * `/health` endpoint so the user can verify whether the
 * issue is on their side or the operator's. `/health` is
 * a no-auth GET that always returns 200 with a tiny JSON
 * envelope.
 */

const DEFAULT_AGENTS_URL = "http://localhost:3001";

export function AgentsDownBanner({
  message,
  url = process.env.NEXT_PUBLIC_AGENTS_URL ?? DEFAULT_AGENTS_URL,
  compact = false,
}: {
  // The underlying fetch error message (e.g. "fetch failed",
  // "ECONNREFUSED ::1:3001", "Agents responded 502"). Shown
  // as a small monospace line under the user-facing hint so
  // the operator has the diagnostic detail.
  message?: string;
  // Override the agents base URL (defaults to
  // `NEXT_PUBLIC_AGENTS_URL` or `http://localhost:3001`).
  url?: string;
  // When true, render a single-line variant suitable for a
  // Card header or a table footer. The default two-line
  // variant is a full-width banner with an icon.
  compact?: boolean;
}) {
  if (compact) {
    return (
      <p
        role="alert"
        className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
      >
        Couldn&apos;t reach the agents service.
        {message ? (
          <span className="ml-1 font-mono text-[10px] text-amber-300/80">
            ({message})
          </span>
        ) : null}{" "}
        Start it with{" "}
        <code className="text-[10px]">pnpm --filter @suipredict/agents dev</code>.
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-xl">
          ⚠️
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-amber-100">
            Agents service is unreachable
          </p>
          <p className="mt-1 text-amber-200/90">
            This page needs the autonomous agents fleet running on
            {" "}<code className="text-[10px]">{url}</code>. Start it
            from the repo root with{" "}
            <code className="text-[10px]">pnpm --filter @suipredict/agents dev</code>,
            then refresh this page. Check the{" "}
            <a
              href={`${url}/health`}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold underline underline-offset-2 hover:text-amber-50"
            >
              service health
            </a>{" "}
            endpoint to confirm it&apos;s up.
          </p>
          {message ? (
            <p className="mt-1 font-mono text-[10px] text-amber-300/70">
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
