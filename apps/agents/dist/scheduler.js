// R55 audit fix: read `AGENT_POLL_INTERVAL_MS` at call
// time inside `msUntilNext` rather than once at module
// load. The previous module-level const froze the value
// at import time, so a `bootstrap-env.ts` mid-flight
// rotation (a common operator move during a debug
// session) was silently ignored for the rest of the
// process lifetime. The `index.ts:557` boot log also
// reads `process.env.AGENT_POLL_INTERVAL_MS` at call
// time — without this fix the boot log and the actual
// scheduler value could disagree by up to one tick.
function readPollMs() {
    const raw = process.env.AGENT_POLL_INTERVAL_MS;
    if (!raw)
        return 60_000;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        console.warn(`[scheduler] AGENT_POLL_INTERVAL_MS="${raw}" is invalid; using default 60000.`);
        return 60_000;
    }
    return n;
}
// Per-entry "currently running" flags. If a previous tick for an
// agent is still in flight when the next cron boundary arrives,
// the new tick is skipped (logged) rather than queued. Without
// this guard, a slow streak-sweeper or position-indexer run can
// pile up overlapping PTB batches and OOM the node, or worse,
// double-write daily_scores rows. The flag is keyed by entry.name
// (not a global counter) so other agents are unaffected.
const inFlight = new Set();
// R43 audit fix: per-entry consecutive-failure tracking. A
// persistently-failing worker (RPC outage, bad env, missing
// object id) previously hammered the public RPC at full cron
// cadence — every tick fired `await entry.fn(ctx)` which threw
// → logged → re-armed. Over a 1h outage that meant
// `risk-monitor` (5min cron) fired 12 doomed attempts and
// `position-indexer` (1min cron) fired 60. With backoff, a
// failure resets the schedule to `min(2^failures × 30s, 5m)`,
// so a 1h outage costs 12 attempts total (one per backoff
// escalation) instead of 60. A successful run resets the
// counter to 0 and the worker resumes normal cron cadence.
const failureState = new Map();
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 5 * 60_000;
// Active timer handles per agent. Cleared on stopScheduler so a
// SIGTERM during a quiet period doesn't leave orphan timers firing
// after the process is supposed to be gone.
const activeTimers = new Map();
let shuttingDown = false;
export function startScheduler(ctx, entries) {
    for (const entry of entries)
        scheduleNext(ctx, entry);
}
/**
 * Stop scheduling new agent runs and cancel pending timers. Waits
 * up to `graceMs` for any in-flight agent to finish (the
 * `inFlight` set above) before resolving. Called from the
 * SIGTERM/SIGINT handler in index.ts so Railway redeploys and
 * Ctrl-C drain the queue instead of aborting mid-PTB.
 */
