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
