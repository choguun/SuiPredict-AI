import { getOraclePriceLatest, getOracleState } from "./predict-server.js";
import { strikeToDollars } from "./constants.js";

export async function getSpotPrice(oracleId: string): Promise<number | null> {
  try {
    const latest = await getOraclePriceLatest(oracleId);
    const spot = (latest as { spot?: number }).spot;
    if (spot != null) return spot / 1e9;
  } catch {
    // fall through
  }
  try {
    const state = await getOracleState(oracleId);
    const nested = state as unknown as {
      latest_price?: { spot?: number };
      spot?: number | null;
    };
    const raw = nested.latest_price?.spot ?? nested.spot;
    if (raw != null) return raw / 1e9;
  } catch {
    // ignore
  }
  return null;
}

export async function pickAtmStrike(
  oracleId: string,
  minStrike: number,
  tickSize: number,
): Promise<number> {
  const spot = await getSpotPrice(oracleId);
  if (!spot) return strikeToDollars(BigInt(minStrike));
  const tickDollars = tickSize / 1e9;
  const rounded = Math.round(spot / tickDollars) * tickDollars;
  return Math.max(rounded, strikeToDollars(BigInt(minStrike)));
}

/**
 * True if `addr` is a syntactically valid Sui address AND is not the
 * `0x0…000` placeholder. Used by the admin / referral-keeper / vault
 * forward paths to skip a tx rather than abort on a non-existent
 * recipient. Sui addresses are case-insensitive; the strict form is
 * `0x` + 64 hex chars.
 */
export function isValidSuiAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const normalized = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) return false;
  // Reject the all-zeros placeholder. The address technically
  // validates, but transferring to it is a guaranteed abort.
  if (/^0x0{64}$/.test(normalized)) return false;
  return true;
}

/**
 * Normalize a Sui object id to the canonical form: `0x` + 64 lowercase
 * hex chars. Sui's BCS / object resolver is case-insensitive in some
 * paths and case-sensitive in others; the gRPC `ObjectReference` /
 * `Input` form is strict. Wallets and indexers occasionally hand us
 * mixed-case ids (e.g. from display copy/paste or BE-encoded JSON), and
 * passing the raw string into `tx.object()` / `client.getObject()` can
 * fail with `invalid input object` or `object not found`. Trim
 * whitespace, strip an optional leading `0X`, and lower-case.
 *
 * R42 audit fix: builders across the SDK were forwarding raw `marketId`
 * / `poolId` / `vaultId` strings. Adding the helper here and applying
 * it to the public-facing builders (resolve, dispute, redeem, settle,
 * …) gives callers a single place to fix copy-pasted ids.
 *
 * Throws on syntactically invalid input so the build-time error is
 * readable rather than a cryptic move-abort at the wallet.
 */
export function normalizeObjectId(id: string | null | undefined): string {
  if (id == null) {
    throw new Error("normalizeObjectId: id is required");
  }
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("normalizeObjectId: id is empty");
  }
  const lowered = trimmed.toLowerCase();
  const stripped = lowered.startsWith("0x") ? lowered : `0x${lowered}`;
  if (!/^0x[0-9a-f]{64}$/.test(stripped)) {
    throw new Error(
      `normalizeObjectId: "${trimmed}" is not a valid Sui object id ` +
        `(expected 0x + 64 hex chars)`,
    );
  }
  return stripped;
}

/**
 * Convert a u64 BigInt (or string, as the gRPC / indexer
 * sometimes hands us) to a JavaScript number, logging a
 * warning if the value exceeds `Number.MAX_SAFE_INTEGER`
 * (2^53-1). R46 audit fix: the previous `Number(...)` /
 * `parseInt(...)` calls in `streak-client.ts` and
 * `protocol-reads.ts` would silently lose precision above
 * 2^53 before the caller's number-typed field ever saw
 * the value. Today's streak counters and the prize-pool
 * `distribution_bps` vector all fit comfortably below 2^53
 * (a streak counter of 2^53 days is 285 billion years), but
 * `total_participated` / `total_correct` on a long-running
 * `UserStreak` could in principle grow unbounded, and a
 * future `distribution_bps` schema change (e.g. an additional
 * rank entry) is a silent-corruption trap. Centralize the
 * conversion here so the read paths get the same warning the
 * indexer's write path already emits.
 *
 * `fieldName` and `objectId` are used only in the warning
 * message so an operator chasing a "this value looks wrong"
 * report can map the truncated number back to the on-chain
 * object it came from.
 */
export function u64ToSafeNumber(
  value: bigint | string | number,
  fieldName: string,
  objectId: string,
): number {
  const asBig =
    typeof value === "bigint"
      ? value
      : BigInt(typeof value === "string" ? value : String(value));
  const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
  if (asBig > MAX_SAFE) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sdk] ${fieldName} for ${objectId} (${asBig}) exceeds ` +
        "Number.MAX_SAFE_INTEGER; truncating. The on-chain field is u64; " +
        "if you need exact precision, surface this as a BigInt and " +
        "render with a custom formatter.",
    );
  }
  return Number(asBig);
}
