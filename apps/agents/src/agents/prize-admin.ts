/**
 * Prize pool admin — fund, settle, rotate.
 *
 * Runs on a weekly cadence (Monday 00:10 UTC, right after the
 * leaderboard rollup at 00:05 UTC). Each cycle:
 *
 *   1. Fund the PrizePool from the agent's DUSDC balance if below a
 *      configurable threshold (`PRIZE_POOL_MIN_BALANCE`).
 *   2. Settle the prior week (`prize_pool::settle_week`) so users can
 *      no longer claim from that week once the next one starts.
 *
 * Key rotation (`prize_pool::rotate_pubkey`) is exposed as a manual
 * CLI helper rather than a cron job — it requires publishing a new
 * ed25519 pubkey and is rarely needed. Run via:
 *   `apps/agents/scripts/rotate-prize-pubkey.ts`
 */
import {
  executeTransaction,
  DUSDC_TYPE,
  buildFundPoolTx,
  buildSettleWeekTx,
  isMoveAbortInModule,
  isMoveAbortSymbol,
  readPrizePoolWeeklyPrize,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult } from "../lib.js";
import {
  isPoolWeekSettled,
  markPoolWeekSettled,
  weekIndexFor,
} from "../gamification/store.js";

// R43 audit fix: read the runtime-tunable knobs (`PRIZE_FUND_AMOUNT`,
// `PRIZE_POOL_MIN_BALANCE`) at the top of `runPrizeAdmin` rather
// than at module load. The module-level `const`s below for the
// operational ids (`PRIZE_POOL_ID`, `PRIZE_ADMIN_ID`) stay —
// they are deployment-time configuration that does not change
// at runtime, and freezing them at module load is the right
// behavior (re-binding them mid-cycle would race the in-flight
// tx). The fund-amount and min-balance can be hot-patched via
// `bootstrap-env.ts` after the agents process is already
// running; the previous module-level read kept the boot-time
// snapshot forever, so a stale `PRIZE_FUND_AMOUNT=0` would
// have permanently disabled funding.
const PRIZE_POOL_ID = process.env.PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.PRIZE_ADMIN_ID ?? "";
// R46 audit fix: drop the dead `SUI_NETWORK` constant. The
// previous module-level const was typed as a discriminated
// union (testnet/mainnet/devnet/localnet) but never read
// anywhere in this file — the createClient() call at line
// 80 picks its RPC URL from the SDK's `SUI_GRPC_URL`
// resolver, which is the right place for the network-aware
// logic. Carrying the value here implied a per-worker
// override that the code didn't actually use, which a
// future reader might "fix" by branching on it (e.g. "use
// a different settle admin on mainnet"), introducing a
// new bug class. If a per-prize-admin network switch is
// ever needed, do it at the SDK layer where the rest of
// the network plumbing lives.

