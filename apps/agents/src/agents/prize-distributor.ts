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
 * Mode: stage the signature only. The user re-asks via
 *   `GET /prize/signature?week=N&rank=R`
 * and submits the claim tx from their own wallet. This keeps the
 * agent key off the user's hot path.
 *
 * A prior version of this file supported a `PRIZE_AUTO_CLAIM=true`
 * mode that submitted the claim PTB on the user's behalf via the
 * agent's hot-wallet key. The on-chain `claim_prize` enforces
 *   `assert!(ctx.sender() == streak_system::owner_of(user_streak))`,
 * which always aborted with ENotStreakOwner when the agent submitted
 * for a user — `UserStreak.owner` is the user, not the agent. Every
 * auto-claim burned gas, the off-chain `recordPrizeClaim` ran BEFORE
 * the abort with `tx_digest: null`, and the leaderboard's `claimed`
 * annotation lied until the next indexer poll. The auto-claim branch
 * has been removed; if a fully-custodial demo is needed, the user
 * must sign a sponsored PTB (out of scope for this file).
 */
import {
  createClient,
  DEFAULT_DISTRIBUTION_BPS,
  expectedAmountForRank,
  signClaimPayload,
  type ClaimPayload,
} from "@suipredict/sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { keccak_256 } from "@noble/hashes/sha3";
import type { AgentContext, AgentResult } from "../lib.js";
import { recordResult } from "../lib.js";
import {
  listWeeklyLeaderboard,
  weekIndexFor,
} from "../gamification/store.js";

const PRIZE_POOL_ID = process.env.PRIZE_POOL_ID ?? "";
const PRIZE_ADMIN_ID = process.env.PRIZE_ADMIN_ID ?? "";
const PRIZE_ADMIN_PRIVATE_KEY = process.env.PRIZE_ADMIN_PRIVATE_KEY ?? "";
const PRIZE_WEEKLY_AMOUNT = BigInt(process.env.PRIZE_WEEKLY_AMOUNT ?? "0");
// Top-N cap: ranks 1..N get signed; ranks > N have valid leaderboard
// rows but no signed payload, so they can't claim. Matches the
// on-chain `DEFAULT_DISTRIBUTION_BPS` length (10 entries) — the
// default distribution is `0` for ranks beyond the table, so signing
// for rank 11+ would be a no-op anyway. Documented in `docs/gamification.md`.
const TOP_N = Number(process.env.PRIZE_DISTRIBUTOR_TOP_N ?? "10");

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
  const top = listWeeklyLeaderboard(priorWeek, TOP_N);
  if (top.length === 0) {
    return recordResult("PrizeDistributor", {
      action: "noop",
      reasoning: `No archived rows for week ${priorWeek}.`,
    });
  }

  let signed = 0;
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
      await signWithPrizeKey(payload);
      // Do NOT call `recordPrizeClaim` here — the user has not yet
      // submitted the on-chain claim. Writing the off-chain row with
      // `tx_digest: null` would poison the leaderboard's `claimed`
      // annotation: the UI would hide the Claim button, but the
      // on-chain `pool.claimed[week][user]` would still be false. The
      // user could lose the signature, refresh the page, or never
      // visit, and the leaderboard would lie. The off-chain row is
      // written by the web client's POST /prize/claims (called after
      // a successful on-chain claim) and backstopped by the
      // position-indexer's PrizeClaimed poller. This agent only
      // signs; it does not annotate.
      signed++;
    } catch (err) {
      failed++;
      console.error(`[prize-distributor] sign failed for ${row.user}:`, err);
    }
  }

  return recordResult("PrizeDistributor", {
    action: "distribute",
    reasoning: `Week ${priorWeek}: signed ${signed}, failed ${failed} (top-${TOP_N}). User-driven claim only — distributor does not submit on-chain.`,
    confidence: 100,
  });
}
