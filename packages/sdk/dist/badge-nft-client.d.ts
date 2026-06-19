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
import type { SuiClient } from "./predict-client.js";
export declare const BADGE_TIER_THRESHOLDS: Record<number, number>;
export declare const BADGE_TIER_NAMES: Record<number, string>;
/**
 * Highest tier the user is eligible to claim, given their longest
 * streak. Returns 0 if even the Bronze tier (3d) isn't reached.
 */
export declare function highestEligibleBadgeTier(longestStreak: number | bigint): number;
/**
 * Build a PTB that mints a `StreakBadge` for the calling user's
 * streak. The badge is transferred to the sender. The on-chain
 * `streak_system::claim_badge` aborts on insufficient
 * `longest_streak` or a previously-claimed tier.
 */
export declare function buildMintBadgeTx(args: {
    streakId: string;
    tier: number;
}): Transaction;
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
export declare function buildMintBadgeToKioskTx(args: {
    streakId: string;
    tier: number;
    kioskId: string;
    kioskCapId: string;
}): Transaction;
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
export declare function readBadge(client: SuiClient, badgeId: string): Promise<BadgeFields | null>;
//# sourceMappingURL=badge-nft-client.d.ts.map