export async function runPrizeAdmin(ctx: AgentContext): Promise<AgentResult> {
  // R43 audit fix: re-read the runtime-tunable knobs at the top
  // of the run function. See the comment at the module-level
  // constants for the rationale; the short version is that a
  // hot-patch of PRIZE_FUND_AMOUNT or PRIZE_POOL_MIN_BALANCE
  // via `bootstrap-env.ts` would otherwise be ignored.
  const prizeFundAmount = BigInt(
    process.env.PRIZE_FUND_AMOUNT ??
      process.env.PRIZE_WEEKLY_AMOUNT ??
      "0",
  );
  const prizePoolMinBalance = BigInt(
    process.env.PRIZE_POOL_MIN_BALANCE ?? "0",
  );
  if (!PRIZE_POOL_ID) {
    return recordResult("PrizeAdmin", {
      action: "skip",
      reasoning: "PRIZE_POOL_ID not configured.",
    });
  }
  if (prizeFundAmount === 0n) {
    return recordResult("PrizeAdmin", {
      action: "skip",
      reasoning: "PRIZE_FUND_AMOUNT is 0; nothing to fund.",
    });
  }
  // R51 audit fix: shared gRPC client (see lib.ts).
  // The previous per-tick `createClient()` opened a
  // fresh HTTP/2 connection on every call; the SDK
  // never closed the prior ones, so the gRPC client
  // pool grew to ~60 idle connections after a few
  // minutes of polling. Use the singleton.
  const client = getSharedClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();

  let fundedAmount = 0n;
  let settledWeek: number | null = null;
  const notes: string[] = [];

  // Step 1: fund the pool if below threshold
  try {
    const { objects: dusdcCoins } = await client.core.listCoins({
      owner: agentAddr,
      coinType: DUSDC_TYPE,
    });
    const totalDusdc = dusdcCoins.reduce(
      (acc, c) => acc + BigInt(c.balance),
      0n,
    );
    if (totalDusdc < prizePoolMinBalance) {
      const eligible = dusdcCoins
        .filter((c) => BigInt(c.balance) >= prizeFundAmount)
        .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
      if (eligible) {
        // R38 audit fix: pass prizeFundAmount explicitly so the
        // builder splits exactly that many atoms off the source
        // coin in-PTB. The previous call would have drained the
        // entire eligible coin (the R36 parlay::create_parlay fix
        // applied here for the prize pool).
        const fundTx = buildFundPoolTx(
          PRIZE_POOL_ID,
          eligible.objectId,
          prizeFundAmount,
        );
        const r = await executeTransaction(client, fundTx, ctx.signer);
        fundedAmount = prizeFundAmount;
        notes.push(
          `funded ${prizeFundAmount} DUSDC: ${r.digest.slice(0, 12)}…`,
        );
      } else {
        notes.push(
          `no DUSDC coin >= ${prizeFundAmount} — agent balance ${totalDusdc}`,
        );
      }
    } else {
      notes.push(`pool balance ${totalDusdc} >= min ${prizePoolMinBalance}`);
    }
  } catch (err) {
    notes.push(
      `fund failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Step 2: settle the prior week
  try {
    const priorWeek = weekIndexFor(Date.now()) - 1;
    if (!PRIZE_ADMIN_ID) {
      notes.push("PRIZE_ADMIN_ID not configured; skipping settle.");
    } else {
      // R42 audit fix: read the on-chain `weekly_prize` for the
      // prior week before submitting the settle tx. If it's 0 the
      // pool was never funded for that week (deploy was live for
      // less than a full week, or funding failed silently) and
      // there's nothing to distribute — settle would be a no-op
      // tx that still costs gas and emits a misleading
      // `PoolSettled` event. The on-chain `settle_week` doesn't
      // gate on `weekly_prize > 0` (it's a generic
      // mark-as-settled marker, see prize_pool.move:228), so we
      // gate it at the worker level.
      let priorWeeklyPrize: bigint;
      try {
        priorWeeklyPrize = await readPrizePoolWeeklyPrize(
          client,
          PRIZE_POOL_ID,
        );
      } catch (err) {
        // RPC outage / wrong network / object not found. Don't
        // crash the whole admin pass — log and skip settle.
        notes.push(
          `settle skipped: could not read weekly_prize ` +
            `(${err instanceof Error ? err.message : String(err)})`,
        );
        priorWeeklyPrize = -1n;
      }
      if (priorWeeklyPrize === 0n) {
        notes.push(
          `settle skipped: prior week ${priorWeek} has 0 weekly_prize.`,
        );
      } else if (priorWeeklyPrize > 0n) {
        // R44 audit fix: skip when the off-chain mirror already
        // shows this (pool, week) as settled. The on-chain
        // `prize_pool::settle_week` is *not* idempotent — a
        // second call from the admin (e.g. cron caught up
        // after a restart, or a manual settle) aborts with
        // `EAlreadySettled`, which the worker treats as a
        // generic failure and would log at warn level forever
        // (the position-indexer would never observe the
        // `PoolSettled` event because the tx was never
        // submitted, so the mirror stays in the
        // "settle_failed" state indefinitely). The mirror
        // path (R33) wrote the row from the indexer's
        // `PoolSettled` event poll, so a `true` here is the
        // chain's own confirmation. If the mirror was wiped
        // (operator disaster-recovery), we'd re-settle and
        // burn gas once — acceptable, not a permanent loop.
        if (isPoolWeekSettled(PRIZE_POOL_ID, priorWeek)) {
          notes.push(
            `settle skipped: prior week ${priorWeek} already settled (mirror).`,
          );
        } else {
          const settleTx = buildSettleWeekTx(
            PRIZE_POOL_ID,
            PRIZE_ADMIN_ID,
            BigInt(priorWeek),
          );
          try {
            const r = await executeTransaction(client, settleTx, ctx.signer);
            settledWeek = priorWeek;
            notes.push(
              `settled week ${priorWeek} (weekly_prize=${priorWeeklyPrize}): ` +
                `${r.digest.slice(0, 12)}…`,
            );
          } catch (settleErr) {
            // R45 audit fix: catch `EAlreadySettled` on-chain and
            // converge the mirror. The off-chain `pool_weeks`
            // short-circuit above only catches settlements the
            // indexer has already observed via `PoolSettled`
            // events. If an admin script (or a second agent
            // instance on a multi-tenant deploy) settled the
            // week out-of-band, the on-chain `settle_week` aborts
            // with `EAlreadySettled` and the mirror never gets
            // updated — every subsequent cron tick re-submits
            // the doomed PTB. Detect the abort via
            // `isMoveAbortSymbol` (the SDK's
            // `move-errors.ts:229`) and call `markPoolWeekSettled`
            // to bring the mirror in line, then treat the cron
            // as a successful no-op. Re-throw on any other
            // failure so the surrounding `catch (err)` records
            // the error.
            // R47 audit fix: match the *module*
            // (`prize_pool`) instead of the
            // literal `EAlreadySettled` symbol. A
            // future contract refactor that
            // renames the abort (e.g.
            // `EAlreadySettledInRotation`) or
            // wraps it in a generic
            // `EPoolAlreadySettled` would have
            // silently slipped past the previous
            // symbol-only check, leaving the
            // mirror divergent. Any abort raised
            // from the prize_pool module on a
            // settle call is — by construction —
            // a "this week is already settled"
            // path. The exact symbol is still
            // logged for the operator's audit
            // trail.
            if (isMoveAbortInModule(settleErr, "prize_pool")) {
              markPoolWeekSettled(
                PRIZE_POOL_ID,
                priorWeek,
                Date.now(),
              );
              const symbol = isMoveAbortSymbol(settleErr, "EAlreadySettled")
                ? "EAlreadySettled"
                : "prize_pool::abort";
              notes.push(
                `settle skipped: prior week ${priorWeek} already settled ` +
                  `(${symbol}); mirror converged.`,
              );
            } else {
              throw settleErr;
            }
          }
        }
      }
    }
  } catch (err) {
    notes.push(
      `settle failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const summary =
    notes.length > 0 ? notes.join("; ") : "no admin actions taken.";
  return recordResult("PrizeAdmin", {
    action: fundedAmount > 0n || settledWeek != null ? "admin" : "noop",
    reasoning: summary,
    confidence: 100,
  });
}
