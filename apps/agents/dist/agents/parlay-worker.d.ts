import type { AgentContext, AgentResult } from "../lib.js";
/**
 * Process all unfinalized parlays: record each pending leg whose
 * underlying market is resolved, then finalize any parlay whose
 * `legs_recorded == leg_count`.
 *
 * Returns a short, human-readable summary for the cron log; the
 * exact digest trail goes through `recordResult` (which already
 * appends to `decisions`).
 */
export declare function runParlayWorker(ctx: AgentContext): Promise<AgentResult>;
//# sourceMappingURL=parlay-worker.d.ts.map