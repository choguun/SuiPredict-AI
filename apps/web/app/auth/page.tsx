"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useEnokiFlow } from "@mysten/enoki/react";

export default function AuthCallbackPage() {
  const router = useRouter();
  const enokiFlow = useEnokiFlow();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Process the OAuth redirect containing the JWT hash
    let cancelled = false;
    // R57.L6 audit fix: race the OAuth callback against a
    // 15s timeout. The `enokiFlow.handleAuthCallback()`
    // Promise resolves only when the zkLogin JWT round-trip
    // completes; a network drop after the wallet-redirect-
    // comes-back step would hang the spinner forever. The
    // user previously had to manually reload.
    const AUTH_TIMEOUT_MS = 15_000;
    const timeout = setTimeout(() => {
      if (cancelled) return;
      console.warn("[auth] handleAuthCallback timed out");
      setError("Sign in timed out. Please try again.");
    }, AUTH_TIMEOUT_MS);
    const handleAuth = async () => {
      try {
        await enokiFlow.handleAuthCallback();
        clearTimeout(timeout);
        if (cancelled) return;
        // R28: honor a `?return=/some/path` query so a deep-link
        // (e.g. /markets/<id>) that bounced through the auth gate
        // comes back to the originating page after zkLogin finishes.
        // Default to "/" when missing or when the value isn't a
        // safe same-origin path (we never want to redirect to an
        // external host after auth).
        const params = new URLSearchParams(window.location.search);
        const raw = params.get("return") ?? "/";
        const safe = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/";
        router.push(safe);
      } catch (err) {
        clearTimeout(timeout);
        // R49 audit fix: don't update state on an unmounted
        // component (React strict-mode in dev mounts the effect
        // twice; without the cancelled guard, the second mount
        // races the first and the OAuth callback fires twice,
        // creating two zkLogin sessions and throwing an opaque
        // error on the second `handleAuthCallback` call).
        if (cancelled) return;
        console.error("Auth callback failed:", err);
        setError("Authentication failed. Please try again.");
      }
    };

    handleAuth();
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [enokiFlow, router]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="text-center">
        {error ? (
          <div className="text-rose-400">
            <h2 className="mb-2 text-xl font-bold">Error</h2>
            <p>{error}</p>
            <button
              onClick={() => router.push("/")}
              className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20 transition"
            >
              Return Home
            </button>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4">
            {/* R62 audit fix: add `role="status"`
               and `aria-live="polite"` to the
               spinner so screen-reader users
               get the same "Authenticating…"
               announcement. The pre-R62
               spinner was a pure visual
               element with no role
               announcement — a screen-reader
               user landing on `/auth` heard
               nothing until the success /
               error view rendered. The
               `aria-live="polite"` attribute
               also picks up the eventual
               success / failure
               announcement when the JS
               swaps the children. */}
            <div
              role="status"
              aria-live="polite"
              className="h-10 w-10 animate-spin rounded-full border-4 border-violet-500 border-t-transparent"
              aria-label="Authenticating"
            />
            <h2 className="text-xl font-bold text-white">Authenticating...</h2>
            <p className="text-sm text-zinc-400">Creating your secure zkLogin session.</p>
          </div>
        )}
      </div>
    </div>
  );
}
