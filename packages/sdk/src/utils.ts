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
