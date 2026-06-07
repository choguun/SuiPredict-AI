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
import type { SuiClient } from "./predict-client.js";
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
export declare const OUTCOME: {
    readonly NOT_SUBMITTED: 0;
    readonly ALL_CORRECT: 1;
    readonly SOME_WRONG: 2;
};
/**
 * Build `create_streak` transaction. User self-registers their streak.
 * Pass the shared `StreakRegistry` object id.
 */
export declare function buildCreateStreakTx(registryId: string): Transaction;
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
export declare function buildRecordParticipationTx(params: {
    adminId: string;
    registryId: string;
    streakId: string;
    dayIndex: bigint;
    outcome: number;
    category: number;
}): Transaction;
/**
 * Build `rotate_admin` transaction for the `StreakAdmin` capability.
 * The on-chain check is `ctx.sender() == admin_cap.admin`; passing
 * `@0x0` is rejected (EInvalidNewAdmin).
 *
 * `adminCapId` is the shared `StreakAdmin` object id (not the
 * registry — `StreakAdmin` is a separate capability that gates
 * `record_participation` and `rotate_admin`).
 */
export declare function buildRotateStreakAdminTx(adminCapId: string, newAdmin: string): Transaction;
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
export declare function getStreakInfo(client: SuiClient, streakId: string): Promise<StreakInfo | null>;
/**
 * Lookup a user's `UserStreak` ID via the shared `StreakRegistry`.
 *
 * `StreakRegistry` stores `streaks: Table<address, ID>`. Sui `Table`
 * contents are dynamic fields — they don't appear in `getObject`'s
 * JSON view. We use `getDynamicFieldObject` against the typed key
 * `{type:"address", value:userAddress}`.
 */
export declare function streakIdForUser(client: SuiClient, registryId: string, userAddress: string): Promise<string | null>;
/**
 * Compute the multiplier bps for a given tier. Mirrors the on-chain
 * `streak_system::get_multiplier_bps` table.
 */
export declare function computeMultiplierBps(tier: number): number;
/**
 * Compute today's UTC day index.
 */
export declare function currentDayIndex(): bigint;
/**
 * Helper: parse the `UserStreak` object ID out of a `create_streak` tx.
 */
export declare function extractStreakId(client: SuiClient, digest: string): Promise<string | null>;
//# sourceMappingURL=streak-client.d.ts.map