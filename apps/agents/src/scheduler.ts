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

const POLL_MS = Number(process.env.AGENT_POLL_INTERVAL_MS ?? 60_000);

// Per-entry "currently running" flags. If a previous tick for an
// agent is still in flight when the next cron boundary arrives,
// the new tick is skipped (logged) rather than queued. Without
// this guard, a slow streak-sweeper or position-indexer run can
// pile up overlapping PTB batches and OOM the node, or worse,
// double-write daily_scores rows. The flag is keyed by entry.name
// (not a global counter) so other agents are unaffected.
const inFlight = new Set<string>();
// Active timer handles per agent. Cleared on stopScheduler so a
// SIGTERM during a quiet period doesn't leave orphan timers firing
// after the process is supposed to be gone.
const activeTimers = new Map<string, NodeJS.Timeout>();
let shuttingDown = false;

export function startScheduler(
  ctx: AgentContext,
  entries: ScheduleEntry[],
): void {
  for (const entry of entries) scheduleNext(ctx, entry);
}

/**
 * Stop scheduling new agent runs and cancel pending timers. Waits
 * up to `graceMs` for any in-flight agent to finish (the
 * `inFlight` set above) before resolving. Called from the
 * SIGTERM/SIGINT handler in index.ts so Railway redeploys and
 * Ctrl-C drain the queue instead of aborting mid-PTB.
 */
export function stopScheduler(graceMs = 5_000): Promise<void> {
  if (shuttingDown) return Promise.resolve();
  shuttingDown = true;
  for (const t of activeTimers.values()) clearTimeout(t);
  activeTimers.clear();
  const deadline = Date.now() + graceMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (inFlight.size === 0 || Date.now() >= deadline) {
        if (inFlight.size > 0) {
          console.warn(
            `[scheduler] Shutdown deadline hit with ${inFlight.size} agent(s) still in flight: ${Array.from(inFlight).join(", ")}. ` +
              "Forcing exit; in-flight PTBs may be left in a partial state on the RPC.",
          );
        } else {
          console.log("[scheduler] All agents drained cleanly.");
        }
        resolve();
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function scheduleNext(ctx: AgentContext, entry: ScheduleEntry): void {
  if (shuttingDown) return;
  const delay = msUntilNext(entry.cron);
  const timer = setTimeout(async () => {
    activeTimers.delete(entry.name);
    if (shuttingDown) return;
    if (inFlight.has(entry.name)) {
      console.warn(
        `[scheduler] ${entry.name} still running from previous tick; skipping this fire.`,
      );
    } else {
      inFlight.add(entry.name);
      try {
        const result = await entry.fn(ctx);
        console.log(
          `[scheduler] ${entry.name} → ${result.action}: ${result.reasoning.slice(0, 100)}`,
        );
      } catch (err) {
        console.error(`[scheduler] ${entry.name} crashed:`, err);
      } finally {
        inFlight.delete(entry.name);
      }
    }
    scheduleNext(ctx, entry);
  }, delay);
  activeTimers.set(entry.name, timer);
  console.log(
    `[scheduler] ${entry.name} next in ${Math.round(delay / 1000)}s (${entry.cron})`,
  );
}

/** Compute ms from now until the next fire time for the given cron expr. */
export function msUntilNext(expr: string, now: Date = new Date()): number {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`bad cron: ${expr}`);
  }
  const [minute, hour, , , dow] = parts;
  if (!minute || !hour || !dow) {
    throw new Error(`bad cron: ${expr}`);
  }

  // Walk forward up to 8 days to find the next match
  for (let i = 0; i < 8 * 24 * 60; i++) {
    const candidate = new Date(now.getTime() + i * 60_000);
    if (!matchesPart(minute, candidate.getUTCMinutes())) continue;
    if (!matchesPart(hour, candidate.getUTCHours())) continue;
    if (dow !== "*" && !matchesPart(dow, candidate.getUTCDay())) continue;
    if (candidate.getUTCSeconds() !== 0) continue;
    if (candidate.getTime() <= now.getTime()) continue;
    return candidate.getTime() - now.getTime();
  }
  // Shouldn't happen for valid input, but never starve the loop
  return POLL_MS;
}

function matchesPart(part: string, value: number): boolean {
  if (part === "*") return true;
  if (part.startsWith("*/")) {
    const n = Number(part.slice(2));
    return n > 0 && value % n === 0;
  }
  const num = Number(part);
  return Number.isFinite(num) && num === value;
}
