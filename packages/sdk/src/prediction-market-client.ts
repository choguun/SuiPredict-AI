/**
 * Prediction Market SDK — DeepBook V3 integrated
 *
 * Wraps prediction_market.move (suipredict module) functions:
 *   create_market, mint_shares, resolve_market,
 *   redeem, redeem_no, setup_referral, claim_referral_rewards, withdraw_fees
 *
 * Market making is handled by deepbook/client.ts (DeepBookClient).
 * This module handles only the prediction-market-specific on-chain calls.
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  AGENT_POLICY_PACKAGE_ID,
  CLOCK_OBJECT_ID,
  DUSDC_TYPE,
  resolveAgentPolicyPackageId,
} from "./constants.js";
import { encodeUtf8 } from "./markets/constants.js";
import {
  DEEP_TYPE,
  DEEPBOOK_PACKAGE_ID,
  DEEPBOOK_REGISTRY_ID,
  POOL_CREATION_FEE_DEEP,
} from "./deepbook/constants.js";
import {
  createDeepBookClient,
  buildDeepBookCreateBalanceManagerTx,
  buildDeepBookDepositTx,
  buildDeepBookPlaceLimitOrderTx,
  buildDeepBookWithdrawSettledTx,
  createPredictionDeepBookClient,
  getOrderBookDepth,
  getMidPrice,
  type DeepBookClient,
  type PredictionDeepBookMarketConfig,
  PREDICT_DEEPBOOK_POOL_KEY,
} from "./deepbook/client.js";
import { extractCreatedObjectId } from "./predict-client.js";
import type { SuiClient } from "./predict-client.js";
import { normalizeObjectId, isValidSuiAddress } from "./utils.js";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

// ─── Constants ────────────────────────────────────────────────────────────────

/** PredictionMarket package ID — single source of truth is `AGENT_POLICY_PACKAGE_ID`
 *  in `./constants.js`, which carries the on-chain address from
 *  `packages/contracts/Published.toml`. The package contains
 *  `prediction_market`, `streak_system`, `prize_pool`, `agent_policy`,
 *  and `types`; `PREDICT_MARKET_PACKAGE_ID` is re-exported here for
 *  backwards compatibility with the previous (and now-stale) name.
 *
 *  Override at deploy time via `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID`
 *  (Next.js) or `AGENT_POLICY_PACKAGE_ID` (server/agents).
 */
export const PREDICT_MARKET_PACKAGE_ID = AGENT_POLICY_PACKAGE_ID;

// R56.12 audit fix: route the local `PKG()` getter through
// `resolveAgentPolicyPackageId()` so it actually picks up a
// hot-patched env. The R55 sweep added
// `resolveAgentPolicyPackageId()` in `constants.ts:331-339` for
// callers that need hot-patch support, but the internal builders
// in this file used `PREDICT_MARKET_PACKAGE_ID` directly, which
// is a module-level const set at SDK import — a hot-patch of
// `process.env.AGENT_POLICY_PACKAGE_ID` would never reach them.
// The getter-as-function shape was already correct; the body
// was the bug.
const PKG = () => resolveAgentPolicyPackageId();

/**
 * R54 audit fix: helper used by `buildCreateMarketTx` to validate
 * DeepBook's "power of 10" invariants for `tickSize` / `lotSize` /
 * `minSize`. The on-chain `pool::create_permissionless_pool`
 * rejects non-power-of-10 values with `EInvalidTickSize` (5) and
 * `EInvalidLotSize` (6); a build-time throw gives a friendlier
 * error and saves the user the gas.
 *
 * Powers of 10 up to 10^18 cover the full u64 range.
 */
function isPowerOf10(n: bigint): boolean {
  if (n <= 0n) return false;
  const POWERS = [
    1n, 10n, 100n, 1_000n, 10_000n, 100_000n, 1_000_000n,
    10_000_000n, 100_000_000n, 1_000_000_000n, 10_000_000_000n,
    100_000_000_000n, 1_000_000_000_000n, 10_000_000_000_000n,
    100_000_000_000_000n, 1_000_000_000_000_000n,
    10_000_000_000_000_000n, 1_000_000_000_000_000_000n,
  ];
  return POWERS.includes(n);
}

/** FeeVault<DUSDC> object ID — set after contract deployment. The
 *  NEXT_PUBLIC_ variant is read first so Next.js inlines it into the
 *  client bundle; the bare `FEE_VAULT_ID` is the server/agents variant.
 *
 *  R43 audit fix: apply `.trim()` to the env chain to match the
 *  R41 pattern on `DUSDC_PACKAGE_ID` / `AGENT_POLICY_PACKAGE_ID`.
 *  A `.env` line with trailing whitespace (common when a value
 *  is pasted from a docs page or terminal copy) silently produces
 *  an id like `0x…0000 ` with a trailing space; the BCS object
 *  resolver treats the trimmed and untrimmed forms as different
 *  inputs and the PTB aborts with "invalid input object".
 */
export const FEE_VAULT_ID = (
  process.env.NEXT_PUBLIC_FEE_VAULT_ID ??
  process.env.FEE_VAULT_ID ??
  "0x0000000000000000000000000000000000000000000000000000000000000000"
).trim();

/** Protocol treasury address for withdrawing accumulated fees and claiming referral rewards.
 *
 *  R43 audit fix: same `.trim()` as FEE_VAULT_ID above. A
 *  whitespace-suffixed address would route the
 *  `referral_keeper` sweep to a non-existent recipient.
 */
export const REFERRAL_TREASURY_ADDRESS = (
  process.env.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS ??
  process.env.REFERRAL_TREASURY_ADDRESS ??
  process.env.PROTOCOL_TREASURY_ADDRESS ??
  "0x0000000000000000000000000000000000000000000000000000000000000000"
).trim();

// ─── Transaction builders ─────────────────────────────────────────────────────

/**
 * Build `create_market` transaction.
 *
 * Creates a new prediction market + DeepBook pool + YES/NO coin types.
 * Returns (market_id, pool_id) as created objects.
 *
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs        - Unix timestamp (ms) when resolution becomes allowed
 * @param params.tickSize        - Price tick in quote units (e.g. 1_000_000 = 0.001 DUSDC with 6 decimals)
 * @param params.lotSize         - Minimum base-asset quantity per order (in YES * 10^decimals)
 * @param params.minSize         - Minimum order size in base units
 * @param params.deepCoinId      - Object ID of a Coin<DEEP> with at least 500 DEEP for pool creation fee (REQUIRED)
 * @param params.category        - Off-chain topic code forwarded to
 *                                 `MarketCreatedEvent.category`. 0=none,
 *                                 1=AI news, 2=crypto price, 3=other. The
 *                                 on-chain `PredictionMarket` does not
 *                                 store this — the indexer only reads it
 *                                 from the event for leaderboards.
 */
