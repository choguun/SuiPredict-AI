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
import type { SuiClient } from "./predict-client.js";
import { normalizeObjectId, u64ToSafeNumber, isValidSuiAddress } from "./utils.js";

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
    arguments: [tx.object(normalizeObjectId(registryId))],
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
    // R38 audit fix: use the modern `tx.pure.vector("u8", bytes)`
    // pattern (see predict-client.ts:392 and prize-client.ts:169
    // for prior art) instead of the local `bcsBytes` helper that
    // pulled in `@mysten/sui/bcs` via `require()`. The require()
    // path is a code-smell that breaks strict-ESM bundlers
    // (e.g. Vite for the web app) and the `tx.pure.vector`
    // helper is the SDK-blessed escape hatch for `vector<u8>`
    // arguments that don't need BCS wrapping.
    arguments: [tx.object(normalizeObjectId(profileId)), tx.pure.vector("u8", bytes)],
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
    arguments: [tx.object(normalizeObjectId(profileId)), tx.pure.u8(kind)],
  });
  return tx;
}

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
export async function readProfileIdForUser(
  // R50 audit fix: type the client as `SuiClient`
  // (the gRPC shape used by `predict-client.ts:21`)
  // and route the dynamic-field read through
  // `client.core.getDynamicField`. The previous
  // `{ getDynamicField: Function }` duck-type was
  // calling the legacy `client.getDynamicField`,
  // which is unreachable on a `SuiClient` (gRPC
  // has no top-level `getDynamicField` — it lives
  // at `client.core.getDynamicField`). The R46
  // comment claimed the modern path was preferred
  // but the implementation only used the legacy
  // one. R47's "drop the over-specified getObject
  // requirement" then never fired because the
  // underlying call would have always thrown.
  // The sibling `streakIdForUser` (`streak-client.ts:225`)
  // uses the correct `client.core.getDynamicField`
  // pattern — mirror that.
  client: SuiClient,
  registryId: string,
  user: string,
): Promise<string | null> {
  // R56.7 audit fix: lowercase the user address and reject
  // whitespace-suffixed input before the dynamic-field lookup.
  // The on-chain `ProfileRegistry.profiles: Table<address, ID>`
  // stores the canonical lowercase 32-byte form; a mixed-case
  // paste from a Suiscan link returns `null` and the settings
  // page would claim the user has no profile (when they do),
  // prompting them to create a second profile that aborts
  // with `EProfileExists`. Short-circuit on malformed input so
  // a typo doesn't burn a getDynamicField RPC either.
  const normalizedUser = user.trim().toLowerCase();
  if (!isValidSuiAddress(normalizedUser)) return null;
  try {
    const { dynamicField } = await client.core.getDynamicField({
      parentId: registryId,
      name: { type: "address", value: normalizedUser } as unknown as never,
    });
    if (!dynamicField) return null;
    const value = (dynamicField as { value?: unknown }).value;
    if (typeof value === "string") return value;
    if (typeof value === "object" && value !== null && "id" in value) {
      return (value as { id: string }).id;
    }
    return null;
  } catch {
    // 404 = user has no profile (the expected case for the vast
    // majority of pre-profile users). Any other error = the
    // parent table doesn't exist / wrong network / RPC outage.
    // Both fall through to `null` so callers can branch on
    // "no profile" without distinguishing the two failure
    // modes. The caller is expected to verify the registry
    // exists at boot via the `drift-detector` env-var
    // comparison; this helper is per-user only.
    return null;
  }
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
  // R50 audit fix: type the client as `SuiClient` and
  // route through `client.core.getObject` with the gRPC
  // shape. The legacy `client.getObject` is unreachable
  // on a `SuiClient = SuiGrpcClient` (gRPC has no
  // top-level `getObject`). The previous
  // `{ getObject: Function }` duck-type compiled but
  // threw at runtime the first time a real call
  // happened. Mirror `getStreakInfo` (`streak-client.ts:150`)
  // which already uses the correct path.
  client: SuiClient,
  profileId: string,
): Promise<UserProfileFields | null> {
  const { object } = await client.core.getObject({
    objectId: profileId,
    include: { json: true },
  });
  const fields = (object?.json as Partial<UserProfileFields> | undefined) ?? undefined;
  if (!fields) return null;
  // R44 audit fix: `country_code` is a `vector<u8>` on-chain, and
  // Sui JSON-RPC renders it in two shapes depending on the codec:
  //   - the gRPC / indexer path (`@mysten/sui/client/getFullnodeObject`)
  //     emits a `number[]` byte array (e.g. `[117, 115]` for "us"),
  //   - the legacy JSON-RPC `getObject` path (used by the
  //     web/settings page and the agents /profile/:addr route
  //     before R44) emits a base64 string.
  // The previous `String(fields.country_code ?? "")` returned:
  //   - "117,115" for the number[] shape (joined by `Array#toString`),
  //     which the settings page then tried to `.toLowerCase()` and
  //     submit as a country code, producing a "117,115" country
  //     that `set_country_code` later rejected with
  //     `EInvalidCountry` (non-ASCII), or
  //   - "dXM=" for the base64 shape, which `set_country_code`
  //     would also reject (non-ASCII) on re-save.
  // Decode both shapes here so the same `country_code` string
  // round-trips through `set_country_code` without an
  // `EInvalidCountry` abort.
  return {
    owner: String(fields.owner ?? ""),
    country_code: decodeCountryCodeField(fields.country_code),
    forecaster_kind: Number(fields.forecaster_kind ?? 0),
    // R48 audit fix: route u64 fields through `u64ToSafeNumber` so
    // a value > 2^53-1 (or a bad type from the chain) logs a
    // warning instead of silently truncating via `Number()`.
    created_at_ms: u64ToSafeNumber(
      (fields.created_at_ms as bigint | string | number | undefined) ?? 0,
      "created_at_ms",
      profileId,
    ),
  };
}

