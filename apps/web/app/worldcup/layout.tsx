import type { Metadata } from "next";

/**
 * World Cup 2026 dashboard layout. Exports the
 * segment-level metadata for the world cup
 * routes. The page component (`page.tsx`) is
 * marked `"use client"` for its `useState` /
 * `useEffect` polling, so it cannot export
 * `metadata` directly — the convention is to
 * export `metadata` from the layout file.
 *
 * R30 sweep fix: per-page metadata so the
 * browser tab title reads "World Cup 2026
 * Dashboard · SuiPredict AI" instead of the
 * generic layout title. The world cup page
 * is the flagship vertical and the most
 * likely destination from a search or social
 * link, so its description is the second
 * most important SEO surface on the site
 * after the home page.
 */
export const metadata: Metadata = {
  title: "World Cup 2026 Dashboard",
  description:
    "Predict every FIFA World Cup 2026 match. Live ticker, 12 groups, 72 group-stage fixtures, and Elo-priced prediction markets. Trade YES/NO on every game.",
};

export default function WorldCupLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return <>{children}</>;
}
