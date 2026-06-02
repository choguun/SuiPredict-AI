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
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::badge_nft::mint_badge`,
    typeArguments: [],
    arguments: [
      tx.object(args.streakId),
      tx.pure.u8(args.tier),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build a PTB that mints a `StreakBadge` straight into the user's
 * kiosk. The on-chain call is `badge_nft::mint_badge_to_kiosk`,
 * which calls `kiosk::place` internally — skipping the
 * transfer-to-sender hop, so the badge is immediately listable /
 * displayable on TradePort.
 */
export function buildMintBadgeToKioskTx(args: {
  streakId: string;
  tier: number;
  kioskId: string;
  kioskCapId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::badge_nft::mint_badge_to_kiosk`,
    typeArguments: [],
    arguments: [
      tx.object(args.streakId),
      tx.pure.u8(args.tier),
      tx.object(args.kioskId),
      tx.object(args.kioskCapId),
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
  client: { getObject: Function },
  badgeId: string,
): Promise<BadgeFields | null> {
  const res = await client.getObject({
    id: badgeId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as Partial<BadgeFields> | undefined;
  if (!fields) return null;
  return {
    owner: String(fields.owner ?? ""),
    tier: Number(fields.tier ?? 0),
    name: String(fields.name ?? ""),
    threshold_days: Number(fields.threshold_days ?? 0),
    longest_streak_at_mint: Number(fields.longest_streak_at_mint ?? 0),
    minted_at_ms: Number(fields.minted_at_ms ?? 0),
  };
}
