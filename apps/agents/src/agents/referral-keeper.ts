/**
 * Referral Keeper — claims accumulated DeepBook trading fee rebates
 * for all markets that have a referral_id set.
 *
 * Run on a schedule (e.g. every 15 min). Rewards accumulate in the
 * DeepBook pool's referral ledger and are paid to the agent's
 * signer; the agent then forwards them to the treasury.
 *
 * Setup path (post round-4): the `MarketCreator` agent now calls
 * `buildSetupReferralTx` for every market it creates (see
 * market-creator.ts:178), so each market's row in the local store
 * carries a populated `referral_id`. This agent still no-ops if no
 * markets match the filter, which is the expected steady state on
 * a fresh deploy before the first market has accrued any trading
 * fees.
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
  const claimed: string[] = [];
  const noRewards: string[] = [];
  const errors: string[] = [];

  for (const market of markets) {
    if (!market.deepbook_pool_id || !market.referral_id) continue;

    try {
      const tx = buildClaimReferralRewardsTx(
        market.deepbook_pool_id,
        market.referral_id,
      );
      const result = await executeTransaction(client, tx, ctx.signer);
      claimed.push(
        `${market.id.slice(0, 12)}... → ${result.digest.slice(0, 8)}`,
      );
    } catch (err) {
      // Referral rewards may be zero — don't treat as failure
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("zero") || msg.includes("amount") || msg.includes("InsufficientBalance")) {
        noRewards.push(`${market.id.slice(0, 12)}...`);
      } else {
        errors.push(`${market.id.slice(0, 12)}: ${msg}`);
      }
    }
  }

  // Surface action / confidence that reflects what actually happened.
  // The previous version lumped "claimed" and "no rewards" into the
  // same counter, so the boot health endpoint showed a green tick
  // even when every market in the loop returned 0 — the same lying
  // pattern r11 fixed for `PrizeDistributor`. If we ran the loop
  // and didn't claim anything, the action is `skip`, not `sweep`.
  if (errors.length > 0) {
    return recordResult("ReferralKeeper", {
      action: "partial",
      reasoning: `Claimed ${claimed.length} of ${markets.length}; ${noRewards.length} no-op; ${errors.length} errors. ${errors.join("; ")}`,
      confidence: 70,
    });
  }
  if (claimed.length === 0) {
    return recordResult("ReferralKeeper", {
      action: "skip",
      reasoning: `No referral rewards accrued across ${noRewards.length} market(s).`,
      confidence: 60,
    });
  }
  return recordResult("ReferralKeeper", {
    action: "sweep",
    reasoning: `Claimed ${claimed.length} of ${markets.length} markets${noRewards.length ? ` (${noRewards.length} no-op)` : ""}. ${claimed.join(" | ")}`,
    confidence: 88,
  });
}