/**
 * Decode the `country_code` `vector<u8>` field as returned by
 * Sui JSON-RPC. Two valid shapes:
 *   - `number[]` (gRPC codec): the byte array rendered directly;
 *     decode via `Uint8Array.from` + `TextDecoder`.
 *   - `string` (legacy JSON-RPC): base64-encoded; decode via
 *     `Buffer.from(..., "base64")`.
 * Returns the empty string for an unset/empty country code so the
 * settings page's `value={country}` shows a blank input rather
 * than the raw base64 of "empty bytes".
 */
function decodeCountryCodeField(raw: unknown): string {
  if (raw == null) return "";
  if (Array.isArray(raw)) {
    // gRPC / indexer path. An empty `vector<u8>` is `[]`.
    if (raw.length === 0) return "";
    if (!raw.every((b) => typeof b === "number" && b >= 0 && b <= 255)) {
      return "";
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(raw as number[]),
      );
    } catch {
      // Not valid UTF-8 — the on-chain state shouldn't allow
      // this, but if a future Move change stores binary data
      // here the helper should not throw. Fall through to the
      // base64 fallback in case the array was base64-encoded
      // by some intermediate (uncommon).
      try {
        return Buffer.from(
          Uint8Array.from(raw as number[]),
        ).toString("base64");
      } catch {
        return "";
      }
    }
  }
  if (typeof raw === "string") {
    if (raw.length === 0) return "";
    // Legacy JSON-RPC returns a base64 string. Decode it the same
    // way the gRPC number[] path does, then UTF-8 decode the
    // bytes. We attempt the strict TextDecoder path first and
    // fall back to a string copy (the field is supposed to be
    // 0..=8 ASCII letters, so a raw copy is the safe last
    // resort).
    try {
      const bytes = Buffer.from(raw, "base64");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return raw;
    }
  }
  return "";
}

// ============================================================
// Helpers
// ============================================================
//
// R38 audit fix: the `bcsBytes` helper that previously lived here
// (and serialised a number[] to a BCS-encoded `vector<u8>`) has
// been removed. The single call site (setCountryCodeTx above) now
// uses `tx.pure.vector("u8", bytes)` — the SDK-blessed pattern —
// which avoids the `require("@mysten/sui/bcs")` lazy import that
// broke under strict-ESM bundlers. The Move function
// `set_country_code(profile, country_code: vector<u8>, ctx)` is
// unchanged on the chain side; only the SDK encoding path moved.
// ============================================================
