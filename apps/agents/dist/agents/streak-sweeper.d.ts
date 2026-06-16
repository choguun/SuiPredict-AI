import type { AgentContext, AgentResult } from "../lib.js";
interface ResolvedUser {
    user: string;
    outcome: 0 | 1 | 2;
    category: 0 | 1 | 2 | 3;
    streakId?: string;
    /** Gap to backfill (number of consecutive NOT_SUBMITTED days before `dayIndex`). */
    backfillDays?: number;
}
/**
 * Compute the resolved outcomes for `dayIndex`.
 *
 * Strategy (off-chain indexer, JSON-RPC):
 *   1. Pull all `MarketCreatedEvent`s; the daily markets for `dayIndex`
 *      are those whose `expiry_ms` falls in [day_start, day_end).
 *   2. Pull all `MarketResolvedEvent`s and build a map of resolved
 *      outcomes for the daily markets.
 *   3. Pull all `MintedEvent`s for the daily markets whose timestamp
 *      falls in the day window, and group by user.
 *   4. For each user, the outcome is:
 *        - AllCorrect   — minted on every daily market AND every market
 *                         is resolved (MVP proxy; direction-aware check
 *                         requires reading the user's YES/NO balance
 *                         which is left as a TODO for v2)
 *        - SomeWrong    — minted on at least one daily market, but not
 *                         all of them are resolved
 *
 * Note: this impl currently emits only users who minted that day. A
 * full implementation would also walk the `StreakRegistry` and emit
 * `NotSubmitted` for users who had a streak but didn't mint. That's
 * left as a TODO below; the off-chain `daily_scores` table is the
 * source of truth for the leaderboard, so the missing NotSubmitted
 * cases only affect the on-chain streak number, not the score.
 */
export declare function resolveDayOutcomes(dayIndex: number): Promise<ResolvedUser[]>;
export declare function runStreakSweeper(ctx: AgentContext): Promise<AgentResult>;
export {};
//# sourceMappingURL=streak-sweeper.d.ts.map