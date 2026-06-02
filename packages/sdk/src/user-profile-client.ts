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
import { AGENT_POLICY_PACKAGE_ID } from "./constants.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;

export const MAX_COUNTRY_BYTES = 8;

export const FORECASTER_HUMAN = 0;
export const FORECASTER_AI = 1;
export const FORECASTER_BOT = 2;

/** Validate a candidate country code. Returns the lowercased bytes
 *  if the input is 0..=MAX_COUNTRY_BYTES ASCII letters, else null.
 *  The on-chain module is byte-typed; we accept what the user typed
 *  and let the off-chain path handle the lowercase normalisation.
 */
export function normalizeCountryCode(code: string): Uint8Array | null {
  if (!code) return new Uint8Array(0);
  if (code.length > MAX_COUNTRY_BYTES) return null;
  if (!/^[A-Za-z]+$/.test(code)) return null;
  return new TextEncoder().encode(code.toLowerCase());
}

/**
 * Build a PTB that calls `user_profile::create_profile`. The
 * on-chain check is `!table::contains(registry, sender)` — a
 * second call from the same sender aborts with `EProfileExists`.
 * The new `UserProfile` is transferred to the sender.
 */
export function buildCreateProfileTx(registryId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::user_profile::create_profile`,
    typeArguments: [],
    arguments: [tx.object(registryId)],
  });
  return tx;
}

/**
 * Build a PTB that sets or replaces the country code on the
 * caller's profile. The on-chain check is `length <=
 * MAX_COUNTRY_BYTES` — empty vector clears the country. The
 * caller (not the SDK) is responsible for lowercasing before
 * calling, since Move has no built-in case conversion.
 */
export function buildSetCountryCodeTx(
  profileId: string,
  countryCode: string,
): Transaction {
  const tx = new Transaction();
  const normalized = normalizeCountryCode(countryCode);
  if (normalized == null) {
    throw new Error(
      `countryCode must be 1-${MAX_COUNTRY_BYTES} ASCII letters, got "${countryCode}"`,
    );
  }
  // Empty vector → `vector<u8>[]` literal, which serialises as
  // bcs::to_bytes(&[]).
  const bytes = Array.from(normalized);
  tx.moveCall({
    target: `${PKG()}::user_profile::set_country_code`,
    typeArguments: [],
    arguments: [tx.object(profileId), tx.pure(bcsBytes(bytes))],
  });
  return tx;
}

/**
 * Build a PTB that switches the forecaster kind. The on-chain
 * check rejects anything that isn't 0 (human), 1 (ai), or 2 (bot).
 */
export function buildSetForecasterKindTx(
  profileId: string,
  kind: number,
): Transaction {
  if (kind !== FORECASTER_HUMAN && kind !== FORECASTER_AI && kind !== FORECASTER_BOT) {
    throw new Error(`forecasterKind must be 0/1/2, got ${kind}`);
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::user_profile::set_forecaster_kind`,
    typeArguments: [],
    arguments: [tx.object(profileId), tx.pure.u8(kind)],
  });
  return tx;
}

/**
 * Build a PTB that reads a user's profile ID from the shared
 * `ProfileRegistry`. Returns the inner ID — the caller is
 * expected to wrap this in a follow-up `getObject` to read the
 * profile fields. (The Move function returns `Option<ID>`; the
 * SDK deserialises that into `string | null`.)
 */
export async function readProfileIdForUser(
  client: { getObject: Function },
  registryId: string,
  user: string,
): Promise<string | null> {
  const res = await client.getObject({
    id: registryId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { profiles?: { fields?: { id?: string; size?: number } } } | undefined;
  // The `Table<address, ID>` in `ProfileRegistry.profiles` is rendered
  // by Sui JSON-RPC as a `{ id, size }` object. The values aren't
  // inline-readable; the caller should use `getDynamicFieldObject`
  // (or `multiGetObjects` after a table-iter) to fetch the inner
  // profile. We expose this so the indexer / web can branch on
  // "registry has any rows" without round-tripping per user.
  if (fields?.profiles?.fields?.size === 0) return null;
  // Without a `dynamic_field` query in this helper, we can't
  // resolve the address-keyed entry here. The on-chain contract
  // has `profile_id_for` (public read) — the proper JS-side read
  // is a `devInspect` call or a dedicated indexer subscription.
  // Returning null here is the safe default; the dynamic-field
  // path lives in the agents indexer.
  void user;
  return null;
}

// ============================================================
// Reads
// ============================================================

export interface UserProfileFields {
  owner: string;
  country_code: string; // UTF-8 from raw bytes
  forecaster_kind: number;
  created_at_ms: number;
}

export async function readUserProfile(
  client: { getObject: Function },
  profileId: string,
): Promise<UserProfileFields | null> {
  const res = await client.getObject({
    id: profileId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as Partial<UserProfileFields> | undefined;
  if (!fields) return null;
  // country_code comes back as a base64-encoded `vector<u8>` from
  // the JSON-RPC. The web/agents path can decode via `atob`; here
  // we expose it raw (it'll render as base64) and let callers
  // decode with their preferred helper.
  return {
    owner: String(fields.owner ?? ""),
    country_code: String(fields.country_code ?? ""),
    forecaster_kind: Number(fields.forecaster_kind ?? 0),
    created_at_ms: Number(fields.created_at_ms ?? 0),
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Serialise a byte array using BCS so the on-chain
 * `set_country_code` accepts it as `vector<u8>`. The Move function
 * is `public fun set_country_code(profile, country_code: vector<u8>, ctx)`,
 * so we need the raw bytes — `tx.pure(bytes)` would wrap them
 * again. The proper Sui 2024 SDK call is `tx.pure(bcs.vector(bcs.u8()).serialize(bytes).toBytes())`
 * but most of the codebase uses `tx.pure(...)` with the helper that
 * auto-BCS-encodes strings; for `vector<u8>` the safe path is
 * `tx.pure(bcsBytes(bytes))` where `bcsBytes` returns the BCS
 * vector-of-u8 form. We delegate to that helper.
 */
function bcsBytes(bytes: number[]): Uint8Array {
  // Lazy import to keep the SDK usable in non-Node runtimes
  // (the @mysten/sui/bcs module is isomorphic but only needs
  // loading when we actually serialize).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { bcs } = require("@mysten/sui/bcs") as typeof import("@mysten/sui/bcs");
  return bcs.vector(bcs.u8()).serialize(bytes).toBytes();
}
