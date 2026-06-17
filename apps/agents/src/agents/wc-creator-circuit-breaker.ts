/**
 * wc-creator-circuit-breaker.ts
 * ============================================================================
 * Persistent circuit breaker for the `world-cup-creator` agent.
 *
 * The Sui system `CoinRegistry` (at 0xc) only allows ONE `Currency<T>` per
 * type T per package. The on-chain `create_market` and
 * `create_market_with_pool` both call `coin_registry::new_currency<YES<Q>>`
 * which aborts with `ECurrencyAlreadyExists` after the first market per
 * package. Re-trying every 15 min just produces N identical MoveAborts in
 * the decision feed.
 *
 * R-WC-1.2 fix: after the first `ECurrencyAlreadyExists` failure, persist
 * a flag in a small JSON file and short-circuit subsequent ticks. The flag
 * is automatically reset by the bootstrap script when a new market is
 * successfully created (i.e., when a new contract version with per-market
 * coin types is deployed and the wc-creator can create more than one
 * market per registry).
 *
 * File location: `${DATA_DIR}/wc-creator-circuit-breaker.json` (defaults to
 * `apps/agents/data/wc-creator-circuit-breaker.json`).
 *
 * Schema (JSON object):
 *   {
 *     "coinRegistryFull": boolean,    // true = registry is full
 *     "firstErrorAt": number,         // unix ms of first ECurrencyAlreadyExists
 *     "firstErrorMarket": string,     // market id that hit the limit
 *     "resetAt": number | null,       // unix ms when the flag was last reset
 *     "resetReason": string | null    // "manual" | "new-market" | null
 *   }
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.DATA_DIR ?? join(__dirname, "../../data");
const STATE_PATH = join(STATE_DIR, "wc-creator-circuit-breaker.json");

export type CircuitBreakerState = {
  coinRegistryFull: boolean;
  firstErrorAt: number | null;
  firstErrorMarket: string | null;
  resetAt: number | null;
  resetReason: string | null;
};

const EMPTY_STATE: CircuitBreakerState = {
  coinRegistryFull: false,
  firstErrorAt: null,
  firstErrorMarket: null,
  resetAt: null,
  resetReason: null,
};

function readState(): CircuitBreakerState {
  try {
    if (!existsSync(STATE_PATH)) return { ...EMPTY_STATE };
    const raw = readFileSync(STATE_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CircuitBreakerState>;
    return { ...EMPTY_STATE, ...parsed };
  } catch {
    // Corrupt file or permission error — treat as fresh state
    return { ...EMPTY_STATE };
  }
}

function writeState(s: CircuitBreakerState): void {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch {
    // Best-effort persistence. A failed write means the
    // circuit-breaker will re-trigger on the next tick,
    // which is the safe default.
  }
}

export function isCoinRegistryFull(): boolean {
  return readState().coinRegistryFull;
}

export function tripCoinRegistryFull(marketId: string): void {
  const s = readState();
  if (s.coinRegistryFull) return; // already tripped
  s.coinRegistryFull = true;
  s.firstErrorAt = Date.now();
  s.firstErrorMarket = marketId;
  writeState(s);
  console.warn(
    `[circuit-breaker] CoinRegistry is now FULL (tripped by ${marketId}). ` +
      `wc-creator will short-circuit until the registry is reset. ` +
      `See docs/SOP-DEPLOYMENT.md for the contract-upgrade path.`,
  );
}

export function resetCoinRegistryFull(reason: "manual" | "new-market"): void {
  const s = readState();
  s.coinRegistryFull = false;
  s.resetAt = Date.now();
  s.resetReason = reason;
  writeState(s);
  console.log(`[circuit-breaker] CoinRegistry reset (reason: ${reason})`);
}

export function getCircuitBreakerState(): CircuitBreakerState {
  return readState();
}
