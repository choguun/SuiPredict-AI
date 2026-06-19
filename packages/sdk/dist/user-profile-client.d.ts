/**
 * User Profile SDK — national & AI-forecaster leaderboards
 *
 * Wraps `user_profile.move` (user_profile module) functions:
 *   create_profile, set_country_code, set_forecaster_kind
 *
 * The `UserProfile` is owned by the user. A shared `ProfileRegistry`
 * maps `address → ID` so the off-chain indexer can find a user's
 * profile without walking the address space.
 *
 * Two pieces of mutable metadata:
 *   - `country_code` — ISO-3166-1 alpha-2, lowercased (e.g. "us", "th").
 *     Empty vector means "not set". Max 8 bytes (alpha-2/3 + buffer).
 *   - `forecaster_kind` — 0 = human (default), 1 = ai-assisted, 2 = bot.
 *     Used by the leaderboard worker to split the AI-forecaster ranking
 *     from the human ranking.
 *
 * The country_code is opt-in: a user with no profile is excluded from
 * the national leaderboard but still appears on the global one.
 */
import { Transaction } from "@mysten/sui/transactions";
import type { SuiClient } from "./predict-client.js";
export declare const MAX_COUNTRY_BYTES = 8;
export declare const FORECASTER_HUMAN = 0;
export declare const FORECASTER_AI = 1;
export declare const FORECASTER_BOT = 2;
/** Validate a candidate country code. Returns the lowercased bytes
 *  if the input is 0..=MAX_COUNTRY_BYTES ASCII letters, else null.
 *  The on-chain module is byte-typed; we accept what the user typed
 *  and let the off-chain path handle the lowercase normalisation.
 */
export declare function normalizeCountryCode(code: string): Uint8Array | null;
/**
 * Build a PTB that calls `user_profile::create_profile`. The
 * on-chain check is `!table::contains(registry, sender)` — a
 * second call from the same sender aborts with `EProfileExists`.
 * The new `UserProfile` is transferred to the sender.
 */
export declare function buildCreateProfileTx(registryId: string): Transaction;
/**
 * Build a PTB that sets or replaces the country code on the
 * caller's profile. The on-chain check is `length <=
 * MAX_COUNTRY_BYTES` — empty vector clears the country. The
 * caller (not the SDK) is responsible for lowercasing before
 * calling, since Move has no built-in case conversion.
 */
export declare function buildSetCountryCodeTx(profileId: string, countryCode: string): Transaction;
/**
 * Build a PTB that switches the forecaster kind. The on-chain
 * check rejects anything that isn't 0 (human), 1 (ai), or 2 (bot).
 */
export declare function buildSetForecasterKindTx(profileId: string, kind: number): Transaction;
/**
 * Read a user's `UserProfile` ID from the shared `ProfileRegistry`.
 * Returns null if the user has not created a profile yet.
 *
 * `ProfileRegistry` stores `profiles: Table<address, ID>`. Sui
 * `Table` contents are dynamic fields — they don't appear in
 * `getObject`'s JSON view. We use `getDynamicFieldObject` against
 * the typed key `{type:"address", value:userAddress}`, identical
 * to the `streakIdForUser` pattern in `streak-client.ts:184`.
 *
 * R46 audit fix: the previous implementation read the parent
 * `ProfileRegistry` object and then unconditionally returned
 * null — it never queried the dynamic field and so always
 * reported "user has no profile", which would have silently
 * broken the indexer path that consumes this helper to skip
 * non-profiled users. Implement the dynamic-field read; fall
 * back to null on any error (including 404, which is the
 * expected outcome for users without a profile).
 */
export declare function readProfileIdForUser(client: SuiClient, registryId: string, user: string): Promise<string | null>;
export interface UserProfileFields {
    owner: string;
    country_code: string;
    forecaster_kind: number;
    created_at_ms: number;
}
export declare function readUserProfile(client: SuiClient, profileId: string): Promise<UserProfileFields | null>;
//# sourceMappingURL=user-profile-client.d.ts.map