"use client";

import dynamic from "next/dynamic";

export const Providers = dynamic(
  () => import("./providers-inner").then((m) => m.ProvidersInner),
  { ssr: false },
);
