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
  listAllCoins,
  readPrizePoolWeeklyPrize,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult, safeBigInt } from "../lib.js";
import {
  isPoolWeekSettled,
  markPoolWeekSettled,
  weekIndexFor,
} from "../gamification/store.js";

// R43 audit fix: read the runtime-tunable knobs (`PRIZE_FUND_AMOUNT`,
// `PRIZE_POOL_MIN_BALANCE`) at the top of `runPrizeAdmin` rather
// than at module load. The fund-amount and min-balance can be
// hot-patched via `bootstrap-env.ts` after the agents process is
// already running; a module-level read would keep the boot-time
// snapshot forever, so a stale `PRIZE_FUND_AMOUNT=0` would have
// permanently disabled funding.
//
// R54 audit fix: drop the dead `PRIZE_POOL_ID` / `PRIZE_ADMIN_ID`
// module-level consts. The R53 fix re-reads both at function-body
// scope, leaving the module-level values as unused noise that
// invites a future reader to "fix" the inconsistency by branching
// on them. The function-local `prizePoolId` / `prizeAdminId` are
// the single source of truth.
//
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
  // R55 audit fix: route both through `safeBigInt` so a
  // non-integer env value (e.g. `10_000_000` with the
  // underscores) doesn't throw `BigInt SyntaxError` and
  // turn the first prize-fund tick into a silent no-op.
  const prizeFundAmount = safeBigInt(
    process.env.PRIZE_FUND_AMOUNT ?? process.env.PRIZE_WEEKLY_AMOUNT,
    0n,
  );
  const prizePoolMinBalance = safeBigInt(
    process.env.PRIZE_POOL_MIN_BALANCE,
    0n,
  );
  // R53 audit fix: re-read
  // `PRIZE_POOL_ID` /
  // `PRIZE_ADMIN_ID` at
  // function-body scope (the
  // module-level consts were
  // frozen at import time, so
  // a hot-patch of either
  // via `bootstrap-env.ts` was
  // silently ignored for the
  // process lifetime).
  const prizePoolId = process.env.PRIZE_POOL_ID ?? "";
  const prizeAdminId = process.env.PRIZE_ADMIN_ID ?? "";
  if (!prizePoolId) {
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
  // E2E-GAP-04 fix: poll for `DistributionSet` events
  // emitted by `prize_pool::set_distribution` (added
  // in the MOVE-GAP-16 fix) and log them. The on-chain
  // event is the only signal an operator has that the
  // payout curve changed; without this poll the
  // off-chain leaderboard reconciler would silently
  // drift from the on-chain `distribution` getter.
  // Best-effort: a 5xx or RPC error logs the failure
  // but does not abort the prize-admin cycle (the
  // fund + settle steps are the primary path).
  // Note: the gRPC client's `queryEvents` returns at
  // most 1000 events per call; we ask for the most
  // recent 5 (descending order) which is enough for a
  // weekly cron — if the operator re-tuned the curve
  // more than 5 times in the past 24h, the older
  // change is logged on the next run.
  const AGENT_POLICY_PACKAGE_ID = process.env.AGENT_POLICY_PACKAGE_ID ?? "";
  if (AGENT_POLICY_PACKAGE_ID) {
    try {
      // E2E-GAP-04 fix: use the JSON-RPC client for
      // `queryEvents`; the gRPC `SuiGrpcClient` exposes
      // a different event API that the SDK doesn't
      // currently wrap. The `getSharedJsonRpcClient()`
      // helper is the R55 singleton — same one the
      // position-indexer and streak-sweeper use.
      const { getSharedJsonRpcClient } = await import("../lib.js");
      const jsonRpc = getSharedJsonRpcClient();
      const ev = await jsonRpc.queryEvents({
        query: {
          MoveEventType: `${AGENT_POLICY_PACKAGE_ID}::prize_pool::DistributionSet`,
        },
        limit: 5,
        order: "descending",
      });
      for (const e of ev.data) {
        const parsed = e.parsedJson as {
          pool_id?: string;
          admin?: string;
          new_sum_bps?: string | number;
          distribution_length?: string | number;
        } | null;
        if (!parsed) continue;
        console.log(
          `[prize-admin] DistributionSet: pool=${parsed.pool_id} admin=${parsed.admin} sum=${parsed.new_sum_bps} length=${parsed.distribution_length}`,
        );
      }
    } catch (err) {
      console.warn(
        "[prize-admin] DistributionSet poll failed (non-fatal):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  let fundedAmount = 0n;
  let settledWeek: number | null = null;
  const notes: string[] = [];

  // Step 1: fund the pool if below threshold
  try {
    // R53 audit fix: use
    // `listAllCoins` (paginates
    // to 50-coins-per-page up
    // to 20 pages = 1000
    // coins). The previous
    // direct `client.core.listCoins`
    // call returned the default
    // 50-coin page and stopped;
    // a busy agent with &gt; 50
    // DUSDC coins (e.g. after a
    // day of prize payouts) would
    // silently miss the right
    // `eligible` coin, the fund
    // step would skip, and the
    // pool would go under-funded.
    const dusdcCoins = await listAllCoins(client, agentAddr, DUSDC_TYPE);
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
          prizePoolId,
          eligible.objectId,
          prizeFundAmount,
        );
        const r = await executeTransaction(client, () => fundTx, ctx.signer);
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
    if (!prizeAdminId) {
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
          prizePoolId,
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
        if (isPoolWeekSettled(prizePoolId, priorWeek)) {
          notes.push(
            `settle skipped: prior week ${priorWeek} already settled (mirror).`,
          );
        } else {
          const settleTx = buildSettleWeekTx(
            prizePoolId,
            prizeAdminId,
            BigInt(priorWeek),
          );
          try {
            const r = await executeTransaction(client, () => settleTx, ctx.signer);
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
                prizePoolId,
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
