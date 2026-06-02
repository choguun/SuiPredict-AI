/**
 * Referral Keeper — claims accumulated DeepBook trading fee rebates
 * for all markets that have a referral_id set, and forwards the
 * proceeds to the protocol treasury.
 *
 * Run on a schedule (e.g. every 15 min). Rewards accumulate in the
 * DeepBook pool's referral ledger and are paid to the agent's
 * signer (the on-chain `claim_referral_rewards` does
 * `transfer::public_transfer(quote_coins, ctx.sender())`); this
 * agent snapshots the agent's DUSDC coin set BEFORE the loop and
 * transfers the NEW coins (i.e. the ones the claims just deposited)
 * to `REFERRAL_TREASURY_ADDRESS` in a single batched PTB.
 *
 * Why forward only the delta: the agent's hot wallet also holds the
 * DUSDC it uses to seed new markets (see `market-creator.ts`), so
 * transferring the entire balance would steal the seed pool. A
 * pre/post snapshot is exact and survives concurrent claims.
 *
 * Setup path (post round-4): the `MarketCreator` agent now calls
 * `buildSetupReferralTx` for every market it creates (see
 * market-creator.ts:178), so each market's row in the local store
 * carries a populated `referral_id`. This agent still no-ops if no
 * markets match the filter, which is the expected steady state on
 * a fresh deploy before the first market has accrued any trading
 * fees.
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  buildClaimReferralRewardsTx,
  createClient,
  DUSDC_TYPE,
  executeTransaction,
  REFERRAL_TREASURY_ADDRESS,
} from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import { listMarkets } from "../markets/store.js";

/** List the agent's DUSDC coin object ids at this moment. Used to
 *  compute the pre/post delta when forwarding claimed rewards. */
async function listDusdcCoinIds(
  client: ReturnType<typeof createClient>,
  owner: string,
): Promise<Set<string>> {
  try {
    const { objects } = await client.core.listCoins({
      owner,
      coinType: DUSDC_TYPE,
    });
    return new Set(objects.map((c) => c.objectId));
  } catch (err) {
    console.warn(
      "[referral-keeper] listCoins failed; will skip the forward step:",
      err instanceof Error ? err.message : err,
    );
    return new Set();
  }
}

/** Build a PTB that transfers the given coin ids to the treasury.
 *  Batched in a single tx so the forward is atomic. */
function buildForwardTx(coinIds: string[], treasury: string): Transaction {
  const tx = new Transaction();
  for (const id of coinIds) {
    tx.transferObjects([tx.object(id)], tx.pure.address(treasury));
  }
  return tx;
}

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
  // Snapshot the agent's DUSDC coin set BEFORE the claims. Any coin
  // that appears in the post-snapshot but not the pre-snapshot is a
  // claim deposit. The pre-snapshot may fail (RPC outage); in that
  // case the forward is skipped, the rewards stay in the agent
  // wallet, and a loud `console.warn` surfaces it.
  const preCoins = await listDusdcCoinIds(client, agentAddr);

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

  // Forward the delta of DUSDC coins to the treasury. The pre-snapshot
  // is a `Set` of coin object ids; anything new since then is a claim
  // deposit. `transferObjects` accepts multiple inputs in a single
  // PTB, so a sweep that produced N coins is one tx, not N.
  let forwardedDigest: string | null = null;
  if (REFERRAL_TREASURY_ADDRESS) {
    const postCoins = await listDusdcCoinIds(client, agentAddr);
    const newCoinIds: string[] = [];
    for (const id of postCoins) {
      if (!preCoins.has(id)) newCoinIds.push(id);
    }
    if (newCoinIds.length > 0) {
      try {
        const fwdTx = buildForwardTx(newCoinIds, REFERRAL_TREASURY_ADDRESS);
        const r = await executeTransaction(client, fwdTx, ctx.signer);
        forwardedDigest = r.digest;
      } catch (err) {
        // Don't fail the whole sweep if the forward fails — the
        // on-chain claims already succeeded and the rewards are
        // safe in the agent wallet. A future tick will re-claim
        // (idempotently — zero-balance claim is a no-op Move abort
        // that's already caught above) and the forward will retry.
        console.warn(
          `[referral-keeper] forward to treasury ${REFERRAL_TREASURY_ADDRESS} failed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } else {
    console.warn(
      "[referral-keeper] REFERRAL_TREASURY_ADDRESS not set — claimed rewards will accumulate in the agent's hot wallet until the env is configured.",
    );
  }

  return recordResult("ReferralKeeper", {
    action: "sweep",
    reasoning:
      `Claimed ${claimed.length} of ${markets.length} markets${noRewards.length ? ` (${noRewards.length} no-op)` : ""}. ` +
      (forwardedDigest
        ? `Forwarded rewards to treasury ${REFERRAL_TREASURY_ADDRESS}: ${forwardedDigest.slice(0, 8)}. `
        : REFERRAL_TREASURY_ADDRESS
          ? "No new DUSDC coins detected for forward. "
          : "Treasury not configured — rewards left in agent wallet. ") +
      claimed.join(" | "),
    confidence: 88,
  });
}
