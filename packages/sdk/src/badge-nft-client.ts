/**
 * Badge NFT SDK — kiosk-compatible streak milestones
 *
 * Wraps `badge_nft.move` (badge_nft module) functions:
 *   mint_badge, mint_badge_to_kiosk
 *
 * Each tier (3d / 7d / 14d / 30d / 100d) mints a `StreakBadge` owned
 * by the user. The badge is `key + store` so it can live in a Kiosk;
 * the module also publishes a default `TransferPolicy<StreakBadge>`
 * so the badges can be listed on TradePort or any kiosk-aware market.
 *
 * Eligibility is gated by `streak_system::claim_badge`, which checks
 * the per-tier threshold against `longest_streak` and aborts on
 * double-claim. The badge NFT is therefore the *visual* representation
 * of the on-chain flag — the `claimed_tiers` vector inside `UserStreak`
 * remains the source of truth.
 */
import { Transaction } from "@mysten/sui/transactions";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID } from "./constants.js";
import type { SuiClient } from "./predict-client.js";
import { normalizeObjectId, u64ToSafeNumber } from "./utils.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;

// Tier thresholds mirror `badge_nft.move::tier_threshold` (in days).
// Exposed so the UI can pre-compute which tiers a user is eligible
// for without an extra round-trip.
export const BADGE_TIER_THRESHOLDS: Record<number, number> = {
  1: 3,
  2: 7,
  3: 14,
  4: 30,
  5: 100,
};

export const BADGE_TIER_NAMES: Record<number, string> = {
  1: "Bronze Predictor",
  2: "Silver Predictor",
  3: "Gold Predictor",
  4: "Platinum Predictor",
  5: "Diamond Predictor",
};

/**
 * Highest tier the user is eligible to claim, given their longest
 * streak. Returns 0 if even the Bronze tier (3d) isn't reached.
 */
export function highestEligibleBadgeTier(longestStreak: number | bigint): number {
  const days = Number(longestStreak);
  if (days >= 100) return 5;
  if (days >= 30) return 4;
  if (days >= 14) return 3;
  if (days >= 7) return 2;
  if (days >= 3) return 1;
  return 0;
}

/**
 * Build a PTB that mints a `StreakBadge` for the calling user's
 * streak. The badge is transferred to the sender. The on-chain
 * `streak_system::claim_badge` aborts on insufficient
 * `longest_streak` or a previously-claimed tier.
 */
export function buildMintBadgeTx(args: {
  streakId: string;
  tier: number; // 1..5
}): Transaction {
  // R54 audit fix: validate `tier ∈ [1, 5]`. The on-chain
  // `streak_system::claim_badge` (called by `badge_nft::mint_badge`)
  // aborts with `EInvalidTier` (code 5) for `tier < 1 || tier > 5`
  // (per `streak_system.move:212`). A `tier = 0` (the default for
  // `Number(undefined)`) burns gas on a guaranteed abort. The
  // web's settings page reads the tier from a user-controlled
  // dropdown; a stale or NaN value silently aborts.
  if (!Number.isInteger(args.tier) || args.tier < 1 || args.tier > 5) {
    throw new Error(
      `buildMintBadgeTx: tier must be an integer in [1, 5] (got ${args.tier})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::badge_nft::mint_badge`,
    typeArguments: [],
    arguments: [
      tx.object(normalizeObjectId(args.streakId)),
      tx.pure.u8(args.tier),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build a PTB that mints a `StreakBadge` directly into a user's
 * Kiosk. Skips the transfer-to-sender hop, so the badge is
 * immediately listable / displayable on TradePort or any
 * kiosk-aware market.
 *
 * R39 audit fix: this wrapper was previously missing — the
 * file's own docstring advertised `mint_badge_to_kiosk` and
 * the agents indexer polls for the `BadgePlacedInKiosk` event,
 * but no client could ever produce one. Without this wrapper
 * the kiosk flow is dead in both directions.
 *
 * The `&mut UserStreak` and `&Clock` parameters match the
 * existing `buildMintBadgeTx` slot order; the new args are
 * the `&mut Kiosk` and `&KioskOwnerCap` shared objects the
 * caller owns. The Move entry point emits both
 * `BadgeMinted` and `BadgePlacedInKiosk` events.
 */
export function buildMintBadgeToKioskTx(args: {
  streakId: string;
  tier: number; // 1..5
  kioskId: string;
  kioskCapId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::badge_nft::mint_badge_to_kiosk`,
    typeArguments: [],
    arguments: [
      tx.object(normalizeObjectId(args.streakId)),
      tx.pure.u8(args.tier),
      tx.object(normalizeObjectId(args.kioskId)),
      tx.object(normalizeObjectId(args.kioskCapId)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ============================================================
// Reads
// ============================================================

export interface BadgeFields {
  owner: string;
  tier: number;
  name: string;
  threshold_days: number;
  longest_streak_at_mint: number;
  minted_at_ms: number;
}

/**
 * Fetch the on-chain fields of a `StreakBadge`. The fields are
 * frozen at mint time — the badge is a memento of *when* the
 * streak crossed the threshold, not a live readout.
 */
export async function readBadge(
  // R50 audit fix: type the client as `SuiClient` and
  // route through `client.core.getObject` with the
  // gRPC `include: { json: true }` shape. The
  // previous duck-type `{ getObject: Function }` is
  // unreachable on a `SuiClient = SuiGrpcClient` —
  // gRPC exposes the call at `client.core.getObject`.
  // Mirror the fix to `readUserProfile` and
  // `readProfileIdForUser` from R50.
  client: SuiClient,
  badgeId: string,
): Promise<BadgeFields | null> {
  const { object } = await client.core.getObject({
    objectId: badgeId,
    include: { json: true },
  });
  const fields = (object?.json as Partial<BadgeFields> | undefined) ?? undefined;
  if (!fields) return null;
  return {
    owner: String(fields.owner ?? ""),
    tier: Number(fields.tier ?? 0),
    name: String(fields.name ?? ""),
    // R48 audit fix: route u64 fields through `u64ToSafeNumber` so
    // a value > 2^53-1 (or just a bad type from the chain) logs a
    // warning instead of silently truncating via `Number()`. The
    // R46 helper was applied to streak/profile-state readers; the
    // badge and user-profile readers were missed.
    threshold_days: u64ToSafeNumber(
      (fields.threshold_days as bigint | string | number | undefined) ?? 0,
      "threshold_days",
      badgeId,
    ),
    longest_streak_at_mint: u64ToSafeNumber(
      (fields.longest_streak_at_mint as bigint | string | number | undefined) ??
        0,
      "longest_streak_at_mint",
      badgeId,
    ),
    minted_at_ms: u64ToSafeNumber(
      (fields.minted_at_ms as bigint | string | number | undefined) ?? 0,
      "minted_at_ms",
      badgeId,
    ),
  };
}
