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
  archiveAndClearAtomic,
  claimedUsersForWeek,
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
  // R56 audit fix: assign `rank` by building new objects
  // instead of mutating the existing `r.rank`. The previous
  // `out.forEach((r, i) => (r.rank = i + 1))` mutated the
  // row instances in place, and the same `WeeklyRow`s flow
  // into `enrichRows` which mutates `r.claimed` /
  // `r.country_code` again. A future optimization that
  // memoized the result across requests would have its
  // data silently corrupted by the next leaderboard poll.
  return out.map((r, i) => ({ ...r, rank: i + 1 }));
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
  // R56 audit fix: wrap the archive + clear in a single
  // transaction. The previous code called them sequentially
  // outside a transaction, so a SIGTERM (or Railway
  // healthcheck-triggered SIGKILL) between them left the prior
  // week's daily_scores rows intact AND no archived row. The
  // next tick re-archives (idempotent on PK) but the
  // cleared-rows intent is lost — the wrong week could be
  // cleared if the cutoffDay math drifted. With a single
  // transaction either both succeed or neither does; a crash
  // leaves the system in a recoverable state.
  const { archived, cleared } = archiveAndClearTransactional(
    weekly,
    cutoffDay,
  );

  return recordResult("LeaderboardWorker", {
    action: "rollup",
    reasoning: `Week ${priorWeek}: archived ${archived} rows, cleared ${cleared} stale daily rows.`,
    confidence: 100,
  });
}

/**
 * R56 audit fix: transaction wrapper for the archive + clear
 * pair. The two operations are logically one (the prior week's
 * rollup is committed iff the day's daily_scores are cleared);
 * a crash between them was a real failure mode under the
 * 1-minute Railway healthcheck window. The actual transaction
 * lives in the gamification store via `archiveAndClearAtomic`
 * (added alongside this fix) so the leaderboard-worker doesn't
 * have to know about the SQLite handle.
 */
function archiveAndClearTransactional(
  weekly: WeeklyRow[],
  cutoffDay: number,
): { archived: number; cleared: number } {
  return archiveAndClearAtomic(weekly, cutoffDay);
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
  // R56 audit fix: build new objects instead of mutating `r.claimed`
  // and `r.country_code` in place. A `JSON.stringify(weekly)`-style
  // caller that holds onto a previous reference would see its data
  // modified by the next request. The leaderboard-worker doesn't
  // currently cache the rows, but a future optimization that holds
  // the result in a memo would be silently corrupted.
  return weekly.map((r) => {
    const p = profiles.get(r.user);
    return {
      ...r,
      claimed: claimed.has(r.user),
      country_code: p?.country_code ?? r.country_code,
    };
  });
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
    // R56 audit fix: rebuild the rows so the `rank` reassignment
    // doesn't mutate the same instances `enrichRows` reads below.
    // The previous `weekly.forEach((r, i) => (r.rank = i + 1))`
    // mutated the filter result in place, which then propagated
    // into the `WeeklyRow` returned to REST callers.
    weekly = weekly.map((r, i) => ({ ...r, rank: i + 1 }));
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
  // R57 agents audit fix: rank via `.map` (new array) rather than
  // in-place `.forEach` mutation. R56 fixed `liveRollup` but missed
  // this call site; the rank field would survive across ticks if a
  // caller cached the array.
  return filtered.map((r, i) => ({ ...r, rank: i + 1 }));
}

export { WEEK_MS };