export function buildCreateMarketTx(params: {
  title: string;
  resolutionSource: string;
  expiryMs: bigint;
  tickSize?: bigint;
  lotSize?: bigint;
  minSize?: bigint;
  deepCoinId: string;
  category?: number;
}): Transaction {
  // R52 audit fix: reject empty / missing
  // `deepCoinId` AND route through
  // `normalizeObjectId` for consistency
  // with the rest of the SDK. The
  // previous `if (!params.deepCoinId)`
  // accepted a truthy mixed-case paste
  // (e.g. `0xAbC…`) which then aborted
  // the PTB at BCS resolution with
  // `invalid input object`.
  if (!params.deepCoinId) {
    throw new Error("deepCoinId is required for pool creation");
  }
  // R52 audit fix: validate `expiryMs`
  // is in the future and positive.
  // A `0n` value would make the market
  // immediately resolvable; the creator
  // (or anyone with admin keys) could
  // resolve-and-pin it instantly.
  if (typeof params.expiryMs !== "bigint") {
    throw new Error(
      `buildCreateMarketTx: expiryMs must be bigint, got ${typeof params.expiryMs}`,
    );
  }
  if (params.expiryMs <= 0n) {
    throw new Error(
      `buildCreateMarketTx: expiryMs must be > 0 (got ${params.expiryMs})`,
    );
  }
  if (params.expiryMs <= BigInt(Date.now())) {
    throw new Error(
      `buildCreateMarketTx: expiryMs must be in the future ` +
        `(got ${params.expiryMs}, now=${BigInt(Date.now())})`,
    );
  }
  // R52 audit fix: bound the title and
  // resolution-source vector lengths.
  // The on-chain `vector<u8>` is
  // unbounded, but a 1MB title bloat
  // the `MarketCreatedEvent` payload
  // (the title is duplicated in the
  // event) and every indexer that
  // hydrates the title from the event.
  // 256 / 1024 bytes are comfortable
  // upper bounds for human-readable
  // market questions and resolution
  // sources.
  const MAX_TITLE_BYTES = 256;
  const MAX_RESOLUTION_SOURCE_BYTES = 1024;
  if (!params.title || !params.title.trim()) {
    throw new Error("buildCreateMarketTx: title is required");
  }
  const titleBytes = encodeUtf8(params.title).length;
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new Error(
      `buildCreateMarketTx: title length ${titleBytes} bytes exceeds ${MAX_TITLE_BYTES} (max)`,
    );
  }
  if (!params.resolutionSource || !params.resolutionSource.trim()) {
    throw new Error("buildCreateMarketTx: resolutionSource is required");
  }
  const resBytes = encodeUtf8(params.resolutionSource).length;
  if (resBytes > MAX_RESOLUTION_SOURCE_BYTES) {
    throw new Error(
      `buildCreateMarketTx: resolutionSource length ${resBytes} bytes exceeds ${MAX_RESOLUTION_SOURCE_BYTES} (max)`,
    );
  }
  // R52 audit fix: validate `category`
  // is in `[0, 3]`. The on-chain
  // `category: u8` is unbounded, but
  // the indexer / leaderboard code
  // treats anything outside the four
  // documented values as "other"; a
  // typo (e.g. `200`) would silently
  // mis-categorize the market in every
  // leaderboard that filters on
  // `category`.
  const category = params.category ?? 0;
  if (!Number.isInteger(category) || category < 0 || category > 3) {
    throw new Error(
      `buildCreateMarketTx: category must be 0..3 (0=none, 1=AI, 2=crypto, 3=other), got ${category}`,
    );
  }
  // R52 audit fix: validate tick/lot/min
  // sizes are positive. A 0n value
  // would make DeepBook's pool creation
  // accept a 0-tick pool that no order
  // can match against.
  const tickSize = params.tickSize ?? 1_000_000n;
  const lotSize = params.lotSize ?? 1_000_000n;
  const minSize = params.minSize ?? 1_000_000n;
  if (tickSize <= 0n) {
    throw new Error(`buildCreateMarketTx: tickSize must be > 0 (got ${tickSize})`);
  }
  if (lotSize <= 0n) {
    throw new Error(`buildCreateMarketTx: lotSize must be > 0 (got ${lotSize})`);
  }
  if (minSize <= 0n) {
    throw new Error(`buildCreateMarketTx: minSize must be > 0 (got ${minSize})`);
  }
  // R54 audit fix: validate DeepBook's power-of-10 + lotSize >= 1000
  // + minSize % lotSize == 0 invariants. The on-chain
  // `pool::create_permissionless_pool` enforces:
  //   tick_size must be a power of 10
  //   lot_size must be a power of 10 AND >= 1000
  //   min_size must be a power of 10 AND a multiple of lot_size
  // (`EInvalidTickSize`, `EInvalidLotSize` in pool.move). The R52
  // audit added the positivity checks but missed the deeper
  // constraints — a `lotSize: 500` burns gas on a guaranteed
  // abort. The `market-creator` agent hardcodes safe values, but
  // the admin / web caller could typo.
  if (!isPowerOf10(tickSize)) {
    throw new Error(
      `buildCreateMarketTx: tickSize must be a power of 10 (got ${tickSize})`,
    );
  }
  if (lotSize < 1000n || !isPowerOf10(lotSize)) {
    throw new Error(
      `buildCreateMarketTx: lotSize must be a power of 10 >= 1000 (got ${lotSize})`,
    );
  }
  if (!isPowerOf10(minSize)) {
    throw new Error(
      `buildCreateMarketTx: minSize must be a power of 10 (got ${minSize})`,
    );
  }
  if (minSize % lotSize !== 0n) {
    throw new Error(
      `buildCreateMarketTx: minSize (${minSize}) must be a multiple of lotSize (${lotSize})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::create_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object("0xc"),                                   // Sui CoinRegistry
      tx.object(DEEPBOOK_REGISTRY_ID),
      tx.pure.vector("u8", encodeUtf8(params.title)),
      tx.pure.vector("u8", encodeUtf8(params.resolutionSource)),
      tx.pure.u64(params.expiryMs),
      tx.pure.u64(tickSize),                            // 0.001 DUSDC tick
      tx.pure.u64(lotSize),                             // 1 YES minimum
      tx.pure.u64(minSize),                             // 1 YES minimum
      tx.object(normalizeObjectId(params.deepCoinId)),
      tx.pure.u8(category),
    ],
  });
  return tx;
}

/**
 * Build `mint_shares` transaction.
 *
 * Deposits collateral (DUSDC) and receives equal YES + NO tokens.
 * Takes a 1% protocol fee, routed to the shared `FeeVault<DUSDC>`.
 *
 * @param marketId - PredictionMarket object ID
 * @param vaultId  - FeeVault<DUSDC> object ID (set after `init_fee_vault<DUSDC>`)
 * @param quoteIn  - Coin<DUSDC> to deposit
 */
export function buildMintSharesTx(
  marketId: string,
  vaultId: string,
  quoteIn: string,
  amountAtoms: bigint,
): Transaction {
  // Minimum per-leg amount: 1 YES share at the protocol's default
  // scalar (1e6 = 1 share with 6 decimals). Markets created via
  // `buildCreateMarketTx` use `tickSize: 1_000_000`, `lotSize: 1_000_000`,
  // and `minSize: 1_000_000` — the on-chain `mint_shares` will reject
  // any input below this. Validating here so a fractional-amount
  // typo surfaces as a build-time error with a clear message rather
  // than a Move abort at execute time. Mirrors the validation in
  // `buildMintSharesBatchTx`.
  const MIN_ATOMS = 1_000_000n;
  if (amountAtoms <= 0n) {
    throw new Error(
      `buildMintSharesTx: amountAtoms must be > 0 (got ${amountAtoms})`,
    );
  }
  if (amountAtoms < MIN_ATOMS) {
    throw new Error(
      `buildMintSharesTx: amountAtoms ${amountAtoms} is below the protocol minimum of ${MIN_ATOMS} (1 YES share). ` +
        `Most markets use tickSize=lotSize=1_000_000.`,
    );
  }
  const tx = new Transaction();
  // Split `amountAtoms` off the user's DUSDC coin in-PTB and pass the
  // split result to `mint_shares`. A previous version of this builder
  // passed the whole `Coin<DUSDC>` to `mint_shares` without splitting,
  // which deposited the user's entire balance. The batch variant
  // (`buildMintSharesBatchTx`) already splits correctly; this single-
  // market variant now matches.
  const [mintCoin] = tx.splitCoins(tx.object(normalizeObjectId(quoteIn)), [tx.pure.u64(amountAtoms)]);
  tx.moveCall({
    target: `${PKG()}::prediction_market::mint_shares`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(marketId)), tx.object(normalizeObjectId(vaultId)), mintCoin],
  });
  return tx;
}

/**
 * Build a single PTB that mints `amountPerMarket` of DUSDC into each of
 * `marketIds` in one transaction. The input coin is split in-PTB so the
 * caller only needs to provide a single Coin<DUSDC> with
 * `amountPerMarket * marketIds.length` atoms of balance.
 *
 * Used by the daily-prediction card where the user locks in 3-5 markets
 * at once; submitting them sequentially would consume the same Coin
 * object in tx #1, leaving tx #2..N with a stale reference.
 */
export function buildMintSharesBatchTx(params: {
  marketIds: string[];
  vaultId: string;
  quoteIn: string;
  amountPerMarket: bigint;
}): Transaction {
  const tx = new Transaction();
  // Minimum per-leg amount: 1 YES share at the protocol's default
  // scalar (1e6 = 1 share with 6 decimals). Markets created via
  // `buildCreateMarketTx` use `tickSize: 1_000_000`, `lotSize: 1_000_000`,
  // and `minSize: 1_000_000` — the on-chain `mint_shares` will reject
  // any input below this. We validate here so a fractional-amount
  // typo surfaces as a build-time error with a clear message rather
  // than a Move abort at execute time.
  const MIN_ATOMS = 1_000_000n;
  if (params.amountPerMarket <= 0n) {
    throw new Error(
      `buildMintSharesBatchTx: amountPerMarket must be > 0 (got ${params.amountPerMarket})`,
    );
  }
  if (params.amountPerMarket < MIN_ATOMS) {
    throw new Error(
      `buildMintSharesBatchTx: amountPerMarket ${params.amountPerMarket} ` +
        `is below the protocol minimum of ${MIN_ATOMS} (1 YES share). ` +
        `Most markets use tickSize=lotSize=1_000_000.`,
    );
  }
  if (params.marketIds.length === 0) return tx;
  // splitCoins(coin, [a1, a2, ..., aN]) returns exactly N result
  // references. For N=1 the rest spread is `[]` (still correct) and
  // for N>1 it captures coins 2..N. The destructured shape below
  // covers both the single-market and multi-market cases without an
  // off-by-one — the forEach below iterates `marketIds.length` times
  // and indexes into the same-length `coins` array.
  const amounts = params.marketIds.map(() => tx.pure.u64(params.amountPerMarket));
  const [primaryCoin, ...splitCoins] = tx.splitCoins(
    tx.object(normalizeObjectId(params.quoteIn)),
    amounts,
  );
  const coins = [primaryCoin, ...splitCoins];
  if (coins.length !== params.marketIds.length) {
    throw new Error(
      `buildMintSharesBatchTx: splitCoins produced ${coins.length} coins for ${params.marketIds.length} markets`,
    );
  }
  params.marketIds.forEach((marketId, i) => {
    tx.moveCall({
      target: `${PKG()}::prediction_market::mint_shares`,
      typeArguments: [DUSDC_TYPE],
      arguments: [tx.object(normalizeObjectId(marketId)), tx.object(normalizeObjectId(params.vaultId)), coins[i]!],
    });
  });
  return tx;
}

/**
 * Build `resolve_market` transaction.
 *
 * R42 audit fix: normalize the object id to the canonical
 * `0x` + 64 hex form. Sui's BCS object resolver is case-
 * sensitive in some paths and case-insensitive in others, and
 * the `Input::Pure` / `Input::Object` encoding requires the
 * canonical form. Wallets and explorers occasionally hand us
 * mixed-case ids; passing them through raw can fail with
 * `invalid input object`.
 *
 * @param marketId - PredictionMarket object ID
 * @param outcome  - 1 = YES won, 2 = NO won
 */
export function buildResolveMarketTx(
  marketId: string,
  outcome: 1 | 2,
): Transaction {
  // R56.3 audit fix: validate `outcome` at the build boundary.
  // The TS type is `1 | 2` but the on-chain
  // `prediction_market::resolve_market<Q>` (prediction_market.move:493)
  // asserts `outcome == 1 || outcome == 2` and aborts with
  // `EInvalidOutcome` (code 4) for any other value. A `0` or `3+`
  // silently builds a valid PTB and burns gas on a guaranteed-abort
  // submit. R55 added equivalent per-element validation to the
  // `predictions` vector in `buildCreateParlayTx`; the `outcome` arg
  // was missed. The market-resolver agent reads the outcome from
  // `MintedPosition` / Oracle state and a stale schema field could
  // ship a 0 or 3 — the build-time guard surfaces the typo before
  // the wallet opens.
  if (outcome !== 1 && outcome !== 2) {
    throw new Error(
      `buildResolveMarketTx: outcome must be 1 (YES) or 2 (NO), got ${outcome}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::resolve_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.pure.u8(outcome),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `redeem` (YES winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<YES<DUSDC>> to redeem
 */
export function buildRedeemTx(
  marketId: string,
  vaultId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.object(normalizeObjectId(vaultId)),
      tx.object(normalizeObjectId(winningCoin)),
    ],
  });
  return tx;
}

