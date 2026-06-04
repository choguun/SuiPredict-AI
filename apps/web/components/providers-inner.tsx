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
  // worker (`apps/web/public/sw.js`) on first mount. The SW
  // was a hand-rolled PWA cache that used `NetworkFirst` with
  // a 32-entry, 24h-max-age cache for the `pages` route
  // (HTML navigations). A user who visited /markets, went
  // offline, and then returned to /markets would see the
  // last cached HTML — including a hard-coded `active market
  // count` in the SSR header that had no live revalidation.
  // The SW also conflicted with TanStack Query's
  // `refetchOnWindowFocus` and the per-page polling cadence:
  // the SW served stale HTML, the page mounted, and the
  // TanStack polls fired only for on-chain data, leaving
  // the SSR-time-static parts (page chrome, header counts)
  // stale for up to 24h. Unregister + delete all caches
  // from the SW's caches.open() namespace. Idempotent — if
  // the SW was never registered, `getRegistration` returns
  // undefined and the effect is a no-op.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const r of regs) void r.unregister();
    });
    if ("caches" in window) {
      void caches.keys().then((keys) => {
        for (const k of keys) void caches.delete(k);
      });
    }
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
