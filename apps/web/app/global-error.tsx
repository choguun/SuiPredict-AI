"use client";

/**
 * Root error boundary. The sibling `app/error.tsx` catches
 * errors that bubble up from a route segment; this one
 * catches errors that break the root layout itself
 * (e.g. a provider throw, a fonts loader crash). The two
 * are complementary — without `global-error.tsx`, an
 * error in the layout renders a bare `Internal Server
 * Error` text body (the 21-byte response the qa-tester
 * observed in the pre-fix build).
 *
 * UAT-FN-07 fix: every route that talks to the agents
 * REST backend (markets, leaderboard, portfolio, vault,
 * friends, settings, agents, dispute) was 500ing with a
 * bare-text 21-byte body when the agents service was
 * down. The error boundary renders a styled card with
 * the brand, a "Try again" button, and a "Back to home"
 * link so the user always has a way back.
 */

import Link from "next/link";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The sibling `app/error.tsx` already
    // logs route-segment errors; this
    // one is the catch-all for layout
    // crashes. Surface the digest so the
    // operator can grep the agents /
    // web logs for the matching request.
    console.error("[web] Global render error:", error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen bg-[#050508] text-white antialiased">
        <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6 text-center">
          <div className="rounded-3xl border border-white/10 bg-panel-strong p-8 shadow-2xl shadow-black/80 sm:p-12">
            <div className="mb-4 text-6xl" aria-hidden="true">🏟️</div>
            <h1 className="mb-2 text-2xl font-bold text-white sm:text-3xl">
              Something went wrong
            </h1>
            <p className="mx-auto mb-6 max-w-md text-sm text-zinc-400">
              The page hit an unexpected error. The agents service
              may be down, or there may be a transient network
              issue. Try again, or head back to the home page.
            </p>
            {error.digest && (
              <p className="mb-4 font-mono text-[10px] text-zinc-600">
                digest: {error.digest}
              </p>
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => reset()}
                className="rounded-lg bg-gradient-to-r from-emerald-500 to-cyan-500 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-cyan-900/30 transition hover:scale-[1.02]"
              >
                Try again
              </button>
              <Link
                href="/"
                className="rounded-lg border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10"
              >
                ← Back to home
              </Link>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
