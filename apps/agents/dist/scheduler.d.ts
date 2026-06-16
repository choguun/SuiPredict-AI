/**
 * Per-agent UTC cron scheduler.
 *
 * Replaces the previous "run all agents on a 15s setInterval" model. Each
 * agent declares a 5-field cron expression (UTC) and the scheduler fires
 * it at the next boundary. A self-rescheduling `setTimeout` keeps the
 * cycle going without depending on `node-cron`.
 *
 * Supported cron forms (intentionally minimal — covers all the agents):
 *   - "M H * * *"   daily at H:M UTC                (M, H integers)
 *   - "M H * * D"   weekly on D (0=Sun..6=Sat) at H:M
 *   - "star/N * * * *"  every N minutes (write `star` literally;
 *     the leading forward slash inside JSDoc would otherwise close
 *     this comment block prematurely)
 *
 * The pollMs argument is the safety net — if a clock skew or long-running
 * agent delays the next fire, the timer re-aligns within `pollMs`.
 */
import type { AgentContext } from "./lib.js";
import type { AgentResult } from "./lib.js";
export type AgentFn = (ctx: AgentContext) => Promise<AgentResult>;
export interface ScheduleEntry {
    name: string;
    cron: string;
    fn: AgentFn;
}
export declare function startScheduler(ctx: AgentContext, entries: ScheduleEntry[]): void;
/**
 * Stop scheduling new agent runs and cancel pending timers. Waits
 * up to `graceMs` for any in-flight agent to finish (the
 * `inFlight` set above) before resolving. Called from the
 * SIGTERM/SIGINT handler in index.ts so Railway redeploys and
 * Ctrl-C drain the queue instead of aborting mid-PTB.
 */
export declare function stopScheduler(graceMs?: number): Promise<void>;
/** Compute ms from now until the next fire time for the given cron expr. */
export declare function msUntilNext(expr: string, now?: Date): number;
//# sourceMappingURL=scheduler.d.ts.map