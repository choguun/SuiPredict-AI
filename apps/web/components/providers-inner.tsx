"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DAppKitProvider } from "@mysten/dapp-kit-react";
import { EnokiFlowProvider } from "@mysten/enoki/react";
import { useState } from "react";
import { dAppKit } from "@/lib/dapp-kit";

export function ProvidersInner({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <DAppKitProvider dAppKit={dAppKit}>
        <EnokiFlowProvider apiKey={process.env.NEXT_PUBLIC_ENOKI_API_KEY as string}>
          {children}
        </EnokiFlowProvider>
      </DAppKitProvider>
    </QueryClientProvider>
  );
}
