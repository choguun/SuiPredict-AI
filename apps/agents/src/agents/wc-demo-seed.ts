// Demo seed for World Cup 2026 markets.
//
// The MVP home page and markets list look "alive" even when the
// agents service is in dry-run mode (no AGENT_PRIVATE_KEY) — the
// seed writes demo rows for the 8 most exciting upcoming group
// matches straight into the SQLite mirror. The web UI reads the
// same mirror via `/markets`, so the home page shows real
// fixtures and live mid-prices right after `pnpm dev:agents`.
//
// Idempotency: keyed on `wc26-${match.id}`. Re-running is a no-op
// when the rows already exist; safe to call from `index.ts` boot.

import { fetchMatchSchedule } from "./world-cup-fetcher.js";
import {
  matchWinnerDescription,
  matchWinnerResolutionSource,
  matchWinnerTitle,
} from "./world-cup-fetcher.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

export async function seedWcDemoMarkets(): Promise<{
  seeded: number;
  skipped: number;
}> {
  const matches = await fetchMatchSchedule();
  const now = Date.now();
  const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;

  // Demo seed surfaces only matches within the next 7 days so the
  // home page is fresh. The full 72-match schedule is exposed via
  // `/wc/schedule` for the dedicated dashboard.
  const upcoming = matches
    .filter((m) => m.kickoffMs > now && m.kickoffMs <= oneWeekAhead)
    .sort((a, b) => a.kickoffMs - b.kickoffMs)
    .slice(0, 8);

  const existing = new Set(
    listMarkets()
      .filter((m) => m.id.startsWith("wc26-"))
      .map((m) => m.id),
  );

  let seeded = 0;
  let skipped = 0;
  for (const m of upcoming) {
    const id = `wc26-${m.id}`;
    if (existing.has(id)) {
      skipped++;
      continue;
    }
    upsertMarket({
      id,
      title: matchWinnerTitle(m),
      description: matchWinnerDescription(m),
      category: "worldcup",
      expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
      resolution_source: matchWinnerResolutionSource(m),
      status: "active",
      created_at_ms: Date.now(),
    });
    seeded++;
  }
  return { seeded, skipped };
}
