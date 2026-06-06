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
import {
  AGENT_POLICY_PACKAGE_ID,
  resolveAgentPolicyPackageId,
} from "../constants.js";

// R56.1 audit fix: trim the env chain like every other env-driven
// const in the SDK. The R41 sweep added `.trim()` to
// `DUSDC_PACKAGE_ID` and `AGENT_POLICY_PACKAGE_ID`; this was the
// survivor. A `.env.local` line with trailing whitespace (common
// when the value is pasted from a docs page or terminal copy)
// produces a value like `0x…0xb177 ` with a trailing space; the
// BCS package resolver treats the trimmed and untrimmed forms as
// different inputs and every PTB aborts with
// "package object not found". Also expose a `resolve…` getter so
// future hot-patch readers (e.g. a `bootstrap-env.ts`-style
// runtime override in the web bundle) can pick up a new value
// without a rebuild.
export const MARKET_PACKAGE_ID = (
  process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  AGENT_POLICY_PACKAGE_ID
).trim();

export function resolveMarketPackageId(): string {
  const env = process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
    process.env.MARKET_PACKAGE_ID;
  return (env ?? resolveAgentPolicyPackageId()).trim();
}

export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

// R56.11 audit fix: reject non-finite inputs at the helper
// boundary. A stale `useMemo` or undefined-derived value
// propagates `NaN` through every admin / portfolio render and
// the page silently shows "$NaN" or "NaN bps". The check
// matches the validation pattern used elsewhere in the SDK
// (e.g. `safeInt`, `safeBigInt`).
export function bpsToPrice(bps: number): number {
  if (!Number.isFinite(bps)) {
    throw new Error(`bpsToPrice: bps must be a finite number (got ${bps})`);
  }
  return bps / 10_000;
}

export function priceToBps(price: number): number {
  if (!Number.isFinite(price)) {
    throw new Error(`priceToBps: price must be a finite number (got ${price})`);
  }
  return Math.round(price * 10_000);
}

export function encodeUtf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
