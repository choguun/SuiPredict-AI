/**
 * Streak SDK — wraps `streak_system.move` (suipredict_agent_policy module).
 *
 * Functions:
 *   - buildCreateStreakTx         — user creates their own UserStreak
 *   - buildRecordParticipationTx  — backend records a user-day outcome
 *   - buildRedeemWithStreakTx     — user redeems with streak multiplier
 *   - getStreakInfo               — view: read UserStreak fields
 *   - streakIdForUser             — view: lookup streak ID by owner address
 *
 * Note: `buildClaimBadgeTx` was removed in R31. The web flow now calls
 * `badge_nft::mint_badge`, which internally invokes `claim_badge`, so a
 * standalone claim wrapper had no consumer (see comment in
 * StreakProfile.tsx for the design note).
 */
import { Transaction } from "@mysten/sui/transactions";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID } from "./constants.js";
import type { SuiClient } from "./predict-client.js";
import { extractCreatedObjectId } from "./predict-client.js";
import { normalizeObjectId, u64ToSafeNumber, isValidSuiAddress } from "./utils.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;

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
    arguments: [tx.object(normalizeObjectId(registryId))],
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
  // R54 audit fix: validate `outcome` ∈ {0,1,2} and `category` ∈
  // {0,1,2,3} at the build boundary. The on-chain
  // `streak_system::record_participation` aborts with `EInvalidOutcome`
  // for out-of-range `outcome`, but has **no** range check on
  // `category` — a stray value (e.g. 200) is stored verbatim in
  // `streak.market_category: u8` and the user silently disappears
  // from every leaderboard filter (the off-chain
  // `streak-sweeper.ts` filters on `category ∈ {0,1,2,3}`). Mirror
  // the R52 `buildCreateMarketTx` category check.
  if (!Number.isInteger(params.outcome) || params.outcome < 0 || params.outcome > 2) {
    throw new Error(
      `buildRecordParticipationTx: outcome must be 0 (NotSubmitted), 1 (AllCorrect), or 2 (SomeWrong) — got ${params.outcome}`,
    );
  }
  if (!Number.isInteger(params.category) || params.category < 0 || params.category > 3) {
    throw new Error(
      `buildRecordParticipationTx: category must be 0 (none), 1 (AI news), 2 (crypto price), or 3 (other) — got ${params.category}`,
    );
  }
  if (params.dayIndex < 0n) {
    throw new Error(
      `buildRecordParticipationTx: dayIndex must be >= 0 — got ${params.dayIndex}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::streak_system::record_participation`,
    arguments: [
      tx.object(normalizeObjectId(params.adminId)),
      tx.object(normalizeObjectId(params.registryId)),
      tx.object(normalizeObjectId(params.streakId)),
      tx.pure.u64(params.dayIndex),
      tx.pure.u8(params.outcome),
      tx.pure.u8(params.category),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `rotate_admin` transaction for the `StreakAdmin` capability.
 * The on-chain check is `ctx.sender() == admin_cap.admin`; passing
 * `@0x0` is rejected (EInvalidNewAdmin).
 *
 * `adminCapId` is the shared `StreakAdmin` object id (not the
 * registry — `StreakAdmin` is a separate capability that gates
 * `record_participation` and `rotate_admin`).
 */
export function buildRotateStreakAdminTx(
  adminCapId: string,
  newAdmin: string,
): Transaction {
  if (!isValidSuiAddress(newAdmin)) {
    // R37 audit fix: pre-validate the new-admin address here so
    // a typo (`""`, `"0x0"`) surfaces as a build-time error
    // instead of a Move abort at execute time.
    // R49 audit fix: route through `isValidSuiAddress` (was
    // inline `!newAdmin || newAdmin === "0x0" || newAdmin ===
    // "@0x0"`) so the check matches the parlay + prize builders
    // and catches whitespace, mixed-case-with-trailing-space,
    // and the all-zeros placeholder.
    throw new Error(
      `buildRotateStreakAdminTx: newAdmin must be a non-zero Sui address (got "${newAdmin}")`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::streak_system::rotate_admin`,
    arguments: [tx.object(normalizeObjectId(adminCapId)), tx.pure.address(newAdmin)],
  });
  return tx;
}

/**
 * Build `redeem_with_streak` transaction. **Moved to
 * `prediction-market-client.ts` in r16** — the on-chain function lives
 * in `prediction_market.move` (same package as the rest of the
 * redemption API), so all `prediction_market::*` wrappers are
 * co-located there now. The export is re-exported through the
 * wildcard in `index.ts`, so existing imports from `@suipredict/sdk`
 * continue to work.
 */

/**
 * Build `redeem_no_with_streak` transaction. See `buildRedeemWithStreakTx`.
 */

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
    // R46 audit fix: route the u64 fields through the
    // shared `u64ToSafeNumber` helper so a value above
    // 2^53-1 logs a warning instead of silently
    // truncating. `streak_id` is the parent object id,
    // the on-call reporter gets the same trail the
    // indexer's write path already produces.
    const currentStreak = u64ToSafeNumber(
      (fields.current_streak as bigint | string | number | undefined) ?? 0n,
      "current_streak",
      streakId,
    );
    const tier = u64ToSafeNumber(
      (fields.multiplier_tier as bigint | string | number | undefined) ?? 0n,
      "multiplier_tier",
      streakId,
    );
    const multiplierBps = computeMultiplierBps(tier);
    return {
      streak_id: streakId,
      owner: fields.owner as string,
      current_streak: currentStreak,
      longest_streak: u64ToSafeNumber(
        (fields.longest_streak as bigint | string | number | undefined) ?? 0n,
        "longest_streak",
        streakId,
      ),
      last_participation_day: u64ToSafeNumber(
        (fields.last_participation_day as bigint | string | number | undefined) ?? 0n,
        "last_participation_day",
        streakId,
      ),
      total_participated: u64ToSafeNumber(
        (fields.total_participated as bigint | string | number | undefined) ?? 0n,
        "total_participated",
        streakId,
      ),
      total_correct: u64ToSafeNumber(
        (fields.total_correct as bigint | string | number | undefined) ?? 0n,
        "total_correct",
        streakId,
      ),
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
 *
 * `StreakRegistry` stores `streaks: Table<address, ID>`. Sui `Table`
 * contents are dynamic fields — they don't appear in `getObject`'s
 * JSON view. We use `getDynamicFieldObject` against the typed key
 * `{type:"address", value:userAddress}`.
 */
export async function streakIdForUser(
  client: SuiClient,
  registryId: string,
  userAddress: string,
): Promise<string | null> {
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: registryId,
      name: { type: "address", value: userAddress } as unknown as never,
    });
    if (!dynamicField) return null;
    const value = (dynamicField as { value?: unknown }).value;
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && "id" in value) {
      return (value as { id: string }).id;
    }
    return null;
  } catch {
    // Dynamic-field-not-found is the common case for users with no streak
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
