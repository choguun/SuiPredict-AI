"use client";

/**
 * Root error boundary. Without this, any thrown error in a route
 * segment bubbles up to the Next.js dev overlay (or a generic 500
 * page in production), and the user has no in-app way back. R40
 * audit fix: pages that fetch from the agents REST API or the
 * gRPC client (markets, markets/[id], agents, parlay, leaderboard,
 * portfolio) can throw on transient outage. Catching here keeps
 * the rest of the layout (header, ConnectModal) interactive and
 * offers a retry.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[web] Route render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
      <h2 className="text-2xl font-semibold text-rose-300">
        Something went wrong
      </h2>
      <p className="max-w-md text-sm text-zinc-400">
        {error.message ||
          "An unexpected error occurred while loading this page."}
      </p>
      {error.digest && (
        <p className="text-xs font-mono text-zinc-600">
          digest: {error.digest}
        </p>
      )}
      <button
        type="button"
        onClick={() => reset()}
        className="rounded-md bg-cyan-500/20 px-4 py-2 text-sm font-medium text-cyan-200 transition hover:bg-cyan-500/30"
      >
        Try again
      </button>
    </div>
  );
}
