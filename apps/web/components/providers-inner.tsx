"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { useEffect, useState } from "react";
import { dAppKit } from "@/lib/dapp-kit";

export function ProvidersInner({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  // `as string` would coerce an unset env to the literal string
  // "undefined" (Next.js's runtime placeholder for missing
  // NEXT_PUBLIC_*) and silently brick the EnokiFlowProvider. Read
  // defensively and surface a console warning so the operator can
  // fix it before a user hits /auth.
  const enokiKey = process.env.NEXT_PUBLIC_ENOKI_API_KEY ?? "";
  useEffect(() => {
    if (!enokiKey) {
      console.warn(
        "[providers] NEXT_PUBLIC_ENOKI_API_KEY is not set — zkLogin / Enoki flow will not work. Set it in apps/web/.env.local and rebuild.",
      );
    }
  }, [enokiKey]);

  // R43 audit fix: unregister the legacy Workbox service
  // worker on first mount. The SW was a hand-rolled PWA
  // cache that used `NetworkFirst` with a 32-entry, 24h-max-age
  // cache for the `pages` route (HTML navigations). A user
  // who visited /markets, went offline, and then returned to
  // /markets would see the last cached HTML — including a
  // hard-coded `active market count` in the SSR header that
  // had no live revalidation. The SW also conflicted with
  // TanStack Query's `refetchOnWindowFocus` and the per-page
  // polling cadence: the SW served stale HTML, the page
  // mounted, and the TanStack polls fired only for on-chain
  // data, leaving the SSR-time-static parts (page chrome,
  // header counts) stale for up to 24h.
  //
  // UAT-FN-17 fix: replace the "always unregister" effect
  // with a one-time migration that (a) unregisters the
  // legacy Workbox SW (via the `sw-src` global the R48 audit
  // set, defaulting to the old workbox route), (b) clears
  // any of its caches, and (c) registers the new
  // `sw.js` (the offline shell that ships with this build).
  // The new SW only handles `navigate` requests and never
  // caches API responses, so the stale-HTML exposure
  // described above is impossible.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    (async () => {
      // (a) + (b) unregister any legacy registrations and
      // drop their caches. The workbox SW exposed
      // `self.__WB_MANIFEST` so a `getRegistration` that
      // finds a `scriptURL` ending in `workbox-*.js` is the
      // legacy one; the new `sw.js` scriptURL is
      // `/sw.js` exactly.
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        if (cancelled) return;
        const url = r.active?.scriptURL ?? r.installing?.scriptURL ?? r.waiting?.scriptURL ?? "";
        if (!url.endsWith("/sw.js")) {
          await r.unregister();
        }
      }
      if ("caches" in window) {
        const keys = await caches.keys();
        for (const k of keys) {
          // The new SW uses versioned cache names
          // (`suipredict-shell-${SW_VERSION}`). Drop
          // anything else.
          if (!k.startsWith("suipredict-shell-")) {
            await caches.delete(k);
          }
        }
      }
      // (c) register the new offline-shell SW. Wrapped
      // in a try/catch so a runtime error in the SW
      // install (e.g. `offline.html` 404 during a
      // partial deploy) doesn't brick the page.
      if (cancelled) return;
      try {
        // `register("/sw.js", { scope: "/" })` is the
        // canonical SPA registration. The default
        // scope is the parent path of the SW script,
        // so registering from `/sw.js` (at the site
        // root) gives us the full site scope.
        await navigator.serviceWorker.register("/sw.js", {
          scope: "/",
        });
      } catch (err) {
        // Log to console only — a missing /sw.js
        // shouldn't fail the page. The user still
        // gets the full app on every reload, just
        // without an offline fallback.
        console.warn("[providers] offline SW registration failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <EnokiFlowProvider apiKey={enokiKey}>
          {children}
        </EnokiFlowProvider>
      </DAppKitProvider>
    </QueryClientProvider>
  );
}
