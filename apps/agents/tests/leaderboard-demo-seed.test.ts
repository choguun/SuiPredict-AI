// Tests for the Top-Forecasters demo seed.
//
// The seed runs at agent-service boot to populate
// `daily_scores` rows for the current week so the home page's
// `TopForecasters` widget shows 5 demo forecasters on a fresh
// deploy / in API-only mode. Without this seed the widget
// renders the empty state ("No forecasters on the board yet")
// indefinitely until real users start participating.
//
// The seed writes to the gamification SQLite DB; we point it
// at a per-process temp directory via `DATA_DIR` so the tests
// don't touch the developer's real `apps/agents/data/`
// database. The pattern matches the production layout
// (`<DATA_DIR>/gamification.db`).
//
// Run with:  pnpm --filter @suipredict/agents exec node --import tsx --test tests/leaderboard-demo-seed.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CRITICAL: set DATA_DIR BEFORE importing the gamification
// store. The store resolves its DB path at module load
// time from `process.env.DATA_DIR`, so changing the env
// after import has no effect on the singleton's path.
const tempDir = mkdtempSync(join(tmpdir(), "lb-seed-test-"));
process.env["DATA_DIR"] = tempDir;

const { seedLeaderboardDemo, clearLeaderboardDemo } = await import(
  "../src/agents/leaderboard-demo-seed.js"
);
const { listAllDailyScores } = await import(
  "../src/gamification/store.js"
);

// Force the deployer to the hardcoded fallback so the
// tests don't depend on a developer's AGENT_PRIVATE_KEY
// leaking from a .env file into the test process.
delete process.env.AGENT_PRIVATE_KEY;

test.after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

test("seed inserts 35 rows (5 forecasters × 7 days) for the current week", async () => {
  const result = await seedLeaderboardDemo();
  assert.equal(result.seeded, 5, "seeds 5 demo forecasters");
  assert.equal(result.skipped, 0);
  assert.equal(result.totalCandidates, 5);

  const rows = listAllDailyScores();
  assert.equal(rows.length, 35, "35 daily_scores rows present after seed");
});

test("seed produces the expected rank order via aggregateWeek semantics", async () => {
  // The `aggregateWeek` function in `leaderboard-worker.ts`
  // groups by user, sums `all_correct` (= correct_days),
  // takes the max `streak_after` (= longest_streak), and
  // sorts by `score = correct_days + 0.01 * longest_streak`.
  // We reproduce that here and assert the deployer is
  // rank 1 and the placeholders are ranked 2-5 in the
  // expected order.
  //
  // The patterns are documented in
  // `apps/agents/src/agents/leaderboard-demo-seed.ts` and
  // follow the on-chain `streak_system::record_participation`
  // Move semantics: `current_streak` resets to 0 on any
  // non-ALL_CORRECT outcome, so a mid-week miss drops the
  // streak to 0 and a subsequent correct day starts fresh
  // at 1. The visual gradient on the home page reads:
  //
  //   rank 1 deployer: 7.07  (7/7 correct, max streak 7)
  //   rank 2:          6.06  (6/7 correct, miss day 6, max 6)
  //   rank 3:          6.03  (6/7 correct, miss day 3, max 3)
  //   rank 4:          5.03  (5/7 correct, miss days 1,5, max 3)
  //   rank 5:          4.03  (4/7 correct, miss days 3,4,6, max 3)
  const rows = listAllDailyScores();
  const userBuckets = new Map<
    string,
    { correct_days: number; longest_streak: number }
  >();
  for (const r of rows) {
    const cur = userBuckets.get(r.user) ?? {
      correct_days: 0,
      longest_streak: 0,
    };
    cur.correct_days += r.all_correct;
    cur.longest_streak = Math.max(cur.longest_streak, r.streak_after);
    userBuckets.set(r.user, cur);
  }
  const ranked = Array.from(userBuckets.entries())
    .map(([user, v]) => ({
      user,
      ...v,
      score: v.correct_days + 0.01 * v.longest_streak,
    }))
    .sort((a, b) => b.score - a.score);

  // The deployer (rank 1) is the only user with 7 correct
  // days. Its max streak is also 7 because all 7 days are
  // consecutive.
  assert.equal(ranked[0]!.correct_days, 7);
  assert.equal(ranked[0]!.longest_streak, 7);
  assert.ok(Math.abs(ranked[0]!.score - 7.07) < 1e-6);

  // Ranks 2-5: total correct_days is 6+6+5+4 = 21. Max
  // streaks (sorted) are 6, 3, 3, 3 — rank 2's streak of
  // 6 dominates the rest because its miss is on the very
  // last day of the week (the run Mon–Sat is unbroken).
  const totals = ranked.slice(1).reduce(
    (acc, r) => ({
      correct: acc.correct + r.correct_days,
      streaks: [...acc.streaks, r.longest_streak],
    }),
    { correct: 0, streaks: [] as number[] },
  );
  assert.equal(totals.correct, 21);
  assert.deepEqual(
    totals.streaks.sort((a, b) => a - b),
    [3, 3, 3, 6],
  );

  // Score ordering is strictly descending across all 5 rows
  // (the demo is designed so each rank has a visibly
  // distinct score; a tie would be a regression).
  const scores = ranked.map((r) => r.score);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(
      scores[i - 1]! > scores[i]!,
      `score must strictly decrease at rank ${i + 1}: ${scores[i - 1]} > ${scores[i]}`,
    );
  }
});

