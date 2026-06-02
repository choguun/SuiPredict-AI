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
