/**
 * Leaderboard worker — 00:05 UTC Monday cron.
 *
 * Aggregates the prior week's `daily_scores` into a `weekly_archive`
 * snapshot. The score formula is:
 *
 *   score = correct_days + 0.01 * longest_streak
 *
 * (1 point per correct day, 1% of longest streak as a tiebreaker — kept
 * separate from rank so ties are still resolvable.)
 *
 * Also exposes a small `runLiveRollup()` callable from REST for ad-hoc
 * snapshots and from `prize-distributor` to determine the top-N.
 *
 * The on-chain `UserProfile` is the source of truth for `country_code`
 * and `forecaster_kind`; we mirror those into `user_profiles` via the
 * position-indexer and use `getUserProfilesForUsers` to enrich the
 * live rollup with `country_code` for the per-country leaderboard
 * endpoint.
 */
import {
  archiveWeekly,
  claimedUsersForWeek,
  clearDailyScoresBefore,
  getUserProfilesForUsers,
  listAllDailyScores,
  type DailyScore,
  type WeeklyRow,
  weekIndexFor,
  weekIndexForDay,
} from "../gamification/store.js";
import type { AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";

const WEEK_MS = 7 * 86_400_000;

function aggregateWeek(
  weekIndex: number,
  rows: DailyScore[],
): WeeklyRow[] {
  const bucket = new Map<
    string,
    { correct_days: number; longest_streak: number; category: number }
  >();
  for (const r of rows) {
    if (weekIndexForDay(r.day_index) !== weekIndex) continue;
    const cur = bucket.get(r.user) ?? {
      correct_days: 0,
      longest_streak: 0,
      category: r.category,
    };
    cur.correct_days += r.all_correct;
    cur.longest_streak = Math.max(cur.longest_streak, r.streak_after);
    if (cur.category === 0) cur.category = r.category;
    bucket.set(r.user, cur);
  }
  const out: WeeklyRow[] = Array.from(bucket.entries()).map(
    ([user, v]) => ({
      user,
      week_index: weekIndex,
      score: v.correct_days + 0.01 * v.longest_streak,
      rank: 0,
      correct_days: v.correct_days,
      longest_streak: v.longest_streak,
      category: v.category,
    }),
  );
  out.sort((a, b) => b.score - a.score);
  out.forEach((r, i) => (r.rank = i + 1));
  return out;
}

export async function runLeaderboardWorker(): Promise<AgentResult> {
  const now = Date.now();
  const currentWeek = weekIndexFor(now);
  const priorWeek = currentWeek - 1;
  // Exclusive cutoff: first day of the current week. `daily_scores`
  // is keyed by `day_index` (a UTC day number, e.g. 20000 for ~2024),
  // NOT milliseconds. A previous version of this function multiplied
  // the day value by 86_400_000 and passed it to
  // `clearDailyScoresBefore`, which then deleted every row in the
  // table (cutoffMs = ~1.34B vs day_index = ~28000, the `WHERE
  // day_index < ?` matched everything). Pass the day value directly.
  const cutoffDay = Math.floor((priorWeek + 1) * 7);

  const rows = listAllDailyScores();
  const weekly = aggregateWeek(priorWeek, rows);
  if (weekly.length === 0) {
    return recordResult("LeaderboardWorker", {
      action: "noop",
      reasoning: `No daily scores for week ${priorWeek}.`,
      confidence: 100,
    });
  }
  archiveWeekly(weekly);
  const cleared = clearDailyScoresBefore(cutoffDay);

  return recordResult("LeaderboardWorker", {
    action: "rollup",
    reasoning: `Week ${priorWeek}: archived ${weekly.length} rows, cleared ${cleared} stale daily rows.`,
    confidence: 100,
  });
}

/**
 * Annotate every row in `weekly` with `country_code` and `claimed` so
 * the REST layer can return a complete payload without an extra
 * indexer hop. Called by `liveRollup` and `countryRollup` — the
 * claimed annotation is a one-pass lookup against `prize_claims`,
 * the country annotation is one bulk lookup against `user_profiles`.
 */
function enrichRows(weekIndex: number, weekly: WeeklyRow[]): WeeklyRow[] {
  const claimed = claimedUsersForWeek(weekIndex);
  const profiles = getUserProfilesForUsers(weekly.map((r) => r.user));
  for (const r of weekly) {
    r.claimed = claimed.has(r.user);
    const p = profiles.get(r.user);
    if (p?.country_code) r.country_code = p.country_code;
  }
  return weekly;
}

/**
 * Live rollup for a given week — uses whatever daily scores are
 * currently in the table. Useful for REST endpoints that want a
 * "what would the leaderboard look like if I rolled it up now" view.
 */
export function liveRollup(weekIndex: number, category?: number): WeeklyRow[] {
  const rows = listAllDailyScores();
  let weekly = aggregateWeek(weekIndex, rows);
  if (category != null && category > 0) {
    weekly = weekly.filter((r) => r.category === category);
    weekly.forEach((r, i) => (r.rank = i + 1));
  }
  return enrichRows(weekIndex, weekly);
}

/**
 * Live rollup filtered to a single ISO-3166-1 alpha-2 country code.
 * Excludes users without a `UserProfile` row or with an empty
 * `country_code` (i.e. opted-out of the national leaderboard). The
 * `code` is matched case-insensitively — the on-chain module is
 * case-insensitive by virtue of only accepting bytes that the user
 * typed, and we mirror that policy in the off-chain table.
 *
 * Returns the rows with `country_code` filled in so the UI can render
 * a flag without a second lookup.
 */
export function countryRollup(
  weekIndex: number,
  code: string,
  category?: number,
): WeeklyRow[] {
  const normalized = code.toLowerCase();
  if (!/^[a-z]{2,8}$/.test(normalized)) return [];
  const all = liveRollup(weekIndex, category);
  const filtered = all.filter(
    (r) => r.country_code && r.country_code === normalized,
  );
  filtered.forEach((r, i) => (r.rank = i + 1));
  return filtered;
}

export { WEEK_MS };
