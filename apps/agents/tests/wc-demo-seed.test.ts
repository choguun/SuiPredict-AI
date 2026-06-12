// Tests for the WC demo seed.
//
// The seed runs at agent-service boot to populate demo
// markets in the SQLite mirror. The R58 audit fix widened
// the filter so in-play matches (kicked off <24h ago) are
// also included; the previous filter `kickoffMs > now`
// produced an empty seed when the system clock was set
// forward to mid-tournament (the case in the live demo).
//
// Run with:  pnpm --filter @suipredict/agents exec node --import tsx --test tests/wc-demo-seed.test.ts

import test from "node:test";
import assert from "node:assert/strict";

import { fetchMatchSchedule } from "../src/agents/world-cup-fetcher.js";

test("schedule has 72 group matches spanning June 11-27, 2026", async () => {
  const matches = await fetchMatchSchedule();
  assert.equal(matches.length, 72);
  const juneMatches = matches.filter(
    (m) => m.kickoffMs >= Date.UTC(2026, 5, 11) && m.kickoffMs < Date.UTC(2026, 6, 1),
  );
  assert.equal(juneMatches.length, 72, "all 72 matches are in June 2026");
});

test("schedule has matches both in the past and the future relative to a mid-tournament clock", async () => {
  // Simulate a clock set to June 12, 2026 (the live demo's
  // current time). Confirm that some matches have already
  // kicked off and some are still upcoming, so the seed
  // filter (in-play OR upcoming) is non-empty.
  const simNow = Date.UTC(2026, 5, 12, 16, 0);
  const matches = await fetchMatchSchedule();
  const inPlay = matches.filter(
    (m) => m.kickoffMs > simNow - 24 * 3600_000 && m.kickoffMs < simNow,
  );
  const upcoming = matches.filter(
    (m) => m.kickoffMs >= simNow && m.kickoffMs <= simNow + 7 * 86_400_000,
  );
  assert.ok(
    inPlay.length > 0,
    "expected some in-play matches for the June 12, 2026 clock",
  );
  assert.ok(
    upcoming.length > 0,
    "expected some upcoming matches in the next 7d",
  );
  // The R58 seed filter surfaces BOTH groups. The previous
  // filter (`kickoffMs > now`) would have returned 0
  // matches for the June 12 clock and left the home page
  // blank. This test pins the fix.
  const seedFilter = matches.filter(
    (m) =>
      (m.kickoffMs > simNow - 24 * 3600_000 && m.kickoffMs < simNow) ||
      (m.kickoffMs >= simNow && m.kickoffMs <= simNow + 7 * 86_400_000),
  );
  assert.equal(
    seedFilter.length,
    inPlay.length + upcoming.length,
    "seed filter must include both in-play and upcoming",
  );
  assert.ok(
    seedFilter.length > 0,
    "seed filter must produce a non-empty result for the June 12 clock",
  );
});
