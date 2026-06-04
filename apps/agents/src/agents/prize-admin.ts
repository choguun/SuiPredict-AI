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
  createClient,
  executeTransaction,
  DUSDC_TYPE,
  buildFundPoolTx,
  buildSettleWeekTx,
  readPrizePoolWeeklyPrize,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { weekIndexFor } from "../gamification/store.js";

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
const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

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
  const client = createClient();
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
        const settleTx = buildSettleWeekTx(
          PRIZE_POOL_ID,
          PRIZE_ADMIN_ID,
          BigInt(priorWeek),
        );
        const r = await executeTransaction(client, settleTx, ctx.signer);
        settledWeek = priorWeek;
        notes.push(
          `settled week ${priorWeek} (weekly_prize=${priorWeeklyPrize}): ` +
            `${r.digest.slice(0, 12)}…`,
        );
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
