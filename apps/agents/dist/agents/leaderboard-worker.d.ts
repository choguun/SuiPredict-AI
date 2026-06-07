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
import { type WeeklyRow } from "../gamification/store.js";
import type { AgentResult } from "../lib.js";
declare const WEEK_MS: number;
export declare function runLeaderboardWorker(): Promise<AgentResult>;
/**
 * Live rollup for a given week — uses whatever daily scores are
 * currently in the table. Useful for REST endpoints that want a
 * "what would the leaderboard look like if I rolled it up now" view.
 */
export declare function liveRollup(weekIndex: number, category?: number): WeeklyRow[];
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
export declare function countryRollup(weekIndex: number, code: string, category?: number): WeeklyRow[];
export { WEEK_MS };
//# sourceMappingURL=leaderboard-worker.d.ts.map