/**
 * Prize distributor — 00:15 UTC Monday cron.
 *
 * Sanity-checks the on-chain `PrizePool` balance and the prior week's
 * archived leaderboard. The actual signature is issued on demand by
 * `GET /prize/signature?week=N&rank=R` (served by the web client) when
 * the user claims from their own wallet. This keeps the agent key off
 * the user's hot path and avoids burning CPU to sign payloads the
 * user may never request.
 *
 * Why the distributor does not pre-sign: a prior version iterated the
 * top-N and called `signClaimPayload` for each row, but the returned
 * `SignedClaim` was discarded immediately. The `signed++` counter
 * reported success for an action that produced no observable effect —
 * a lie the boot health endpoint happily surfaced as a green tick.
 * The on-chain `claim_prize` also enforces
 *   `assert!(ctx.sender() == streak_system::owner_of(user_streak))`,
 * which always aborts with `ENotStreakOwner` if the agent submits on
 * the user's behalf (`UserStreak.owner` is the user, not the agent).
 * A fully-custodial auto-claim is therefore not just unnecessary but
 * impossible; for a sponsored demo, the user must sign their own PTB
 * (out of scope for this file).
 */
import { readPrizePoolBalance } from "@suipredict/sdk";
import { getSharedClient, recordResult, safeBigInt } from "../lib.js";
import { isPoolWeekSettled, listWeeklyLeaderboard, weekIndexFor } from "../gamification/store.js";
// Env reads live inside `runPrizeDistributor` so a late write by
// `bootstrapEnv` (apps/agents/src/index.ts) takes effect on the next
// cron tick. Module-level reads snapshot the values at import time
// and miss the bootstrap — same class of bug r11 fixed for the
// package-id constants, missed for these three.
export async function runPrizeDistributor(_ctx) {
    const PRIZE_POOL_ID = process.env.PRIZE_POOL_ID ?? "";
    const PRIZE_ADMIN_ID = process.env.PRIZE_ADMIN_ID ?? "";
    // R55 audit fix: route through `safeBigInt` so a
    // non-integer env value (e.g. `PRIZE_WEEKLY_AMOUNT=10_USDC`
    // or `100.5`) doesn't throw `SyntaxError` synchronously
    // — the surrounding try/catch in the worker tick loop
    // would swallow it, the operator would see no prize
    // distribution, and the only signal would be a missing
    // `prize_claims` log. Now we get a `[lib.safeBigInt]`
    // warning + a 0n fallback that the existing
    // `PRIZE_WEEKLY_AMOUNT === 0n` check converts into a
    // clean `skip` action.
    const PRIZE_WEEKLY_AMOUNT = safeBigInt(process.env.PRIZE_WEEKLY_AMOUNT, 0n);
    if (!PRIZE_POOL_ID || !PRIZE_ADMIN_ID) {
        return recordResult("PrizeDistributor", {
            action: "skip",
            reasoning: "PRIZE_POOL_ID / PRIZE_ADMIN_ID not configured — distributor inert.",
        });
    }
    if (PRIZE_WEEKLY_AMOUNT === 0n) {
        return recordResult("PrizeDistributor", {
            action: "skip",
            reasoning: "PRIZE_WEEKLY_AMOUNT is 0; no prize pot to distribute.",
        });
    }
    // Sanity-check that the on-chain PrizePool actually holds funds
    // before we sign any claim payloads. If `fund_pool` silently failed
    // during bootstrap (e.g. no DBUSDC coin >= PRIZE_WEEKLY_AMOUNT),
    // every signature we issue would land as `EInsufficientPoolBalance`
    // on the user's claim tx. Reading the balance first lets us skip
    // the whole week with a clear message instead of paying gas for N
    // doomed PTBs.
    // R51 audit fix: shared gRPC client (see lib.ts).
    // The previous per-tick `createClient()` opened a
    // fresh HTTP/2 connection on every call; the SDK
    // never closed the prior ones, so the gRPC client
    // pool grew to ~60 idle connections after a few
    // minutes of polling. Use the singleton.
    const client = getSharedClient();
    let poolBalance = 0n;
    try {
        // R39 audit fix: replaced the inline shape detection with
        // the SDK's `readPrizePoolBalance` helper. The inline copy
        // accepted `{"value": "..."}` or `string|number` but
        // silently fell through to `poolBalance = 0n` if the Sui
        // gRPC view ever adds a new wrapper (e.g. `{"fields": ...}`
        // for a future `Balance<T>` representation). The SDK
        // helper uses the same `asBalance` codepath as every
        // other protocol read, so future shape changes are picked
        // up in one place.
        poolBalance = await readPrizePoolBalance(client, PRIZE_POOL_ID);
    }
    catch (e) {
        return recordResult("PrizeDistributor", {
            action: "skip",
            reasoning: `Could not read PrizePool ${PRIZE_POOL_ID}: ${e instanceof Error ? e.message : String(e)}`,
        });
    }
    if (poolBalance === 0n) {
        return recordResult("PrizeDistributor", {
            action: "skip",
            reasoning: `PrizePool ${PRIZE_POOL_ID} has 0 balance; bootstrap fund_pool likely failed. Refusing to sign claims that would abort on-chain.`,
        });
    }
    const priorWeek = weekIndexFor(Date.now()) - 1;
    // R58.M6 audit fix: short-circuit if the (pool, priorWeek)
    // pair has already been marked settled. The distributor
    // is invoked on a 24h cron, but Railway deploys can re-run
    // the same tick within minutes (e.g. a healthcheck-induced
    // restart). Without the guard, every restart would log a
    // fresh "ready" record for the same week, and any future
    // signature-issuing path that keys off this distributor
    // (e.g. an automated claim sponsor) would replay claims
    // for the same week. The guard is cheap (a single indexed
    // SELECT against `pool_weeks`).
    if (isPoolWeekSettled(PRIZE_POOL_ID, priorWeek)) {
        return recordResult("PrizeDistributor", {
            action: "noop",
            reasoning: `Week ${priorWeek} already marked settled; skipping.`,
        });
    }
    const top = listWeeklyLeaderboard(priorWeek, 10);
    if (top.length === 0) {
        return recordResult("PrizeDistributor", {
            action: "noop",
            reasoning: `No archived rows for week ${priorWeek}.`,
        });
    }
    return recordResult("PrizeDistributor", {
        action: "ready",
        reasoning: `Week ${priorWeek}: ${top.length} top-10 rows archived and PrizePool is funded. Signatures are issued on demand by GET /prize/signature when the user claims — distributor does not pre-sign.`,
        confidence: 100,
    });
}
//# sourceMappingURL=prize-distributor.js.map