/**
 * Build `dispute_market` transaction. Files a dispute against a resolved
 * market. Anyone can call within the on-chain 1-hour window after
 * `resolve_market`. The market is frozen (redeem aborts) until
 * `resolve_dispute` is invoked by the creator.
 *
 * R42 audit fix: the on-chain `dispute_market<Q>` enforces
 *   - non-empty evidence: `vector::length > 0` (EZeroAmount)
 *   - upper bound:       `vector::length <= MAX_EVIDENCE_URI_BYTES` (EEvidenceUriTooLong)
 * (see prediction_market.move:518-522). Previously the builder
 * silently forwarded the bytes and let the abort surface as a
 * cryptic move-abort at the wallet. Pre-validate at build time so
 * callers get a readable error before signing.
 *
 * @param marketId     - PredictionMarket object ID
 * @param evidenceUri  - String or bytes containing the dispute evidence
 *                       (URL, IPFS hash, or JSON blob). Must be non-empty
 *                       and no longer than MAX_EVIDENCE_URI_BYTES (256) bytes.
 */
const MAX_EVIDENCE_URI_BYTES = 256;
export function buildDisputeMarketTx(
  marketId: string,
  evidenceUri: string | Uint8Array,
): Transaction {
  const evidence =
    typeof evidenceUri === "string" ? encodeUtf8(evidenceUri) : evidenceUri;
  if (evidence.length === 0) {
    throw new Error(
      "buildDisputeMarketTx: evidenceUri must be non-empty (on-chain " +
        "check is vector::length > 0, see EZeroAmount in " +
        "prediction_market.move)",
    );
  }
  if (evidence.length > MAX_EVIDENCE_URI_BYTES) {
    throw new Error(
      `buildDisputeMarketTx: evidenceUri is ${evidence.length} bytes; ` +
        `the on-chain cap is ${MAX_EVIDENCE_URI_BYTES}. Host longer ` +
        `evidence on IPFS and pass the CID.`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::dispute_market`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.pure.vector("u8", Array.from(evidence)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `resolve_dispute` transaction. Settles a previously-disputed
 * market. Only the creator may invoke.
 */
export function buildResolveDisputeTx(
  marketId: string,
  finalOutcome: 1 | 2,
): Transaction {
  // R56.2 audit fix: validate `finalOutcome` at the build boundary.
  // The TS type is `1 | 2` but no runtime guard is enforced. The
  // on-chain `prediction_market::resolve_dispute<Q>` (prediction_market.move:549)
  // asserts `final_outcome == 1 || final_outcome == 2` and aborts
  // with `EInvalidOutcome` (code 4) for any other value. A `0` or
  // `3+` silently builds a valid PTB and burns gas on a guaranteed
  // abort — and the post-abort operator investigation is non-trivial
  // because the abort surfaces deep inside `resolve_dispute` with
  // no context. `resolve_dispute` is the *final, irreversible*
  // decision on a market; a build-time guard is exactly what the
  // rare-but-critical path needs.
  if (finalOutcome !== 1 && finalOutcome !== 2) {
    throw new Error(
      `buildResolveDisputeTx: finalOutcome must be 1 (YES) or 2 (NO), got ${finalOutcome}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::resolve_dispute`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(marketId)), tx.pure.u8(finalOutcome)],
  });
  return tx;
}

/**
 * Build `redeem_no` (NO winning) transaction.
 *
 * @param marketId    - PredictionMarket object ID
 * @param vaultId     - FeeVault<DUSDC> object ID
 * @param winningCoin - Coin<NO<DUSDC>> to redeem
 */
export function buildRedeemNoTx(
  marketId: string,
  vaultId: string,
  winningCoin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_no`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(marketId)), tx.object(normalizeObjectId(vaultId)), tx.object(normalizeObjectId(winningCoin))],
  });
  return tx;
}