export function stopScheduler(graceMs = 5_000) {
    if (shuttingDown)
        return Promise.resolve();
    shuttingDown = true;
    for (const t of activeTimers.values())
        clearTimeout(t);
    activeTimers.clear();
    const deadline = Date.now() + graceMs;
    return new Promise((resolve) => {
        const tick = () => {
            if (inFlight.size === 0 || Date.now() >= deadline) {
                if (inFlight.size > 0) {
                    console.warn(`[scheduler] Shutdown deadline hit with ${inFlight.size} agent(s) still in flight: ${Array.from(inFlight).join(", ")}. ` +
                        "Forcing exit; in-flight PTBs may be left in a partial state on the RPC.");
                }
                else {
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
function scheduleNext(ctx, entry) {
    if (shuttingDown)
        return;
    const cronDelay = msUntilNext(entry.cron);
    // R43 audit fix: if the previous tick failed, defer the next
    // fire by an exponential backoff. `nextEligibleAt` is
    // recorded in the failure-state map (set on throw, cleared
    // on success). We schedule at `max(cronDelay,
    // msUntilNextEligible)` so a worker that was on a 1min cron
    // but failed 3 times in a row fires no sooner than 4min from
    // the failure — not 1min on the dot.
    const fail = failureState.get(entry.name);
    const backoffDelay = fail && fail.failures > 0
        ? Math.min(BACKOFF_BASE_MS * 2 ** (fail.failures - 1), BACKOFF_MAX_MS)
        : 0;
    const eligibleAt = fail?.nextEligibleAt ?? 0;
    const remainingBackoff = Math.max(0, eligibleAt - Date.now());
    const delay = Math.max(cronDelay, remainingBackoff);
    const timer = setTimeout(async () => {
        activeTimers.delete(entry.name);
        if (shuttingDown)
            return;
        if (inFlight.has(entry.name)) {
            console.warn(`[scheduler] ${entry.name} still running from previous tick; skipping this fire.`);
        }
        else {
            inFlight.add(entry.name);
            try {
                const result = await entry.fn(ctx);
                // Successful run: reset the failure counter so the
                // worker resumes normal cron cadence. The next
                // scheduleNext() below will use the raw `cronDelay`
                // because the failure state is cleared.
                failureState.delete(entry.name);
                console.log(`[scheduler] ${entry.name} → ${result.action}: ${result.reasoning.slice(0, 100)}`);
            }
            catch (err) {
                // Bump the consecutive-failure counter and push the
                // next eligible-fire time out. Cap `failures` at 10
                // to keep the `2^failures` math from overflowing JS
                // double (would still cap at BACKOFF_MAX_MS via
                // Math.min in scheduleNext).
                const prev = failureState.get(entry.name) ?? {
                    failures: 0,
                    nextEligibleAt: 0,
                };
                const failures = Math.min(prev.failures + 1, 10);
                const nextDelay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
                failureState.set(entry.name, {
                    failures,
                    nextEligibleAt: Date.now() + nextDelay,
                });
                console.error(`[scheduler] ${entry.name} crashed (failure #${failures}, ` +
                    `backoff ${Math.round(nextDelay / 1000)}s):`, err);
            }
            finally {
                inFlight.delete(entry.name);
            }
        }
        // R56 audit fix: re-check `shuttingDown` after the
        // `await entry.fn(ctx)` above. The previous code
        // unconditionally called `scheduleNext(ctx, entry)` in
        // both the success and error paths (and the in-flight
        // skip branch), re-registering a fresh timer on a
        // process that has already begun shutdown. The new
        // tick would re-enter `entry.fn`, which would call
        // into closed SQLite handles and the closed gRPC
        // client, log "database is closed" errors, and
        // extend shutdown past the Railway healthcheck
        // timeout.
        if (shuttingDown)
            return;
        scheduleNext(ctx, entry);
    }, delay);
    activeTimers.set(entry.name, timer);
    console.log(`[scheduler] ${entry.name} next in ${Math.round(delay / 1000)}s (${entry.cron})`);
}
/** Compute ms from now until the next fire time for the given cron expr. */
export function msUntilNext(expr, now = new Date()) {
    const parts = expr.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`bad cron: ${expr}`);
    }
    const [minute, hour, , , dow] = parts;
    if (!minute || !hour || !dow) {
        throw new Error(`bad cron: ${expr}`);
    }
    // R57 agents audit fix: step the search by the largest
    // granularity that can't be a wildcard, instead of walking
    // every minute. The previous loop iterated 8 * 24 * 60 = 11520
    // minutes per call. The scheduler calls this on every
    // `scheduleNext` re-arm, so a 1-minute cron that takes 5
    // seconds to finish its tick would re-arm with a 5-second
    // search budget. Pick a step size based on the wildcards:
    //   - `hour` is "*" → step by 60 minutes
    //   - `dow` is "*" → step by 60 minutes (no day constraint)
    //   - otherwise step by 1 minute
    const stepMinutes = hour === "*" || dow === "*" ? 60 : 1;
    const maxIter = 8 * 24 * 60;
    for (let i = 0; i < maxIter; i += stepMinutes) {
        const candidate = new Date(now.getTime() + i * 60_000);
        if (!matchesPart(minute, candidate.getUTCMinutes()))
            continue;
        if (!matchesPart(hour, candidate.getUTCHours()))
            continue;
        if (dow !== "*" && !matchesPart(dow, candidate.getUTCDay()))
            continue;
        if (candidate.getUTCSeconds() !== 0)
            continue;
        if (candidate.getTime() <= now.getTime())
            continue;
        return candidate.getTime() - now.getTime();
    }
    // Shouldn't happen for valid input, but never starve the loop.
    // Warn on excessive iteration so a future cron-format
    // regression is visible in operator logs.
    console.warn(`[scheduler] msUntilNext(${expr}) exhausted ${maxIter} candidates; ` +
        "falling back to readPollMs().");
    return readPollMs();
}
function matchesPart(part, value) {
    if (part === "*")
        return true;
    if (part.startsWith("*/")) {
        const n = Number(part.slice(2));
        return n > 0 && value % n === 0;
    }
    const num = Number(part);
    return Number.isFinite(num) && num === value;
}
//# sourceMappingURL=scheduler.js.map