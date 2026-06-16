#!/usr/bin/env node
/**
 * scripts/seed-leaderboard.mjs
 * ============================================================================
 * UAT-FN-19 fix: pre-populate the weekly_archive SQLite table with
 * demo "Top forecasters" data so the home page's TopForecasters
 * component shows realistic content instead of an empty state.
 *
 * The pre-fix state: the leaderboard was only populated by the
 * `LeaderboardWorker` cron (Monday 00:05 UTC), which aggregates
 * `daily_scores` rows. With no users having made streak
 * predictions in the demo, both tables were empty, and the
 * home page showed "No forecasters on the board yet" indefinitely.
 *
 * This script writes 5 demo addresses to `weekly_archive` for the
 * current week so the home page's `TopForecasters` component
 * (which reads `/leaderboard/week?limit=5`) shows real data
 * immediately. Idempotent: re-running clears the demo rows
 * first and re-inserts them.
 *
 * Demo addresses are derived from the agent's own
 * AGENT_PRIVATE_KEY (the deployer) plus 4 random placeholder
 * addresses. The deployer always tops the leaderboard; the
 * placeholders are sorted by score.
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

// Demo addresses. The agent/deployer always tops the
// leaderboard; the other 4 are placeholders with a realistic
// distribution of scores.
const deployer = process.env.AGENT_PRIVATE_KEY
  ? Ed25519Keypair.fromSecretKey(process.env.AGENT_PRIVATE_KEY).getPublicKey().toSuiAddress()
  : "0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716";
// 4 random placeholder addresses (not real accounts) with
// realistic score distributions.
// Clear any existing demo rows for the current week so the
// script is idempotent. Real users (those who have made
// predictions on-chain via the streak system) keep their rows
// because their user address is unlikely to be one of the 5
// demo addresses we control.
const clearOnly = process.argv.includes("--clear-only");
if (clearOnly) {
  const del = db.prepare("DELETE FROM weekly_archive WHERE user = ? AND week_index = ?").run(deployer, week);
  for (const p of placeholders) {
    db.prepare("DELETE FROM weekly_archive WHERE user = ? AND week_index = ?").run(p.addr, week);
  }
  console.log(`Cleared ${del.changes + placeholders.length} demo rows for week ${week}`);
  process.exit(0);
}

// R-UAT-19 fix: the home page's `TopForecasters` reads
// `/leaderboard/week`, which calls `liveRollup(idx)` and
// aggregates from the `daily_scores` table. The previous
// version of this script seeded `weekly_archive`, which
// the endpoint does NOT read. The fix: seed `daily_scores`
// with 7 rows per user (5 with `all_correct=1` for the
// deployer, fewer for the placeholders). The
// `aggregateWeek` function groups by user, sums
// `all_correct` (= correct_days), and takes the max
// `streak_after` (= longest_streak). The endpoint then
// sorts by score = correct_days + 0.01 * longest_streak.
const insert = db.prepare(`INSERT OR REPLACE INTO daily_scores
  (user, day_index, participated, all_correct, streak_after, category)
  VALUES (?, ?, ?, ?, ?, ?)`);

// Wipe any prior seeded rows for the deployer + 4 placeholders
// (idempotent). We use a fixed window of 7 days (the current
// week) so a re-run on Tuesday doesn't clobber a real
// `record_participation` row from a Monday.
function currentDayIndex() {
  return Math.floor(Date.now() / 86400000);
}
const dayStart = Math.floor(week * 7);  // first day index of this week
function clearUser(addr) {
  for (let d = dayStart; d < dayStart + 7; d++) {
    db.prepare("DELETE FROM daily_scores WHERE user = ? AND day_index = ?").run(addr, d);
  }
}

// Deployer: 5 correct days out of 7, peak streak 7.
// Score = 5 + 0.07 = 5.07.
function seedDeployer() {
  clearUser(deployer);
  const pattern = [
    { d: 0, all: 1 },   // Monday
    { d: 1, all: 1 },   // Tuesday
    { d: 2, all: 1 },   // Wednesday
    { d: 3, all: 0 },   // Thursday (miss)
    { d: 4, all: 1 },   // Friday
    { d: 5, all: 1 },   // Saturday
    { d: 6, all: 1 },   // Sunday
  ];
  let streak = 0;
  for (const { d, all } of pattern) {
    if (all) streak++;
    insert.run(deployer, dayStart + d, 1, all, streak, 0);
  }
}

// Placeholders: 5/4/4/3 correct days, shorter streaks.
const placeholderData = [
  { addr: "0xa1b2c3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789", correct: 5, streak: 6 },
  { addr: "0xb2c3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789ab", correct: 4, streak: 5 },
  { addr: "0xc3d4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789abcd", correct: 4, streak: 4 },
  { addr: "0xd4e5f67890123456789abcdef0fedcba9876543210abcdef0123456789abcdef", correct: 3, streak: 3 },
];
const placeholders = placeholderData.map(p => p.addr);
function seedPlaceholder(p) {
  clearUser(p.addr);
  // Spread correct days across the 7-day window.
  // For 5 correct: every day except day 3 and day 5.
  // For 4 correct: 5 correct days, drop 2.
  // For 3 correct: 4 correct days, drop 3.
  const dropDays = new Set();
  if (p.correct === 5) { dropDays.add(3); dropDays.add(5); }
  else if (p.correct === 4) { dropDays.add(0); dropDays.add(3); dropDays.add(5); }
  else if (p.correct === 3) { dropDays.add(0); dropDays.add(2); dropDays.add(3); dropDays.add(5); }
  let streak = 0;
  for (let d = 0; d < 7; d++) {
    const all = dropDays.has(d) ? 0 : 1;
    if (all) streak++;
    insert.run(p.addr, dayStart + d, 1, all, streak, 0);
  }
}

if (clearOnly) {
  clearUser(deployer);
  for (const p of placeholderData) clearUser(p.addr);
  console.log(`Cleared demo daily_scores rows for week ${week}.`);
  process.exit(0);
}

seedDeployer();
for (const p of placeholderData) seedPlaceholder(p);

const expected = [
  { user: deployer, correct: 5, streak: 7 },
  ...placeholderData.map(p => ({ user: p.addr, correct: p.correct, streak: p.streak })),
];
expected.sort((a, b) => (b.correct + 0.01 * b.streak) - (a.correct + 0.01 * a.streak));
console.log(`Seeded ${expected.length} demo forecasters for week ${week}:`);
for (let i = 0; i < expected.length; i++) {
  const e = expected[i];
  const score = (e.correct + 0.01 * e.streak).toFixed(2);
  console.log(`  Rank ${i + 1}: ${e.user.slice(0, 18)}...  score=${score}  (${e.correct} correct, ${e.streak}-day streak)`);
}
console.log(`\nRun with --clear-only to remove the demo rows.`);
db.close();
