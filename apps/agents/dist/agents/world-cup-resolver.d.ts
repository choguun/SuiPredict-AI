import type { AgentContext, AgentResult } from "../lib.js";
import { fetchMatchResult } from "./world-cup-fetcher.js";
export declare function runWorldCupResolver(ctx: AgentContext): Promise<AgentResult>;
/**
 * Diagnostic: list all WC markets that are within 1h of expiry and
 * not yet resolved. The leaderboard / agents page uses this to
 * surface a "match about to start!" teaser.
 */
export declare function upcomingWcMarkets(windowMs?: number): Array<{
    id: string;
    title: string;
    kickoffIn: number;
}>;
export { fetchMatchResult };
//# sourceMappingURL=world-cup-resolver.d.ts.map