test("seed only touches rows for the 5 demo addresses (real users preserved)", async () => {
  // Insert a synthetic "real user" row for the current
  // week via the store's own write path (so the row
  // shape matches what the indexer writes).
  const { recordDailyScore } = await import(
    "../src/gamification/store.js"
  );
  const realUser = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const weekStart = Math.floor(Date.now() / 86_400_000 / 7) * 7;
  recordDailyScore({
    user: realUser,
    day_index: weekStart,
    participated: 1,
    all_correct: 1,
    streak_after: 1,
    category: 0,
  });

  await seedLeaderboardDemo();

  const after = listAllDailyScores().filter(
    (r) => r.user === realUser && r.day_index === weekStart,
  );
  assert.equal(after.length, 1, "real user's row survives the seed");
  assert.equal(after[0]!.all_correct, 1);
  assert.equal(after[0]!.streak_after, 1);
  assert.equal(after[0]!.participated, 1);
});

test("seed is idempotent — re-running converges to the same row count", async () => {
  const before = listAllDailyScores().length;
  await seedLeaderboardDemo();
  await seedLeaderboardDemo();
  const after = listAllDailyScores().length;
  assert.equal(after, before, "re-running the seed does not add or remove rows");
});

test("clearLeaderboardDemo removes only the 5 demo addresses' current-week rows", async () => {
  const realUser = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const weekStart = Math.floor(Date.now() / 86_400_000 / 7) * 7;

  // Re-insert the real user's row (it was already there
  // from the previous test, but we re-confirm in case
  // the test order is rearranged).
  const { recordDailyScoreIfAbsent } = await import(
    "../src/gamification/store.js"
  );
  recordDailyScoreIfAbsent({
    user: realUser,
    day_index: weekStart,
    participated: 1,
    all_correct: 1,
    streak_after: 1,
    category: 0,
  });

  const before = listAllDailyScores().length;
  const result = await clearLeaderboardDemo();
  const after = listAllDailyScores().length;

  assert.equal(
    before - after,
    result.removed,
    "removed count matches the row delta",
  );

  const realRow = listAllDailyScores().find(
    (r) => r.user === realUser && r.day_index === weekStart,
  );
  assert.ok(realRow, "real user's row survives the clear");
  assert.equal(realRow.all_correct, 1);
});

