import type { AgentContext, AgentResult } from "../lib.js";
import { fetchMatchResult } from "./world-cup-fetcher.js";
export declare function runWorldCupResolver(ctx: AgentContext): Promise<AgentResult>;
/**
 * Diagnostic: list all WC markets whose kickoff falls inside the
 * `windowMs` window from now (or have already started but not yet
 * resolved). The home page "live & upcoming" ticker and the world-cup
 * dashboard both consume this to surface a "match about to start!"
 * teaser.
 *
 * R30 sweep fix: the previous filter was
 * `Math.abs(m.expiry_ms - now) < 24h` — a "markets
 * expiring in the next 24h" predicate, not a
 * "matches about to start" one. With the seeded
 * `expiry_ms = kickoff + 2h`, a 4-day-out match had
 * `expiry_ms - now > 24h` and was silently
 * dropped; the dashboard rendered an empty
 * "upcoming" list and a user landing mid-tournament
 * saw nothing live. The new filter derives
 * `kickoff = expiry - 2h` and returns markets whose
 * kickoff is within the window (with a generous
 * `-2h` tail so matches that started <2h ago —
 * i.e. live now — are also surfaced). The 24h
 * window default from the `/wc/upcoming` route is
 * preserved, so no caller needs to change.
 */
export declare function upcomingWcMarkets(windowMs?: number): Array<{
    id: string;
    title: string;
    kickoffIn: number;
}>;
export { fetchMatchResult };
//# sourceMappingURL=world-cup-resolver.d.ts.map