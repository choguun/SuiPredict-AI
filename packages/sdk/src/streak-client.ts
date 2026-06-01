/**
 * Streak SDK — wraps `streak_system.move` (suipredict module).
 *
 * Functions:
 *   - buildCreateStreakTx         — user creates their own UserStreak
 *   - buildRecordParticipationTx  — backend records a user-day outcome
 *   - buildRedeemWithStreakTx     — user redeems with streak multiplier
 *   - buildClaimBadgeTx           — user claims an earned tier badge
 *   - getStreakInfo               — view: read UserStreak fields
 *   - streakIdForUser             — view: lookup streak ID by owner address
 */
import { Transaction } from "@mysten/sui/transactions";
import { CLOCK_OBJECT_ID, DUSDC_TYPE } from "./constants.js";
import type { SuiClient } from "./predict-client.js";
import { extractCreatedObjectId } from "./predict-client.js";

const PREDICT_MARKET_PACKAGE_ID = process.env.PREDICT_MARKET_PACKAGE_ID ?? "";
const AGENT_POLICY_PACKAGE_ID = process.env.AGENT_POLICY_PACKAGE_ID ?? "";

const PKG = () => AGENT_POLICY_PACKAGE_ID || PREDICT_MARKET_PACKAGE_ID;

export interface StreakInfo {
  streak_id: string;
  owner: string;
  current_streak: number;
  longest_streak: number;
  last_participation_day: number;
  total_participated: number;
  total_correct: number;
  multiplier_tier: number;
  multiplier_bps: number;
  claimed_tiers: boolean[];
  has_participated: boolean;
  market_category: number;
}

/** Outcome codes matching `streak_system.move::OUTCOME_*`. */
export const OUTCOME = {
  NOT_SUBMITTED: 0,
  ALL_CORRECT: 1,
  SOME_WRONG: 2,
} as const;

/**
 * Build `create_streak` transaction. User self-registers their streak.
 * Pass the shared `StreakRegistry` object id.
 */
export function buildCreateStreakTx(registryId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::streak_system::create_streak`,
    arguments: [tx.object(registryId)],
  });
  return tx;
}

/**
 * Build `record_participation` transaction. Called by the backend agent
 * for each (user, day_index) pair.
 *
 * @param adminId   - shared `StreakAdmin` object id
 * @param registryId - shared `StreakRegistry` object id
 * @param streakId  - the user's `UserStreak` object id
 * @param dayIndex  - `clock.timestamp_ms() / 86_400_000` at resolution time
 * @param outcome   - 0=NotSubmitted, 1=AllCorrect, 2=SomeWrong
 * @param category  - 0=none, 1=AI news, 2=crypto price, 3=other
 */
export function buildRecordParticipationTx(params: {
  adminId: string;
  registryId: string;
  streakId: string;
  dayIndex: bigint;
  outcome: number;
  category: number;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::streak_system::record_participation`,
    arguments: [
      tx.object(params.adminId),
      tx.object(params.registryId),
      tx.object(params.streakId),
      tx.pure.u64(params.dayIndex),
      tx.pure.u8(params.outcome),
      tx.pure.u8(params.category),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `redeem_with_streak` transaction. Burns winning YES tokens and
 * pays out collateral multiplied by the user's streak multiplier.
 */
export function buildRedeemWithStreakTx(
  marketId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PREDICT_MARKET_PACKAGE_ID}::prediction_market::redeem_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(winningCoinId),
      tx.object(streakId),
    ],
  });
  return tx;
}

/**
 * Build `redeem_no_with_streak` transaction. Same as above for NO positions.
 */
export function buildRedeemNoWithStreakTx(
  marketId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PREDICT_MARKET_PACKAGE_ID}::prediction_market::redeem_no_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(marketId),
      tx.object(winningCoinId),
      tx.object(streakId),
    ],
  });
  return tx;
}

/**
 * Build `claim_badge` transaction. Tier 1..5; 1=bronze (3d), 5=diamond (100d).
 */
export function buildClaimBadgeTx(streakId: string, tier: number): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::streak_system::claim_badge`,
    arguments: [tx.object(streakId), tx.pure.u8(tier)],
  });
  return tx;
}

/**
 * Read a `UserStreak` object's fields.
 */
export async function getStreakInfo(
  client: SuiClient,
  streakId: string,
): Promise<StreakInfo | null> {
  try {
    const { object } = await client.core.getObject({
      objectId: streakId,
      include: { json: true },
    });
    const fields = object.json as Record<string, unknown> | null;
    if (!fields || !object.type.includes("::streak_system::UserStreak")) {
      return null;
    }
    const claimedTiers = (fields.claimed_tiers as boolean[]) ?? [];
    const currentStreak = Number(fields.current_streak ?? 0);
    const tier = Number(fields.multiplier_tier ?? 0);
    const multiplierBps = computeMultiplierBps(tier);
    return {
      streak_id: streakId,
      owner: fields.owner as string,
      current_streak: currentStreak,
      longest_streak: Number(fields.longest_streak ?? 0),
      last_participation_day: Number(fields.last_participation_day ?? 0),
      total_participated: Number(fields.total_participated ?? 0),
      total_correct: Number(fields.total_correct ?? 0),
      multiplier_tier: tier,
      multiplier_bps: multiplierBps,
      claimed_tiers: claimedTiers,
      has_participated: Boolean(fields.has_participated ?? false),
      market_category: Number(fields.market_category ?? 0),
    };
  } catch {
    return null;
  }
}

/**
 * Lookup a user's `UserStreak` ID via the shared `StreakRegistry`.
 */
export async function streakIdForUser(
  client: SuiClient,
  registryId: string,
  userAddress: string,
): Promise<string | null> {
  try {
    const { object } = await client.core.getObject({
      objectId: registryId,
      include: { json: true },
    });
    const fields = object.json as { streaks?: Record<string, string> } | null;
    if (!fields?.streaks) return null;
    return fields.streaks[userAddress] ?? null;
  } catch {
    return null;
  }
}

/**
 * Compute the multiplier bps for a given tier. Mirrors the on-chain
 * `streak_system::get_multiplier_bps` table.
 */
export function computeMultiplierBps(tier: number): number {
  switch (tier) {
    case 0: return 10_000;
    case 1: return 11_000;
    case 2: return 13_000;
    case 3: return 17_000;
    case 4: return 25_000;
    case 5: return 30_000;
    default: return 10_000;
  }
}

/**
 * Compute today's UTC day index.
 */
export function currentDayIndex(): bigint {
  return BigInt(Math.floor(Date.now() / 86_400_000));
}

/**
 * Helper: parse the `UserStreak` object ID out of a `create_streak` tx.
 */
export async function extractStreakId(
  client: SuiClient,
  digest: string,
): Promise<string | null> {
  return extractCreatedObjectId(
    client,
    digest,
    `${PKG()}::streak_system::UserStreak`,
  );
}
