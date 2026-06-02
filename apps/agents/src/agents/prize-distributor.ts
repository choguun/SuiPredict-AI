/**
 * Prize distributor — 00:15 UTC Monday cron.
 *
 * For the top-N of the prior week's leaderboard, signs a claim payload
 * with the prize admin ed25519 key. The on-chain `claim_prize` verifies
 * the signature against the `PrizeAdmin` capability's stored `pubkey`
 * and pays the prize out of the pool's balance. Idempotency: the
 * per-(week, user) `claimed` map in the on-chain `PrizePool` aborts
 * double-claims, so a retry is safe.
 *
 * Two modes:
 *   - Default: stage the signature only; the user re-asks via
 *     `GET /prize/signature?week=N&rank=R` and submits the claim tx
 *     from their own wallet. This keeps the agent key off the user's
 *     hot path and matches the `expectedAmountForRank` distribution
 *     stored on-chain.
 *   - `PRIZE_AUTO_CLAIM=true`: the agent submits the claim PTB on the
 *     user's behalf. Useful for fully-custodial demos; not for mainnet.
 */
import {
  buildClaimPrizeTx,
  createClient,
  DEFAULT_DISTRIBUTION_BPS,
  executeTransaction,
  expectedAmountForRank,
  signClaimPayload,
  streakIdForUser,
  type ClaimPayload,
} from "@suipredict/sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import {
  listWeeklyLeaderboard,
  recordPrizeClaim,
  weekIndexFor,
} from "../gamification/store.js";

const PRIZE_POOL_ID = process.env.PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.PRIZE_ADMIN_ID ?? "";
const STREAK_REGISTRY_ID = process.env.STREAK_REGISTRY_ID ?? "";
const PRIZE_ADMIN_PRIVATE_KEY = process.env.PRIZE_ADMIN_PRIVATE_KEY ?? "";
const PRIZE_WEEKLY_AMOUNT = BigInt(process.env.PRIZE_WEEKLY_AMOUNT ?? "0");
const PRIZE_AUTO_CLAIM = process.env.PRIZE_AUTO_CLAIM === "true";

async function signWithPrizeKey(payload: ClaimPayload) {
  if (!PRIZE_ADMIN_PRIVATE_KEY) {
    throw new Error("PRIZE_ADMIN_PRIVATE_KEY not set");
  }
  const key = Ed25519Keypair.fromSecretKey(PRIZE_ADMIN_PRIVATE_KEY);
  return signClaimPayload(key, payload, async (b) => keccak_256(b));
}

export async function runPrizeDistributor(
  _ctx: AgentContext,
): Promise<AgentResult> {
  if (!PRIZE_POOL_ID || !PRIZE_ADMIN_ID) {
    return recordResult("PrizeDistributor", {
      action: "skip",
      reasoning:
        "PRIZE_POOL_ID / PRIZE_ADMIN_ID not configured — distributor inert.",
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
  const client = createClient();
  let poolBalance = 0n;
  try {
    const { objects } = await client.getObjects({
      objectIds: [PRIZE_POOL_ID],
      include: { json: true },
    });
    const obj = objects[0];
    if (obj && !(obj instanceof Error)) {
      const json = obj.json as { balance?: string | number } | null;
      if (json) poolBalance = BigInt(json.balance ?? 0);
    }
  } catch (e) {
    return recordResult("PrizeDistributor", {
      action: "skip",
      reasoning: `Could not read PrizePool ${PRIZE_POOL_ID}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    });
  }
  if (poolBalance === 0n) {
    return recordResult("PrizeDistributor", {
      action: "skip",
      reasoning: `PrizePool ${PRIZE_POOL_ID} has 0 balance; bootstrap fund_pool likely failed. Refusing to sign claims that would abort on-chain.`,
    });
  }

  const priorWeek = weekIndexFor(Date.now()) - 1;
  const top = listWeeklyLeaderboard(priorWeek, 10);
  if (top.length === 0) {
    return recordResult("PrizeDistributor", {
      action: "noop",
      reasoning: `No archived rows for week ${priorWeek}.`,
    });
  }

  const autoClaimClient = PRIZE_AUTO_CLAIM ? createClient() : null;
  let signed = 0;
  let autoClaimed = 0;
  let failed = 0;

  for (const row of top) {
    const rank = row.rank;
    const amount = expectedAmountForRank(
      PRIZE_WEEKLY_AMOUNT,
      rank,
      DEFAULT_DISTRIBUTION_BPS,
    );
    if (amount === 0n) continue;

    const payload: ClaimPayload = {
      poolId: PRIZE_POOL_ID,
      weekIndex: BigInt(priorWeek),
      user: row.user,
      rank,
      amount,
    };
    try {
      const signedClaim = await signWithPrizeKey(payload);
      recordPrizeClaim({
        user: row.user,
        week_index: priorWeek,
        rank,
        amount: Number(amount),
        tx_digest: null,
        claimed_at_ms: Date.now(),
      });
      signed++;

      if (PRIZE_AUTO_CLAIM && autoClaimClient) {
        const userStreakId = await streakIdForUser(
          autoClaimClient,
          STREAK_REGISTRY_ID,
          row.user,
        );
        if (!userStreakId) {
          failed++;
          console.error(
            `[prize-distributor] no UserStreak for ${row.user} — skipping auto-claim`,
          );
          continue;
        }
        const tx = buildClaimPrizeTx({
          poolId: PRIZE_POOL_ID,
          prizeAdminId: PRIZE_ADMIN_ID,
          userStreakId,
          weekIndex: BigInt(priorWeek),
          rank,
          amount,
          signatureB64: signedClaim.signatureB64,
          poolIdForSig: PRIZE_POOL_ID,
        });
        try {
          const res = await executeTransaction(autoClaimClient, tx, _ctx.signer);
          recordPrizeClaim({
            user: row.user,
            week_index: priorWeek,
            rank,
            amount: Number(amount),
            tx_digest: res.digest,
            claimed_at_ms: Date.now(),
          });
          autoClaimed++;
        } catch (err) {
          failed++;
          console.error(
            `[prize-distributor] auto-claim failed for ${row.user}:`,
            err,
          );
        }
      }
    } catch (err) {
      failed++;
      console.error(`[prize-distributor] sign failed for ${row.user}:`, err);
    }
  }

  return recordResult("PrizeDistributor", {
    action: "distribute",
    reasoning: `Week ${priorWeek}: ${signed} signed, ${autoClaimed} auto-claimed, ${failed} failed.`,
    confidence: 100,
  });
}