test("seed is bounded to the current UTC week — prior-week rows are preserved", async () => {
  // Insert a synthetic row in the prior week for the
  // deployer's address. Re-run the seed. Assert the
  // prior-week row is unchanged (the seed only writes
  // to the current week's day indices).
  //
  // The previous test ("clearLeaderboardDemo...") removed
  // all 35 demo rows, so the deployer lookup must be done
  // from the resolved address (or by re-seeding first).
  // We use the same hardcoded fallback address as the seed
  // module's `resolveDeployerAddress()` so the test doesn't
  // depend on `AGENT_PRIVATE_KEY` leaking into the test
  // process.
  const weekStart = Math.floor(Date.now() / 86_400_000 / 7) * 7;
  const priorWeekStart = weekStart - 7;
  const deployerAddr =
    "0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716";

  // Re-seed so the deployer row exists for the current
  // week (also a useful sanity check — the seed works
  // even on a freshly-cleared DB).
  await seedLeaderboardDemo();

  // Use the store's write helper for the synthetic row.
  const { recordDailyScore } = await import(
    "../src/gamification/store.js"
  );
  recordDailyScore({
    user: deployerAddr,
    day_index: priorWeekStart,
    participated: 1,
    all_correct: 1,
    streak_after: 99,
    category: 0,
  });

  // Re-seed once more (idempotency check + the actual
  // assertion). The prior-week row must survive.
  await seedLeaderboardDemo();

  const priorRow = listAllDailyScores().find(
    (r) => r.user === deployerAddr && r.day_index === priorWeekStart,
  );
  assert.ok(priorRow, "prior-week row survives the seed");
  assert.equal(
    priorRow.streak_after,
    99,
    "prior-week row's streak_after is unchanged",
  );

  // Cleanup so subsequent runs aren't polluted. We
  // remove just the prior-week row; the current-week
  // rows are owned by the next test's `clearOnly` flow.
  const { recordDailyScoreIfAbsent } = await import(
    "../src/gamification/store.js"
  );
  // We can't delete via the public API, but `clearLeaderboardDemo`
  // already removed the current-week rows. The prior-week row
  // sits in a temp DB that's wiped in `test.after`, so no
  // explicit cleanup is needed.
  void recordDailyScoreIfAbsent;
});

test("seed clears legacy placeholder rows from the pre-R-UAT-FN-19.1 demo script", async () => {
  // Simulate a deployment that previously ran
  // `scripts/seed-leaderboard.mjs` (the pre-TS demo
  // seed) — the legacy placeholder addresses have rows
  // in `daily_scores` for the current week. The new
  // boot-time seed must clean them up so they don't
  // linger with the old (non-Move) streak semantics.
  const { recordDailyScore } = await import(
    "../src/gamification/store.js"
  );
  const LEGACY_ADDRS = [
    "0xa1b2c3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789",
    "0xb2c3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789ab",
    "0xc3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789abcd",
    "0xd4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789abcdef",
  ];
  const weekStart = Math.floor(Date.now() / 86_400_000 / 7) * 7;

  for (const addr of LEGACY_ADDRS) {
    for (let d = 0; d < 7; d++) {
      recordDailyScore({
        user: addr,
        day_index: weekStart + d,
        participated: 1,
        all_correct: 1,
        streak_after: d + 1,
        category: 0,
      });
    }
  }
  const before = listAllDailyScores().filter((r) =>
    LEGACY_ADDRS.includes(r.user) && r.day_index >= weekStart,
  );
  assert.equal(before.length, 28, "4 legacy addresses × 7 days seeded");

  // Run the new seed; the legacy rows must be cleared.
  await seedLeaderboardDemo();

  const after = listAllDailyScores().filter((r) =>
    LEGACY_ADDRS.includes(r.user) && r.day_index >= weekStart,
  );
  assert.equal(
    after.length,
    0,
    "legacy placeholder rows are cleared on every boot",
  );
});

test("SUPPRESS_LEGACY_DEMO_CLEANUP=1 preserves the legacy placeholder rows", async () => {
  // Set the opt-out flag and re-seed the legacy rows.
  process.env.SUPPRESS_LEGACY_DEMO_CLEANUP = "1";
  try {
    const { recordDailyScore } = await import(
      "../src/gamification/store.js"
    );
    const LEGACY_ADDR = "0xa1b2c3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789";
    const weekStart = Math.floor(Date.now() / 86_400_000 / 7) * 7;
    for (let d = 0; d < 7; d++) {
      recordDailyScore({
        user: LEGACY_ADDR,
        day_index: weekStart + d,
        participated: 1,
        all_correct: 1,
        streak_after: d + 1,
        category: 0,
      });
    }

    await seedLeaderboardDemo();

    const survivor = listAllDailyScores().find(
      (r) => r.user === LEGACY_ADDR && r.day_index === weekStart,
    );
    assert.ok(
      survivor,
      "legacy row survives when SUPPRESS_LEGACY_DEMO_CLEANUP=1",
    );
  } finally {
    delete process.env.SUPPRESS_LEGACY_DEMO_CLEANUP;
  }
});
