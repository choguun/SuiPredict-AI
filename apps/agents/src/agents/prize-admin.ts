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

const PRIZE_POOL_ID = process.env.PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.PRIZE_ADMIN_ID ?? "";
const PRIZE_FUND_AMOUNT = BigInt(
  process.env.PRIZE_FUND_AMOUNT ?? process.env.PRIZE_WEEKLY_AMOUNT ?? "0",
);
const PRIZE_POOL_MIN_BALANCE = BigInt(
  process.env.PRIZE_POOL_MIN_BALANCE ?? "0",
);
const SUI_NETWORK = (process.env.SUI_NETWORK ?? "testnet") as
  | "testnet"
  | "mainnet"
  | "devnet"
  | "localnet";

export async function runPrizeAdmin(ctx: AgentContext): Promise<AgentResult> {
  if (!PRIZE_POOL_ID) {
    return recordResult("PrizeAdmin", {
      action: "skip",
      reasoning: "PRIZE_POOL_ID not configured.",
    });
  }
  if (PRIZE_FUND_AMOUNT === 0n) {
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
    if (totalDusdc < PRIZE_POOL_MIN_BALANCE) {
      const eligible = dusdcCoins
        .filter((c) => BigInt(c.balance) >= PRIZE_FUND_AMOUNT)
        .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
      if (eligible) {
        // R38 audit fix: pass PRIZE_FUND_AMOUNT explicitly so the
        // builder splits exactly that many atoms off the source
        // coin in-PTB. The previous call would have drained the
        // entire eligible coin (the R36 parlay::create_parlay fix
        // applied here for the prize pool).
        const fundTx = buildFundPoolTx(
          PRIZE_POOL_ID,
          eligible.objectId,
          PRIZE_FUND_AMOUNT,
        );
        const r = await executeTransaction(client, fundTx, ctx.signer);
        fundedAmount = PRIZE_FUND_AMOUNT;
        notes.push(
          `funded ${PRIZE_FUND_AMOUNT} DUSDC: ${r.digest.slice(0, 12)}…`,
        );
      } else {
        notes.push(
          `no DUSDC coin >= ${PRIZE_FUND_AMOUNT} — agent balance ${totalDusdc}`,
        );
      }
    } else {
      notes.push(`pool balance ${totalDusdc} >= min ${PRIZE_POOL_MIN_BALANCE}`);
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
