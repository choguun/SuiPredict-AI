/**
 * Referral Keeper — claims accumulated DeepBook trading fee rebates
 * for all markets that have a referral_id set.
 *
 * Run on a schedule (e.g. every 15 min). Rewards accumulate in the
 * DeepBook pool's referral ledger and are paid to the agent's
 * signer; the agent then forwards them to the treasury.
 *
 * KNOWN GAP: the on-chain `setup_referral` (prediction_market.move)
 * is never invoked anywhere in the repo — not by the MarketCreator
 * agent, not by the bootstrap script, not by the web app. As a
 * result, every market has `referral_id = None` at creation time,
 * and this agent is always a no-op. The fix requires:
 *   1. A "Setup DeepBook referral" button in the market-creation
 *      form (apps/web) that calls `setup_referral` after the
 *      market is created.
 *   2. A read-only view of accumulated referral rewards per
 *      market so operators can see what's accruing.
 * Filed for plan-5; this agent's "no referrals configured" message
 * is the current observable symptom.
 */
import { buildClaimReferralRewardsTx, createClient, executeTransaction, REFERRAL_TREASURY_ADDRESS } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

export async function runReferralKeeper(ctx: AgentContext): Promise<AgentResult> {
  const markets = listMarkets().filter(
    (m) => m.status === "active" && m.deepbook_pool_id && m.referral_id,
  );

  if (markets.length === 0) {
    return recordResult("ReferralKeeper", {
      action: "skip",
      reasoning: "No active markets with referrals configured.",
      confidence: 95,
    });
  }

  const client = createClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
  const results: string[] = [];
  const errors: string[] = [];

  for (const market of markets) {
    if (!market.deepbook_pool_id || !market.referral_id) continue;

    try {
      const tx = buildClaimReferralRewardsTx(
        market.deepbook_pool_id,
        market.referral_id,
      );
      const result = await executeTransaction(client, tx, ctx.signer);
      results.push(
        `${market.id.slice(0, 12)}... referral sweep → ${result.digest.slice(0, 8)}`,
      );
    } catch (err) {
      // Referral rewards may be zero — don't treat as failure
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("zero") || msg.includes("amount") || msg.includes("InsufficientBalance")) {
        results.push(`${market.id.slice(0, 12)}... no rewards yet`);
      } else {
        errors.push(`${market.id.slice(0, 12)}: ${msg}`);
      }
    }
  }

  if (errors.length > 0) {
    return recordResult("ReferralKeeper", {
      action: "partial",
      reasoning: `Sweep done. Errors: ${errors.join("; ")}`,
      confidence: 70,
    });
  }

  return recordResult("ReferralKeeper", {
    action: "sweep",
    reasoning: `Swept ${results.length} markets. ${results.join(" | ")}`,
    confidence: 88,
  });
}