/**
 * Build `redeem_with_streak` (YES winning) transaction. Burns winning
 * YES tokens and pays out collateral multiplied by the user's streak
 * multiplier. The 0.5% protocol fee is routed to the shared `FeeVault`.
 *
 * The on-chain function lives in `prediction_market.move` (same package
 * as the rest of the redemption API). It was originally exposed from
 * `streak-client.ts` because it takes a `UserStreak` arg, but every
 * other redemption function lives here — moved in r16 to keep the
 * `prediction_market::*` wrappers co-located.
 */
export function buildRedeemWithStreakTx(
  marketId: string,
  vaultId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.object(normalizeObjectId(vaultId)),
      tx.object(normalizeObjectId(winningCoinId)),
      tx.object(normalizeObjectId(streakId)),
    ],
  });
  return tx;
}

/** Build `redeem_no_with_streak` transaction. See `buildRedeemWithStreakTx`. */
export function buildRedeemNoWithStreakTx(
  marketId: string,
  vaultId: string,
  winningCoinId: string,
  streakId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::redeem_no_with_streak`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.object(normalizeObjectId(vaultId)),
      tx.object(normalizeObjectId(winningCoinId)),
      tx.object(normalizeObjectId(streakId)),
    ],
  });
  return tx;
}

/**
 * Build `setup_referral` transaction.
 *
 * Mints a DeepBook referral for the market's pool, making this protocol
 * the owner so it can claim additional trading fees.
 *
 * @param marketId  - PredictionMarket object ID
 * @param poolId    - DeepBook Pool object ID (Pool<YES<DUSDC>, DUSDC>)
 * @param multiplier - Referral multiplier (e.g. 1_000_000_000 = 1.0x)
 */
export function buildSetupReferralTx(
  marketId: string,
  poolId: string,
  multiplier: bigint = 1_000_000_000n,
): Transaction {
  // R55 audit fix: validate `multiplier > 0` at the
  // build boundary. The on-chain DeepBook
  // `setup_referral` accepts a 0-multiplier referral
  // (no fee share for the protocol — a silent
  // misconfiguration) and rejects negatives with an
  // opaque DeepBook abort. The market-creator
  // hardcodes a safe value, but the admin page or
  // any future caller could typo.
  if (typeof multiplier !== "bigint" || multiplier <= 0n) {
    throw new Error(
      `buildSetupReferralTx: multiplier must be a bigint > 0 (got ${multiplier})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::setup_referral`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.object(normalizeObjectId(poolId)),
      tx.pure.u64(multiplier),
    ],
  });
  return tx;
}

/**
 * Build `claim_referral_rewards` transaction.
 *
 * Move signs the reward coins to `ctx.sender()` — the caller is the
 * recipient. To route to a treasury, sign the tx with the treasury key.
 *
 * @param poolId     - DeepBook Pool object ID
 * @param referralId - DeepBookPoolReferral object ID
 */
export function buildClaimReferralRewardsTx(
  poolId: string,
  referralId: string,
): Transaction {
  // R56.14 audit fix: reject a copy-paste of `poolId` for
  // `referralId`. Both are 32-byte hex strings and `normalizeObjectId`
  // validates the shape, but the on-chain `claim_referral_rewards`
  // aborts with a generic DeepBook abort on a wrong-key submit and
  // the operator has to dig through the trace to see what they did
  // wrong. Admin scripts that re-use the same `poolId` variable
  // for both args (e.g. a stale `claimRewardsTx(poolId, poolId)`)
  // are the most common shape of this bug.
  if (normalizeObjectId(poolId) === normalizeObjectId(referralId)) {
    throw new Error(
      "buildClaimReferralRewardsTx: poolId and referralId must differ; " +
        "a copy-paste of the same id is always a caller bug",
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::claim_referral_rewards`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.object(normalizeObjectId(referralId))],
  });
  return tx;
}

/**
 * Build `withdraw_fees` transaction.
 *
 * @param vaultId - FeeVault<DUSDC> object ID
 * @param amount  - Amount of DUSDC to withdraw
 */
