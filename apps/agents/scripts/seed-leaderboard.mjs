#!/usr/bin/env node
/**
 * scripts/seed-leaderboard.mjs
 * ============================================================================
 * R-UAT-FN-19 fix: pre-populate the `daily_scores` SQLite table with
 * demo "Top forecasters" data so the home page's TopForecasters
 * component shows realistic content instead of an empty state.
 *
 * The pre-fix state: the leaderboard was only populated by the
 * `LeaderboardWorker` cron (Monday 00:05 UTC), which aggregates
 * `daily_scores` rows. With no users having made streak
 * predictions in the demo, the table was empty, and the home page
 * showed "No forecasters on the board yet" indefinitely.
 *
 * This script writes 5 demo forecasters' `daily_scores` rows for
 * the current UTC week so the home page's `TopForecasters`
 * component (which reads `/leaderboard/week?limit=5`) shows real
 * data immediately. Idempotent: re-running clears the demo rows
 * first and re-inserts them.
 *
 * **R-UAT-FN-19.1 follow-up.** This script is now redundant for
 * production: the same demo seed runs automatically at agent-service
 * boot via `apps/agents/src/agents/leaderboard-demo-seed.ts`. The
 * script is retained for manual operator use (e.g. forcing a re-seed
 * mid-debug session, or running on a local dev DB without
 * restarting the service). Use `pnpm seed:leaderboard:clear` from
 * the `apps/agents/` package to remove the demo rows without a
 * service restart.
 *
 * Demo addresses: deployer (always rank #1) + 4 placeholder
 * addresses. The placeholders are well-formed 32-byte hex but
 * don't correspond to any real account.
 *
 * Streak semantics mirror the on-chain
 * `streak_system::record_participation` Move contract: a miss
 * resets `current_streak` to 0; a correct day increments by 1.
 *
 * Usage:
 *   cd apps/agents
 *   node scripts/seed-leaderboard.mjs [--clear-only]
 */
import Database from "better-sqlite3";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import "dotenv/config";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
function findRepoDotenv(start) {
  let cur = resolve(start);
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(cur, ".env");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(cur, "..");
    if (parent === cur) break;
    cur = parent;
  }
}
const envPath = findRepoDotenv(process.cwd());
if (envPath) { const { config } = await import("dotenv"); config({ path: envPath }); }

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, "..", "..");
const dbPath = resolve(__dirname, "data/gamification.db");
const db = new Database(dbPath);

// Compute the current week index (UTC-aligned weeks since epoch,
// same as `weekIndexFor` in the leaderboard-worker).
function currentWeekIndex() {
  const now = Date.now();
  const day = Math.floor(now / 86400000);
  return Math.floor(day / 7);
}
const week = currentWeekIndex();
const dayStart = week * 7;

// Demo addresses. The agent/deployer always tops the
// leaderboard; the other 4 are placeholders with a realistic
// distribution of scores. These match the TypeScript seed in
// `apps/agents/src/agents/leaderboard-demo-seed.ts` so a
// developer running either path sees consistent output.
const deployer = process.env.AGENT_PRIVATE_KEY
  ? Ed25519Keypair.fromSecretKey(process.env.AGENT_PRIVATE_KEY).getPublicKey().toSuiAddress()
  : "0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716";

const placeholderData = [
  { addr: "0x4e2b8a3c5f7d9e1b3a5c7f9e1d3b5a7c9e1f3d5b7a9c1e3f5d7b9a1c3e5f7d9b1", weekPattern: 0b0111111 }, // rank-2: 6/7 (miss day 6)
  { addr: "0x1f9c2e4d6b8a1c3e5f7d9b1a3c5e7f9d1b3a5c7e9f1d3b5a7c9e1f3d5b7a9c1e3f", weekPattern: 0b1110111 }, // rank-3: 6/7 (miss day 3)
  { addr: "0x6b7d9e1f3a5c7b9d1e3f5a7c9b1d3e5f7a9c1b3d5e7f9a1c3b5d7e9f1a3c5b7d9e", weekPattern: 0b1011101 }, // rank-4: 5/7 (miss days 1,5)
  { addr: "0x3e8a1c5b7d9f3e5a7c1b9d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7", weekPattern: 0b0100111 }, // rank-5: 4/7 (miss days 3,4,6)
];

const insert = db.prepare(`INSERT OR REPLACE INTO daily_scores
  (user, day_index, participated, all_correct, streak_after, category)
  VALUES (?, ?, ?, ?, ?, ?)`);

function clearUser(addr) {
  for (let d = dayStart; d < dayStart + 7; d++) {
    db.prepare("DELETE FROM daily_scores WHERE user = ? AND day_index = ?").run(addr, d);
  }
}

function isCorrect(weekPattern, d) {
  return ((weekPattern >> d) & 1) === 1 ? 1 : 0;
}

// Move contract semantics: current_streak resets to 0 on any
// non-ALL_CORRECT outcome. See
// `packages/contracts/sources/streak_system.move`.
function computeStreakSeries(weekPattern) {
  const result = [];
  let streak = 0;
  for (let d = 0; d < 7; d++) {
    if (isCorrect(weekPattern, d) === 1) {
      streak += 1;
    } else {
      streak = 0;
    }
    result.push(streak);
  }
  return result;
}

function seedOne(addr, weekPattern) {
  clearUser(addr);
  const streaks = computeStreakSeries(weekPattern);
  for (let d = 0; d < 7; d++) {
    insert.run(addr, dayStart + d, 1, isCorrect(weekPattern, d), streaks[d], 0);
  }
}

const clearOnly = process.argv.includes("--clear-only");
if (clearOnly) {
  clearUser(deployer);
  for (const p of placeholderData) clearUser(p.addr);
  console.log(`Cleared demo daily_scores rows for week ${week}.`);
  process.exit(0);
}

seedOne(deployer, 0b1111111); // 7/7 correct
for (const p of placeholderData) seedOne(p.addr, p.weekPattern);

const expected = [
  { user: deployer, correct: 7, streak: 7 },
  { user: placeholderData[0].addr, correct: 6, streak: 6 },
  { user: placeholderData[1].addr, correct: 6, streak: 3 },
  { user: placeholderData[2].addr, correct: 5, streak: 3 },
  { user: placeholderData[3].addr, correct: 4, streak: 3 },
];
expected.sort((a, b) => (b.correct + 0.01 * b.streak) - (a.correct + 0.01 * a.streak));
console.log(`Seeded ${expected.length} demo forecasters for week ${week}:`);
for (let i = 0; i < expected.length; i++) {
  const e = expected[i];
  const score = (e.correct + 0.01 * e.streak).toFixed(2);
  console.log(`  Rank ${i + 1}: ${e.user.slice(0, 18)}...  score=${score}  (${e.correct} correct, ${e.streak}-day streak)`);
}
console.log(`\nRun with --clear-only to remove the demo rows.`);
console.log(`The boot path also seeds these rows automatically; see`);
console.log(`  apps/agents/src/agents/leaderboard-demo-seed.ts`);
db.close();
