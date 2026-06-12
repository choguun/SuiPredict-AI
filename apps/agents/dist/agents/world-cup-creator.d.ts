import type { AgentContext, AgentResult } from "../lib.js";
/**
 * SQLite-backed dedupe for "did we already create a market for this
 * match?" The table is auto-created by `markets/store.ts` in a
 * shared db file (`markets.db`); the `wc_match_id` column has a
 * unique index so the ON CONFLICT INSERT keeps the original row.
 *
 * R56: lazy-import the store to avoid a circular dep.
 */
type WcMatchMarketRow = {
    market_id: string;
    wc_match_id: string;
    home_code: string;
    away_code: string;
    kickoff_ms: number;
    created_at_ms: number;
};
export declare function runWorldCupCreator(ctx: AgentContext): Promise<AgentResult>;
/**
 * Convenience helper for the home page / leaderboard: how many
 * "worldcup" category markets are currently active.
 */
export declare function activeWcMarketCount(): number;
export type { WcMatchMarketRow };
//# sourceMappingURL=world-cup-creator.d.ts.map