export function buildWithdrawFeesTx(
  vaultId: string,
  amount: bigint,
): Transaction {
  // R54 audit fix: validate `amount > 0` at the build boundary.
  // The on-chain `withdraw_fees` has no upper-bound check (the
  // vault's `fee_balance` is the limit), but a `0n` withdraw is a
  // guaranteed no-op that wastes gas; a negative `bigint` casts to
  // a huge u64 and the BCS encoder emits a wrap-around. Mirror
  // the R53 `buildAuthorizeSpendTx` pattern.
  if (amount <= 0n) {
    throw new Error(
      `buildWithdrawFeesTx: amount must be > 0 (got ${amount})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::withdraw_fees`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(vaultId)), tx.pure.u64(amount)],
  });
  return tx;
}

/**
 * Build `init_fee_vault` transaction. Called once per quote-coin type
 * by the holder of the `ProtocolAdminCap`. The shared vault object is
 * returned; its `objectId` must be stored in `FEE_VAULT_ID` for later
 * mint/redeem/withdraw-fees calls.
 *
 * @param adminCapId   - ProtocolAdminCap object ID
 * @param vaultAdmin   - Address that will own withdrawals from the vault
 */
export function buildInitFeeVaultTx(
  adminCapId: string,
  vaultAdmin: string,
): Transaction {
  // R49 audit fix: validate `vaultAdmin` at the build boundary.
  // A typo here aborts the tx inside the wallet spinner with a
  // less helpful error than a build-time throw.
  if (!isValidSuiAddress(vaultAdmin)) {
    throw new Error(
      `buildInitFeeVaultTx: vaultAdmin must be a non-zero Sui address (got "${vaultAdmin}")`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::init_fee_vault`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(normalizeObjectId(adminCapId)), tx.pure.address(vaultAdmin)],
  });
  return tx;
}

// ─── Order book helpers ───────────────────────────────────────────────────────

/**
 * Get the on-chain DeepBook order book depth for a prediction market pool.
 *
 * @param dbClient - DeepBookClient instance
 * @param poolId   - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param lowPrice  - Minimum price to query (default 0.01)
 * @param highPrice - Maximum price to query (default 0.99)
 */
export async function getMarketOrderBook(
  dbClient: DeepBookClient,
  poolId: string,
  lowPrice = 0.01,
  highPrice = 0.99,
) {
  return getOrderBookDepth(dbClient, poolId, lowPrice, highPrice);
}

/**
 * Get mid price from DeepBook pool.
 */
export async function getMarketMidPrice(
  dbClient: DeepBookClient,
  poolId: string,
) {
  return getMidPrice(dbClient, poolId);
}

// R49 audit fix: the previous `buildCreateBalanceManagerTx` and
// `buildDepositIntoBalanceManagerTx` lived here but targeted
// `balance_manager::create_balance_manager` and
// `balance_manager::deposit_into_manager` — neither exists in the
// live DeepBook V3 `balance_manager` module. The real builder is
// `buildDeepBookCreateBalanceManagerTx` in `deepbook/client.ts`,
// which calls `new_with_custom_owner`. Any caller that grep'd
// this file and copy-pasted the dead builder would have hit a
// "function not found" linker error at PTB-execute time. The
// functions were also not exported from the SDK barrel
// (`index.ts`), so the only consumer was the file's own module.
// Deleted to remove the footgun; if a future caller needs a
// BalanceManager setup builder, the live one in `deepbook/client.ts`
// is the source of truth.

// ─── Coin type helpers ───────────────────────────────────────────────────────

/**
 * Compute the YES coin type for a given market's PredictionMarket object.
 * YES<Q> = <package>::prediction_market::YES<DUSDC>
 *
 * In Move, the generic type parameter is part of the type identity.
 * For a market at object ID M, the YES type is: <package>::prediction_market::YES<DUSDC>
 */
export function yesCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::YES<${DUSDC_TYPE}>`;
}

export function noCoinType(
  packageId: string = PKG(),
): string {
  return `${packageId}::prediction_market::NO<${DUSDC_TYPE}>`;
}

/**
 * Place a limit order on the DeepBook pool for YES/DUSDC.
 * Convenience wrapper around buildDeepBookPlaceLimitOrderTx.
 */
export function buildPlaceYesLimitOrderTx(
  dbClient: DeepBookClient,
  poolKey: string,
  params: {
    price: number;
    quantity: number;
    isBid: boolean;
    clientOrderId?: string;
    expiration?: number;
  },
): Transaction {
  // R56.13 audit fix: validate `price` and `quantity` at the build
  // boundary. The R53 sweep added the equivalent checks to
  // `buildPlaceOrderTx` (line 996-1004) but missed this older
  // wrapper. The underlying DeepBook `place_limit_order` aborts on
  // `price == 0` or `quantity == 0`; a typo / `0` default silently
  // builds a valid PTB and burns gas on a guaranteed abort. The
  // two builders are aliased through the barrel; a caller who
  // picks the older wrapper should not get a worse error.
  if (!(params.price > 0)) {
    throw new Error(
      `buildPlaceYesLimitOrderTx: price must be > 0, got ${params.price}`,
    );
  }
  if (!(params.quantity > 0)) {
    throw new Error(
      `buildPlaceYesLimitOrderTx: quantity must be > 0, got ${params.quantity}`,
    );
  }
  return buildDeepBookPlaceLimitOrderTx(dbClient, {
    poolKey,
    price: params.price,
    quantity: params.quantity,
    isBid: params.isBid,
    clientOrderId: params.clientOrderId ?? "",
    expiration: params.expiration,
  });
}

/**
 * Withdraw settled amounts from the DeepBook pool.
 */
export function buildWithdrawSettledTx(
  dbClient: DeepBookClient,
  poolKey: string,
): Transaction {
  return buildDeepBookWithdrawSettledTx(dbClient, poolKey);
}

/**
 * Withdraw settled amounts via the market wrapper. Routes through
 * `prediction_market::withdraw_settled` (not the bare DeepBook call)
 * so the on-chain `SettledEvent` is emitted. The market-level event
 * is what the position-indexer uses to advance the `settled_weeks`
 * cursor on the leaderboard; calling the bare `pool::withdraw_settled`
 * bypasses the indexer path entirely, so a settled week would never
 * mark `claimed=true` for the matching off-chain leaderboard row.
 *
 * @param marketId         - `PredictionMarket<Q>` object id
 * @param poolId           - DeepBook `Pool<YES<Q>, Q>` object id (the
 *                           market stores this in `pool_id`; the UI
 *                           can read it via `getMarket`)
 * @param balanceManagerId - user's `BalanceManager` for this market
 */
export function buildMarketWithdrawSettledTx(
  marketId: string,
  poolId: string,
  balanceManagerId: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::withdraw_settled`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(marketId)),
      tx.object(normalizeObjectId(poolId)),
      tx.object(normalizeObjectId(balanceManagerId)),
    ],
  });
  return tx;
}

// ─── Market-order / cancel / deposit wrappers ───────────────────────────────
//
// The on-chain entry points below all require both the `PredictionMarket<Q>`
// shared object AND the underlying DeepBook `Pool<YES<Q>, Q>` plus the
// user's `BalanceManager`. The market object carries `pool_id` and
// `balance_manager_id` after `create_market`, so the caller can pass them
// in directly. They are intentionally separate parameters (not folded
// into a client) because these wrappers sit on the prediction-market
// side of the boundary, not the DeepBook-client side; the market object
// is required for `EMarketNotActive` and the dispute-window checks.

// ─── Market-order entry ─────────────────────────────────────────────────────

/**
 * Build `place_market_order` transaction. Submits a taker order that
 * sweeps the book at the best available price (DeepBook's place_market_order).
 * Aborts with `EInvalidQuantity` if quantity == 0, `EMarketNotActive`
 * if the market is resolved or disputed.
 *
 * @param marketId         - PredictionMarket<Q> object ID
 * @param poolId           - DeepBook Pool<YES<Q>, Q> object ID
 * @param balanceManagerId - User's BalanceManager object ID
 * @param clientOrderId    - User-chosen order id (typically a monotonic counter)
 * @param quantity         - Base-asset quantity (YES * 10^decimals)
 * @param isBid            - true = buy YES with quote, false = sell YES for quote
 */
export function buildPlaceMarketOrderTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  clientOrderId: bigint;
  quantity: bigint;
  isBid: boolean;
}): Transaction {
  // R53 audit fix: validate
  // `quantity` at the build
  // boundary so a stuck
  // `Math.max(0, ...)` calc
  // doesn't burn gas on a
  // doomed PTB. The on-chain
  // `place_market_order`
  // asserts `quantity > 0`
  // and aborts with
  // `EInvalidQuantity` (code
  // 9) for 0/negative.
  if (params.quantity <= 0n) {
    throw new Error(
      `buildPlaceMarketOrderTx: quantity must be > 0, got ${params.quantity}`,
    );
  }
  if (params.clientOrderId < 0n) {
    throw new Error(
      `buildPlaceMarketOrderTx: clientOrderId must be >= 0, got ${params.clientOrderId}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::place_market_order`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.poolId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.pure.u64(params.clientOrderId),
      tx.pure.u64(params.quantity),
      tx.pure.bool(params.isBid),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `place_order` transaction — the limit-order counterpart to
 * `buildPlaceMarketOrderTx`. Routes through the prediction_market
 * wrapper that emits `OrderPlacedEvent { market_id, pool_id, ... }`,
 * which the position-indexer observes to advance the `settled_weeks`
 * cursor and to surface the order in the user's portfolio.
 *
 * R50 audit fix: this wrapper did not exist. The only
 * limit-order builder was `buildDeepBookPlaceLimitOrderTx`
 * (`deepbook/client.ts:165`) which calls DeepBook's
 * `pool::place_limit_order` directly, bypassing the
 * wrapper's `OrderPlacedEvent` carrying `market_id` — the
 * position-indexer relies on this event to advance the
 * `settled_weeks` cursor. The wrapper was dead in both
 * directions: not exposed by the SDK, and the web's
 * `placeOrder` button could only call the DeepBook-direct
 * path. The fix adds the wrapper, exports it from the
 * barrel, and re-points the web's `placeOrder` to use it
 * (see `apps/web/app/markets/[id]/page.tsx`).
 *
 * `orderType` is the DeepBook `OrderType` u8: 0=POST_ONLY,
 * 1=FOK, 2=IOC, 3=GFT (default). The on-chain module
 * asserts `is_bid` xor `is_ask` semantics via DeepBook's
 * own check; the wrapper only requires a non-zero
 * price/quantity (the on-chain assert is `price > 0,
 * quantity > 0`, matching `EMarketNotActive` /
 * `EInvalidPrice` / `EInvalidQuantity`).
 */
export function buildPlaceOrderTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  clientOrderId: bigint;
  /**
   * Price in *quote units* (e.g. `500_000_000n` = 0.5 DUSDC).
   * The on-chain module's docstring at
   * `prediction_market.move:737` calls this out:
   * "Price in quote units (e.g. 500_000_000 = 0.5 Q)".
   * Callers passing a human-readable price (0.01..0.99)
   * should multiply by 1e9 — see `QUOTE_SCALE` below.
   */
  price: bigint;
  quantity: bigint;
  isBid: boolean;
  orderType?: number;
}): Transaction {
  // R53 audit fix: validate
  // `price` and `quantity` at the
  // build boundary. The on-chain
  // `place_order` asserts
  // `price > 0` (`EInvalidPrice`
  // code 8) and
  // `quantity > 0`
  // (`EInvalidQuantity` code 9);
  // a 0 value burns gas on a
  // guaranteed-abort PTB and a
  // price=0 limit order would
  // silently post a 0-bid ask
  // (no fills, market-maker
  // confusion).
  if (params.price <= 0n) {
    throw new Error(
      `buildPlaceOrderTx: price must be > 0, got ${params.price}`,
    );
  }
  if (params.quantity <= 0n) {
    throw new Error(
      `buildPlaceOrderTx: quantity must be > 0, got ${params.quantity}`,
    );
  }
  if (params.clientOrderId < 0n) {
    throw new Error(
      `buildPlaceOrderTx: clientOrderId must be >= 0, got ${params.clientOrderId}`,
    );
  }
  // R54 audit fix: also cap `clientOrderId` at u64::MAX. The
  // on-chain `place_order` signature is `client_order_id: u64`; a
  // larger value would silently wrap (BCS encoder for u128→u64)
  // and could collide with a previously-issued order id, producing
  // a confusing "duplicate" abort downstream.
  if (params.clientOrderId > 0xFFFFFFFFFFFFFFFFn) {
    throw new Error(
      `buildPlaceOrderTx: clientOrderId must fit in u64 (got ${params.clientOrderId})`,
    );
  }
  // R53 audit fix: bound the
  // optional `orderType` to the
  // DeepBook enum (0..3). A
  // mis-binding to an out-of-range
  // u8 (e.g. a stale "4" from a
  // future DeepBook bump) would
  // build a valid PTB and submit
  // an obscure DeepBook abort.
  if (
    params.orderType !== undefined &&
    (params.orderType < 0 || params.orderType > 3)
  ) {
    throw new Error(
      `buildPlaceOrderTx: orderType must be in [0, 3], got ${params.orderType}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::place_order`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.poolId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.pure.u64(params.clientOrderId),
      tx.pure.u64(params.price),
      tx.pure.u64(params.quantity),
      tx.pure.bool(params.isBid),
      // DeepBook OrderType u8. Default to 3 (GFT) so a
      // misclick doesn't issue a POST_ONLY (0) that
      // would silently drop the order in a thin book.
      tx.pure.u8(params.orderType ?? 3),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * The on-chain wrapper's price is in 1e9-scaled quote
 * units (dUSDC has 6 decimals, so the wrapper multiplies
 * 1e3 to round-trip to a fixed-point representation that
 * matches DeepBook's expected `u64` ticks). Export the
 * constant so web callers passing a 0..1 dollar price can
 * do `BigInt(Math.round(price * QUOTE_SCALE))` without
 * hardcoding the magic number.
 */
export const QUOTE_SCALE = 1_000_000_000n;

// ─── Cancel wrappers ────────────────────────────────────────────────────────

/**
 * Build `cancel_order` transaction. Cancels a single open order by its
 * DeepBook-assigned `order_id`. Aborts with `EMarketNotActive` if the
 * market is resolved.
 */
export function buildCancelOrderTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  orderId: bigint;
}): Transaction {
  // R54 audit fix: validate `orderId > 0` at the build boundary.
  // The on-chain `prediction_market::cancel_order` does not check
  // for `order_id == 0`; a typo / wrong-endian / negative value
  // produces a guaranteed-abort PTB that surfaces as an opaque
  // DeepBook abort. Mirror the R53 `buildPlaceMarketOrderTx`
  // guard. Also reject values larger than u128::MAX (BCS would
  // silently wrap otherwise).
  if (params.orderId <= 0n) {
    throw new Error(
      `buildCancelOrderTx: orderId must be > 0 (got ${params.orderId})`,
    );
  }
  if (params.orderId > 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn) {
    throw new Error(
      `buildCancelOrderTx: orderId must fit in u128 (got ${params.orderId})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_order`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.poolId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.pure.u128(params.orderId),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `cancel_orders` transaction. Batch-cancels a set of open orders.
 * Each `orderId` is a u128 as DeepBook assigns them. The on-chain
 * `cancel_live_orders` is the underlying call; the event is
 * `OrdersBatchCancelledEvent` (one per tx, not one per order).
 */
export function buildCancelOrdersTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  orderIds: bigint[];
}): Transaction {
  // R54 audit fix: refuse an empty `orderIds` array at the build
  // boundary. The on-chain `cancel_live_orders` accepts the empty
  // vector (and emits an `OrdersBatchCancelledEvent { order_ids:
  // [] }`), which the position-indexer observes and either no-ops
  // or writes a zero-row to the `orders` table. The "cancel
  // everything" use case has its own builder
  // (`buildCancelAllOrdersTx`); an empty `orderIds` is always a
  // caller bug.
  if (params.orderIds.length === 0) {
    throw new Error(
      "buildCancelOrdersTx: orderIds must be non-empty; use buildCancelAllOrdersTx for that",
    );
  }
  for (const id of params.orderIds) {
    if (id <= 0n || id > 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn) {
      throw new Error(
        `buildCancelOrdersTx: every orderId must be in [1, u128::MAX] (got ${id})`,
      );
    }
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_orders`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.poolId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.pure.vector("u128", params.orderIds),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build `cancel_all_orders` transaction. Cancels every open order for
 * this `BalanceManager` on the market's DeepBook pool. The on-chain
 * function does not emit a batch event; the position-indexer observes
 * the per-order `OrderCancelledEvent` (zero or more) that follow.
 */
export function buildCancelAllOrdersTx(params: {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::cancel_all_orders`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.poolId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

// ─── BalanceManager top-up ──────────────────────────────────────────────────

/**
 * Build `deposit_for_trading` transaction. Deposits `Coin<YES<Q>>`,
 * `Coin<Q>`, and `Coin<DEEP>` into the user's `BalanceManager` so they
 * can place orders on the DeepBook pool. The three deposits are atomic
 * (one tx) — the on-chain function aborts if any coin is missing.
 *
 * All three coin IDs are required; pre-validation is the caller's
 * responsibility (e.g. resolve them from the user's Coin list first).
 *
 * @param marketId         - PredictionMarket<Q> object ID (referenced
 *                           for symmetry with on-chain signature; the
 *                           on-chain `_market` is unused — deposits go
 *                           straight into the BalanceManager)
 * @param balanceManagerId - User's BalanceManager object ID
 * @param baseCoinId       - Coin<YES<DUSDC>> (held for ask orders)
 * @param quoteCoinId      - Coin<DUSDC> (held for bid orders)
 * @param deepCoinId       - Coin<DEEP> (held for fee rebates)
 */
export function buildDepositForTradingTx(params: {
  marketId: string;
  balanceManagerId: string;
  baseCoinId: string;
  quoteCoinId: string;
  deepCoinId: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::deposit_for_trading`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(normalizeObjectId(params.marketId)),
      tx.object(normalizeObjectId(params.balanceManagerId)),
      tx.object(normalizeObjectId(params.baseCoinId)),
      tx.object(normalizeObjectId(params.quoteCoinId)),
      tx.object(normalizeObjectId(params.deepCoinId)),
    ],
  });
  return tx;
}

// ─── DeepBook client factory ─────────────────────────────────────────────────

/**
 * Create a DeepBook client configured for a specific prediction market pool.
 *
 * @param client      - SuiClient
 * @param address     - User's Sui address
 * @param poolId      - DeepBook Pool ID (from MarketInfo.deepbook_pool_id)
 * @param poolKey     - Pool key string (e.g. "market_abc12345" or PREDICT_DEEPBOOK_POOL_KEY)
 * @param balanceManagerId - Optional BalanceManager ID for trading
 */
export function createMarketDeepBookClient(
  client: SuiClient,
  address: string,
  poolId: string,
  poolKey: string = PREDICT_DEEPBOOK_POOL_KEY,
  balanceManagerId?: string,
) {
  const marketConfig: PredictionDeepBookMarketConfig = {
    poolKey,
    poolId,
    baseCoinType: yesCoinType(),
    quoteCoinType: DUSDC_TYPE,
    baseScalar: 1_000_000,
    quoteScalar: 1_000_000,
  };

  return createPredictionDeepBookClient({
    client,
    address,
    balanceManagerId: balanceManagerId ?? null,
    market: marketConfig,
  });
}

// ─── Vault builders ───────────────────────────────────────────────────────────

/**
 * Build `vault::deposit` transaction. Deposits `Coin<QuoteCoin>` into the
 * `ProtocolVault<QuoteCoin>` and returns a freshly-minted `Coin<VLP>` to
 * the caller. Use `buildVaultWithdrawTx` to redeem.
 *
 * @param vaultId     - ProtocolVault<QuoteCoin> object ID
 * @param coinId      - Object ID of a Coin<QuoteCoin> with amount > 0
 * @param quoteType   - The quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 * @param recipient   - Address to receive the VLP coin (defaults to tx sender)
 */
export function buildVaultDepositTx(
  vaultId: string,
  coinId: string,
  amountAtoms: number | bigint,
  quoteType: string = DUSDC_TYPE,
  recipient?: string,
): Transaction {
  // R38 audit fix: the on-chain `vault::deposit` takes a
  // `Coin<QuoteCoin>` BY VALUE and absorbs the entire balance
  // into the vault. The previous builder passed `tx.object(normalizeObjectId(coinId))`
  // directly, which would have drained the user's full deposit
  // coin. Split `amountAtoms` off the source coin in-PTB and pass
  // the split result, matching the R36 parlay::create_parlay fix.
  const amount = BigInt(amountAtoms);
  if (amount <= 0n) {
    throw new Error(
      `buildVaultDepositTx: amountAtoms must be > 0 (got ${amountAtoms})`,
    );
  }
  // R53 audit fix: validate the
  // optional `recipient` is a
  // well-formed Sui address. The
  // on-chain `transferObjects`
  // accepts any 32-byte string
  // without checking, so a typo
  // (e.g. an Enoki zkLogin
  // address picked up
  // mixed-case) or a deliberate
  // wrong recipient silently
  // transfers the freshly-minted
  // VLP coin to a non-existent
  // address — permanently
  // losing the principal. The
  // sibling builders
  // (`buildParlayAdminWithdrawTx`,
  // `buildAllocateForMmTx`)
  // hardcode `@{sender}`, so
  // this is the only builder
  // that takes a custom
  // recipient.
  if (recipient !== undefined && recipient !== "@{sender}") {
    if (!isValidSuiAddress(recipient)) {
      throw new Error(
        `buildVaultDepositTx: recipient is not a valid Sui address (got ${recipient.slice(0, 16)}...)`,
      );
    }
  }
  const tx = new Transaction();
  const [depositCoin] = tx.splitCoins(tx.object(normalizeObjectId(coinId)), [
    tx.pure.u64(amount),
  ]);
  const vlp = tx.moveCall({
    target: `${PKG()}::vault::deposit`,
    typeArguments: [quoteType],
    arguments: [tx.object(normalizeObjectId(vaultId)), tx.object(depositCoin)],
  });
  tx.transferObjects([vlp], tx.pure.address(recipient ?? "@{sender}"));
  return tx;
}

/**
 * Build `vault::withdraw` transaction. Burns a `Coin<VLP>` and returns
 * `Coin<QuoteCoin>` to the caller. Withdraw is bounded by
 * `available_balance` (i.e. excludes the `allocated` reserve).
 */
export function buildVaultWithdrawTx(
  vaultId: string,
  vlpCoinId: string,
  quoteType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  const out = tx.moveCall({
    target: `${PKG()}::vault::withdraw`,
    typeArguments: [quoteType],
    arguments: [tx.object(normalizeObjectId(vaultId)), tx.object(vlpCoinId)],
  });
  tx.transferObjects([out], tx.pure.address("@{sender}"));
  return tx;
}

/**
 * Build `vault::create_vault` transaction. Consumes a
 * `TreasuryCap<VLP>` and produces a shared `ProtocolVault<QuoteCoin>`.
 * The TreasuryCap is destroyed by this call — there is no
 * post-creation mint path, which is what makes the VLP supply
 * equal to the on-chain quote balance.
 *
 * Round-27 audit finding C1: the bootstrap script used to build this
 * PTB inline; this builder consolidates the call so the /admin
 * VaultAdminCard and the bootstrap can share the same code path.
 *
 * @param vlpTreasuryCapId  - TreasuryCap<VLP> object ID (from the
 *                            VLP module's init, or `vlp::mint` for
 *                            self-hosted deployments)
 * @param quoteType         - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export function buildCreateVaultTx(
  vlpTreasuryCapId: string,
  quoteType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::vault::create_vault`,
    typeArguments: [quoteType],
    arguments: [tx.object(normalizeObjectId(vlpTreasuryCapId))],
  });
  return tx;
}

/**
 * Build `vault::allocate_for_mm` transaction. Moves `amount` of
 * `QuoteCoin` from the vault's available balance to its `allocated`
 * reserve and returns a `Coin<QuoteCoin>` for the market-maker to
 * deposit into a DeepBook balance manager. Admin-only.
 *
 * The on-chain guard is `amount <= available_balance` — callers
 * should pre-flight against the live `available` read to avoid
 * paying gas for a tx that will revert with `EInsufficientAvailable`.
 *
 * @param vaultId    - ProtocolVault<QuoteCoin> object ID
 * @param amount     - Amount in base units of QuoteCoin
 * @param quoteType  - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export function buildAllocateForMmTx(
  vaultId: string,
  amount: bigint,
  quoteType: string = DUSDC_TYPE,
): Transaction {
  // R54 audit fix: validate `amount > 0` at the build boundary.
  // The on-chain `vault::allocate_for_mm` aborts with `EZeroAmount`
  // for `amount == 0`; a zero-value allocation is a guaranteed
  // abort that wastes gas.
  if (amount <= 0n) {
    throw new Error(
      `buildAllocateForMmTx: amount must be > 0 (got ${amount})`,
    );
  }
  const tx = new Transaction();
  const coin = tx.moveCall({
    target: `${PKG()}::vault::allocate_for_mm`,
    typeArguments: [quoteType],
    arguments: [tx.object(normalizeObjectId(vaultId)), tx.pure.u64(amount)],
  });
  // The Coin<QuoteCoin> is sent to the sender so the market-maker
  // can deposit it into the DeepBook balance manager in a follow-up
  // tx. Returning it to a specific address would require a recipient
  // param; the default (@{sender}) matches the existing market-maker
  // flow.
  tx.transferObjects([coin], tx.pure.address("@{sender}"));
  return tx;
}

/**
 * Build `vault::return_from_mm` transaction. Returns a
 * `Coin<QuoteCoin>` to the vault, decreasing the `allocated` reserve
 * and increasing `available_balance`. Admin-only.
 *
 * The on-chain guard is `coin::value(&coin) <= allocated` — callers
 * should pre-flight against the live `allocated` read to avoid
 * paying gas for a tx that will revert with `EInsufficientAvailable`.
 *
 * @param vaultId    - ProtocolVault<QuoteCoin> object ID
 * @param coinId     - Object ID of a Coin<QuoteCoin> returned from
 *                     a market-maker (must not be a balance manager
 *                     deposit — return it from the balance manager
 *                     first via `withdraw_settled` or DeepBook's
 *                     own withdraw)
 * @param quoteType  - Quote coin type (e.g. DUSDC_TYPE or DBUSDC_TYPE)
 */
export function buildReturnFromMmTx(
  vaultId: string,
  coinId: string,
  quoteType: string = DUSDC_TYPE,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::vault::return_from_mm`,
    typeArguments: [quoteType],
    arguments: [tx.object(normalizeObjectId(vaultId)), tx.object(normalizeObjectId(coinId))],
  });
  return tx;
}

// ─── Registry builders ────────────────────────────────────────────────────────

/**
 * Build `registry::create_registry` transaction. Anyone can call;
 * `ctx.sender()` becomes the registry admin.
 */
export function buildCreateRegistryTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::create_registry`,
    arguments: [],
  });
  return tx;
}

/**
 * Build `registry::register_market` transaction. Only the registry
 * admin may invoke. Typically called by the market creator after
 * each successful `create_market`.
 */
export function buildRegisterMarketTx(
  registryId: string,
  marketObjectId: string,
): Transaction {
  // R56.10 audit fix: reject `registryId === marketObjectId`.
  // The on-chain `registry::register_market` aborts with
  // `EMarketExists` (code 1 in registry.move) if the market id is
  // already in the registry, but a copy-paste of `registryId` for
  // `marketObjectId` is the canonical admin-script mistake. The
  // builder can't check "is this id already in the registry" at
  // build time without an RPC call, but it CAN catch the
  // copy-paste shape cheaply. Use the SDK's
  // `isMarketRegistered(client, registryId, marketId)` helper for
  // the existence check when an operator wants to pre-flight.
  if (normalizeObjectId(registryId) === normalizeObjectId(marketObjectId)) {
    throw new Error(
      "buildRegisterMarketTx: registryId and marketObjectId must differ; " +
        "a copy-paste of the same id is always a caller bug",
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::registry::register_market`,
    arguments: [tx.object(normalizeObjectId(registryId)), tx.pure.id(normalizeObjectId(marketObjectId))],
  });
  return tx;
}