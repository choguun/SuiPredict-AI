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
