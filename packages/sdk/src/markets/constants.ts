// `MARKET_PACKAGE_ID` and `AGENT_POLICY_PACKAGE_ID` resolve to the
// same on-chain package (the deployed `suipredict_agent_policy`
// package that holds `prediction_market`, `streak_system`,
// `prize_pool`, `agent_policy`, and `types`). Re-export the
// canonical constant here so a future deploy of a fresh address
// only needs to be updated in one place (`constants.ts`).
//
// The previous hard-coded `"0x7377…"` fallback was a legacy Mysten
// Labs predict-server address and never matched the active testnet
// deploy — a fresh `pnpm build` of the web app without env vars
// would bundle the wrong default and every SDK call would silently
// route to a non-existent package. Same class of bug r11 fixed for
// `PREDICT_MARKET_PACKAGE_ID`; this one was missed at the time.
import { AGENT_POLICY_PACKAGE_ID } from "../constants.js";
export const MARKET_PACKAGE_ID =
  process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  AGENT_POLICY_PACKAGE_ID;

export const CLOCK_OBJECT_ID = "0x6";

export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export function bpsToPrice(bps: number): number {
  return bps / 10_000;
}

export function priceToBps(price: number): number {
  return Math.round(price * 10_000);
}

export function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
