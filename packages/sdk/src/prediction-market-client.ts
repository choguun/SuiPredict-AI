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
 *  R-UAT-23 follow-up: at module-init time, prefer the
 *  env-configurable `MARKET_PACKAGE_ID` over the
 *  `AGENT_POLICY_PACKAGE_ID` so a deploy can point the SDK
 *  at a *separate* `prediction_market` package (e.g. the
 *  historical `0x23b78ca…` that owns the on-chain YES<DUSDC>
 *  pool) rather than the co-located `agent_policy` package
 *  (0xb1777f…). Without this, every `buildCreateMarket*Tx`
 *  call would target a `prediction_market::YES<Q>` whose
 *  type is *different* from the YES type of the on-chain
 *  pool the bootstrap script shares, and Move's type
 *  system would reject the call with a "pool type
 *  mismatch" error. The previous `AGENT_POLICY_PACKAGE_ID`
 *  default is preserved as a fallback for older deploys
 *  where the two packages were the same.
 *
 *  Override at deploy time via `NEXT_PUBLIC_MARKET_PACKAGE_ID`
 *  (Next.js) or `MARKET_PACKAGE_ID` (server/agents).
 */
export const PREDICT_MARKET_PACKAGE_ID =
  (process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
    process.env.MARKET_PACKAGE_ID ??
    AGENT_POLICY_PACKAGE_ID).trim();

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
 * R-UAT-23 fix: build `create_market_with_pool` transaction.
 *
 * Alternative entry point that reuses an already-existing DeepBook
 * pool instead of creating a new one. The standard
 * `buildCreateMarketTx` calls `pool::create_permissionless_pool`,
 * which aborts with `EPoolAlreadyExists` (code 1) when a
 * YES<DUSDC> pool is already in the registry — which is the
 * case on the self-hosted DeepBook after the first market is
 * created. This builder wraps `create_market_with_pool`:
 * - Skips pool creation (no 500 DEEP fee required)
 * - Skips the deepbook_registry argument (not needed)
 * - Takes a `&mut Pool<YES<Q>, Q>` reference instead
 * - Otherwise identical signature: creates BalanceManager +
 *   YES/NO TreasuryCaps + PredictionMarket in one PTB
 *
 * Use case: `apps/agents/scripts/bootstrap-wc-markets.mjs` first
 * attempts `buildCreateMarketTx`; on `EPoolAlreadyExists` it
 * looks up the existing pool by base/quote TypeName and calls
 * this builder instead. Multiple markets can share the same
 * DeepBook pool (different YES/NO TreasuryCaps per market),
 * which is the canonical Polymarket-style design.
 *
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs        - Unix timestamp (ms) when
 *                                 resolution becomes allowed
 * @param params.poolId          - Object ID of the existing
 *                                 Pool<YES<Q>, Q>
 * @param params.category        - Off-chain topic code (0..3)
 */
export function buildCreateMarketWithPoolTx(params: {
  title: string;
  resolutionSource: string;
  expiryMs: bigint;
  poolId: string;
  category?: number;
}): Transaction {
  // R62 audit fixes (mirrored from buildCreateMarketTx):
  // validate `expiryMs` is a future bigint, title and
  // resolution source are non-empty, and the poolId is a
  // valid Sui object id. The on-chain
  // `create_market_with_pool<Q>(coin_registry, pool, ...)`
  // does NOT validate the title / resolution-source
  // lengths on-chain (the `vector<u8>` is unbounded), so
  // enforcing 256 / 1024-byte caps client-side keeps
  // event payloads bounded.
  if (!params.poolId) {
    throw new Error("buildCreateMarketWithPoolTx: poolId is required");
  }
  if (typeof params.expiryMs !== "bigint") {
    throw new Error(
      `buildCreateMarketWithPoolTx: expiryMs must be bigint, got ${typeof params.expiryMs}`,
    );
  }
  if (params.expiryMs <= 0n) {
    throw new Error(
      `buildCreateMarketWithPoolTx: expiryMs must be > 0 (got ${params.expiryMs})`,
    );
  }
  if (params.expiryMs <= BigInt(Date.now())) {
    throw new Error(
      `buildCreateMarketWithPoolTx: expiryMs must be in the future ` +
        `(got ${params.expiryMs}, now=${BigInt(Date.now())})`,
    );
  }
  const MAX_TITLE_BYTES = 256;
  const MAX_RESOLUTION_SOURCE_BYTES = 1024;
  if (!params.title || !params.title.trim()) {
    throw new Error("buildCreateMarketWithPoolTx: title is required");
  }
  const titleBytes = encodeUtf8(params.title).length;
  if (titleBytes > MAX_TITLE_BYTES) {
    throw new Error(
      `buildCreateMarketWithPoolTx: title length ${titleBytes} bytes exceeds ${MAX_TITLE_BYTES} (max)`,
    );
  }
  if (!params.resolutionSource || !params.resolutionSource.trim()) {
    throw new Error("buildCreateMarketWithPoolTx: resolutionSource is required");
  }
  const resBytes = encodeUtf8(params.resolutionSource).length;
  if (resBytes > MAX_RESOLUTION_SOURCE_BYTES) {
    throw new Error(
      `buildCreateMarketWithPoolTx: resolutionSource length ${resBytes} bytes exceeds ${MAX_RESOLUTION_SOURCE_BYTES} (max)`,
    );
  }
  // R52 audit fix: clamp `category` to [0, 3] like
  // buildCreateMarketTx.
  const category = params.category ?? 0;
  if (!Number.isInteger(category) || category < 0 || category > 3) {
    throw new Error(
      `buildCreateMarketWithPoolTx: category must be 0..3, got ${category}`,
    );
  }
  // Sui's system CoinRegistry is at the well-known
  // address `0xc`. The on-chain
  // `create_market_with_pool<Q>(coin_registry, pool, ...)`
  // uses the registry only to call
  // `coin_registry::new_currency` for the YES/NO coin
  // types; the registry is shared with the system.
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::prediction_market::create_market_with_pool`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object("0xc"),  // Sui system CoinRegistry
      tx.object(normalizeObjectId(params.poolId)),
      tx.pure.vector("u8", encodeUtf8(params.title)),
      tx.pure.vector("u8", encodeUtf8(params.resolutionSource)),
      tx.pure.u64(params.expiryMs),
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
  // R-UAT-23 follow-up: pre-flight the
  // `marketId` against the Sui object-id
  // shape (`0x` + 64 hex chars) so a caller
  // that passes a SQLite-mirror primary key
  // (e.g. `wc26-A1v4` for a World Cup
  // market that has no on-chain market id)
  // gets a friendly error rather than the
  // raw `normalizeObjectId` throw deep in
  // the SDK. The caller is then expected to
  // surface this error in the UI as a toast.
  // The pre-flight is intentionally lenient
  // (regex match, not a full BCS decode) —
  // a `0x` + 32-byte hex string is the only
  // shape the on-chain PTB will accept, and
  // matching it here catches the SQLite
  // namespace without an extra network call.
  if (!/^0x[0-9a-fA-F]{64}$/.test(marketId)) {
    throw new Error(
      `buildMintSharesTx: marketId "${marketId}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "This usually means the market has no on-chain market id (it's a SQLite-mirror demo row, e.g. a `wc26-*` World Cup market). " +
        "Minting requires a published on-chain market; use `getMarket(id).onchain_market_id` to check before calling.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(vaultId)) {
    throw new Error(
      `buildMintSharesTx: vaultId "${vaultId}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "Check NEXT_PUBLIC_FEE_VAULT_ID is set in the web bundle and matches the agents runtime's FEE_VAULT_ID.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(quoteIn)) {
    throw new Error(
      `buildMintSharesTx: quoteIn "${quoteIn}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "Check that the DUSDC coin object id returned by `listCoins` is a real on-chain coin.",
    );
  }
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
  /**
   * Optional market status pre-flight. If supplied, the
   * builder throws a clear error for non-`active` markets
   * rather than letting the PTB abort on-chain with the
   * opaque `EMarketNotActive` (code 1). The web markets/[id]
   * page already pre-flights the same condition in the
   * form-level `disabled` check, so this is a defense-in-depth
   * for SDK callers (agents, scripts, programmatic users).
   *
   * E2E-GAP-03 fix.
   */
  marketStatus?: string;
}): Transaction {
  // E2E-GAP-03 fix: pre-flight market
  // status. The on-chain `place_order`
  // aborts with `EMarketNotActive`
  // (code 1) when `market.status !==
  // "active"`; a programmatic caller
  // (SDK script, agent) that doesn't
  // pre-flight would burn gas on a
  // guaranteed-abort PTB with a
  // cryptic on-chain message. The
  // web markets/[id] page already
  // gates the Buy button on the
  // same condition; this builder
  // check is the SDK-level mirror
  // so SDK consumers get the same
  // fast-fail behaviour. Skip the
  // check when `marketStatus` is
  // `undefined` (the caller's
  // choice — some agents may want
  // to pre-flight elsewhere).
  if (params.marketStatus !== undefined && params.marketStatus !== "active") {
    throw new Error(
      `buildPlaceOrderTx: market is ${params.marketStatus}, cannot place order`,
    );
  }
  // R-UAT-23 follow-up: same
  // Sui-id pre-flight as
  // `buildMintSharesTx`. A
  // SQLite-mirror `wc26-*`
  // market id would otherwise
  // reach `normalizeObjectId`
  // and throw the raw
  // `is not a valid Sui object id`
  // message deep in the SDK.
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.marketId)) {
    throw new Error(
      `buildPlaceOrderTx: marketId "${params.marketId}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "Use `getMarket(id).onchain_market_id` to get the on-chain market id (the SQLite primary key may be a `wc26-*` namespace, not a Sui id).",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.poolId)) {
    throw new Error(
      `buildPlaceOrderTx: poolId "${params.poolId}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "The market has no DeepBook pool (it's a SQLite-mirror demo row). Limit orders require a real on-chain pool.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(params.balanceManagerId)) {
    throw new Error(
      `buildPlaceOrderTx: balanceManagerId "${params.balanceManagerId}" is not a valid Sui object id (expected 0x + 64 hex chars). ` +
        "Check that `BALANCE_MANAGER_ID` (or the per-route env) is set to a real on-chain BalanceManager.",
    );
  }
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

// ─── Per-market on-chain market lifecycle helpers ─────────────────────────

/**
 * R-WC-1 fix: find an existing `Pool<YES<Q>, Q>` in the
 * DeepBook registry, if any. Used to bootstrap N markets
 * that all share one DeepBook pool (the design the
 * `world-cup-creator` now uses after the R-WC-1 refactor).
 *
 * Walks the registry's dynamic fields and returns the
 * first pool whose `BaseType` matches `<PKG>::prediction_market::YES<Q>`.
 *
 * @param client              - Sui client
 * @param deepbookRegistryId  - DeepBook `Registry` object id
 * @param marketPackageId     - The published prediction_market package
 *                              (defaults to the SDK's resolved PKG)
 * @param quoteType           - Quote coin Q (defaults to DUSDC_TYPE)
 * @returns Pool object id, or null if no YES<Q>/Q pool exists yet
 */
export async function findExistingYesPool(
  client: SuiClient,
  deepbookRegistryId: string,
  marketPackageId: string = PREDICT_MARKET_PACKAGE_ID,
  quoteType: string = DUSDC_TYPE,
): Promise<string | null> {
  // The dynamic-field name for a Pool<YES<Q>, Q> in the
  // DeepBook registry serialises as a `TypeName` struct
  // with `name: string` (the fully-qualified Move type
  // name). We can't query by name directly because the
  // gRPC dynamic-field filter is dynamic-field-key
  // typed, not by string match; instead, we iterate the
  // registry's dynamic fields and pick the one whose
  // rendered `name` starts with our expected prefix.
  //
  // The SuiGrpcClient exposes the dynamic-fields API
  // at `client.core.getDynamicFields` (not on the top-
  // level `client`). The legacy JSON-RPC client has
  // `client.getDynamicFields` directly; the gRPC client
  // has it on `core`. We prefer `core.getDynamicFields`
  // (the gRPC path) and fall back to the top-level
  // call for older fullnodes.
  //
  // Limit: 50 dynamic fields is enough for a single
  // registry — the DeepBook registry on testnet has at
  // most a handful of pools. If a deploy ever exceeds
  // 50, paginate via `cursor`.
  const expectedPrefix = `${marketPackageId}::prediction_market::YES<`;
  // The rendered pool key looks like
  //   "<pkg>::prediction_market::YES<0x…::dusdc::DUSDC>, 0x…::dusdc::DUSDC>"
  // The base-type `<0x…::dusdc::DUSDC>` part ends with `>`
  // (after the closing `>` of the `YES<…>` type), and the
  // rendered TypeName for `DUSDC` itself is just
  // `0x…::dusdc::DUSDC` (no `::` prefix — the package id
  // is part of the TypeName string, not a separate
  // segment). So the matching substring is
  // `${quoteType}>` (closing `>` after the DUSDC type
  // name), not `::${quoteType}>`.
  const expectedSuffix = `${quoteType}>`;
  // R-WC-1 fix: `SuiGrpcClient.listDynamicFields` is a
  // SDK wrapper around the raw gRPC
  // `StateService.ListDynamicFields` call. The
  // wrapper:
  //   1. Renames `parent` → `parentId`, `page_size` →
  //      `limit`, `page_token` → `cursor` (cursor is
  //      base64-encoded so consumers don't have to
  //      handle raw protobuf bytes).
  //   2. Normalizes the response from
  //      `dynamicFields: Bcs[]` to
  //      `dynamicFields: { fieldId, name: { type, bcs }, valueType, type, childId, value }[]`.
  //      The `name.type` is the Move type name
  //      ("TypeName") and `name.bcs` is the
  //      BCS-encoded `TypeName` struct. The struct is
  //      `{ name: String }`, so the BCS is
  //      ULEB128-encoded length + UTF-8 bytes.
  //   3. Computes `hasNextPage` from the presence
  //      of a `nextPageToken`.
  //
  // We prefer the wrapper over the raw gRPC client
  // (which lives at `client.stateService.listDynamicFields`
  // and returns the protobuf `Bcs` shape with the
  // bytes still inside `name.value`). The legacy
  // JSON-RPC client returns
  // `{ data: [{ objectId, name: { name: "TypeName" } }] }`
  // (no `bcs`/`value`) — an older fullnode that
  // hasn't migrated to the v2 gRPC API; we detect it
  // by the presence of `objectId` instead of `fieldId`.
  const g = client as SuiClient & {
    listDynamicFields?: (args: {
      parentId: string;
      limit?: number;
      cursor?: string | null;
    }) => Promise<{
      hasNextPage: boolean;
      cursor: string | null;
      dynamicFields: Array<{
        fieldId: string;
        name: { type: string; bcs: Uint8Array };
        valueType: string;
        type: string;
        childId?: string;
      }>;
    }>;
    getDynamicFields?: (args: {
      parentId: string;
      limit?: number;
      cursor?: string | null;
    }) => Promise<{
      data: Array<{ objectId: string; name?: unknown }>;
      hasNextPage: boolean;
      nextCursor?: string | null;
    }>;
  };
  type ResolvedRow = { id: string; typename?: string };
  // Decode a `Bcs` containing a Move `TypeName` struct
  // (which is just a wrapper around a `String`). The
  // struct is
  // `struct TypeName has copy, drop, store { name: String }`
  // so the BCS is: ULEB128 length + UTF-8 bytes.
  // Rather than depend on `@mysten/bcs` (a transitive
  // dep of `@mysten/sui` that isn't exposed via the
  // Sui SDK's public exports), we use a small inline
  // ULEB128 + String decoder. The Move String BCS
  // encoding is documented at
  // https://github.com/MystenLabs/sui/blob/main/external-crates/move/crates/move-binary-format/src/file_format_common.rs
  // and is just "vector<u8>" — ULEB128 length + raw
  // bytes. The TypeName struct is a wrapper, so the
  // bytes are a single String field.
  const decodeTypeNameBcs = (bytes: Uint8Array): string => {
    if (bytes.length === 0) {
      throw new Error("decodeTypeNameBcs: empty BCS buffer");
    }
    // Read the ULEB128 length prefix. Move's String
    // stores a `u64` length but the BCS serializer
    // emits a ULEB128; the `String` Move type's
    // max length is `u64::MAX` so the ULEB128 can
    // span up to 10 bytes for the full u64 range.
    let length = 0;
    let shift = 0;
    let offset = 0;
    while (true) {
      if (offset >= bytes.length) {
        throw new Error("decodeTypeNameBcs: truncated ULEB128 length");
      }
      const byte = bytes[offset++]!;
      length |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) {
        throw new Error("decodeTypeNameBcs: ULEB128 length overflows u64");
      }
    }
    // The remaining bytes after the ULEB128 are the
    // UTF-8 string content.
    if (offset + length > bytes.length) {
      throw new Error(
        `decodeTypeNameBcs: truncated String (declared length ${length}, ` +
          `remaining bytes ${bytes.length - offset})`,
      );
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.slice(offset, offset + length),
    );
  };
  // Resolve the dynamic field id + the rendered
  // TypeName string from either the SDK-wrapper
  // shape (`name: { type, bcs }`) or the legacy
  // JSON-RPC shape (`name: { name: "TypeName" }`).
  // The id field is `fieldId` on the new client
  // and `objectId` on the legacy client.
  const resolveIdAndName = (f: unknown): ResolvedRow | undefined => {
    if (typeof f !== "object" || f === null) return undefined;
    const o = f as Record<string, unknown>;
    const id =
      (typeof o["fieldId"] === "string" && o["fieldId"]) ||
      (typeof o["objectId"] === "string" && o["objectId"]) ||
      undefined;
    if (!id) return undefined;
    const name = o["name"];
    if (typeof name !== "object" || name === null) return { id, typename: undefined };
    const n = name as Record<string, unknown>;
    // SDK-wrapper shape: { type: "TypeName", bcs: Uint8Array }
    if (n["bcs"] instanceof Uint8Array) {
      const typeNameStr = n["type"];
      if (typeof typeNameStr === "string" && typeNameStr === "TypeName") {
        try {
          const rendered = decodeTypeNameBcs(n["bcs"]);
          return { id, typename: rendered };
        } catch {
          return { id, typename: undefined };
        }
      }
    }
    // Legacy JSON-RPC: name is an object with a `name`
    // field that's already the rendered TypeName
    // string (e.g. "<pkg>::prediction_market::YES<…>").
    if (typeof n["name"] === "string") {
      return { id, typename: n["name"] };
    }
    return { id, typename: undefined };
  };
  // R-WC-1 fix: paginate the dynamic-field walk so
  // a DeepBook registry with > 50 pools (a busy
  // mainnet deployment) doesn't get truncated at
  // the first 50 rows. The SDK wrapper's
  // `hasNextPage: boolean` + `cursor: string | null`
  // shape is the unified pagination contract (the
  // legacy client uses `nextCursor` instead of
  // `cursor` — both shapes are handled).
  let cursor: string | null = null;
  // Hard cap on total pages scanned to prevent a
  // runaway loop on a misbehaving fullnode. 1000
  // is plenty for any real DeepBook deployment
  // (testnet has 1, mainnet has < 100 today).
  const MAX_PAGES = 20;
  const PAGE_SIZE = 50;
  for (let page = 0; page < MAX_PAGES; page++) {
    let rows: unknown[] = [];
    let hasNextPage = false;
    let nextCursor: string | null = null;
    if (typeof g.listDynamicFields === "function") {
      const r: {
        dynamicFields: unknown[];
        hasNextPage: boolean;
        cursor: string | null;
      } = await g.listDynamicFields({
        parentId: deepbookRegistryId,
        limit: PAGE_SIZE,
        cursor: cursor ?? undefined,
      });
      rows = r.dynamicFields;
      hasNextPage = r.hasNextPage;
      nextCursor = r.cursor;
    } else if (typeof g.getDynamicFields === "function") {
      const r: {
        data: unknown[];
        hasNextPage: boolean;
        nextCursor?: string | null;
      } = await g.getDynamicFields({
        parentId: deepbookRegistryId,
        limit: PAGE_SIZE,
        cursor: cursor,
      });
      rows = r.data;
      hasNextPage = r.hasNextPage;
      nextCursor = r.nextCursor ?? null;
    } else {
      throw new Error(
        "findExistingYesPool: client exposes neither listDynamicFields nor getDynamicFields",
      );
    }
    for (const f of rows) {
      const resolved = resolveIdAndName(f);
      if (
        resolved?.typename !== undefined &&
        resolved.typename.startsWith(expectedPrefix) &&
        resolved.typename.includes(expectedSuffix)
      ) {
        return resolved.id;
      }
    }
    if (!hasNextPage) return null;
    // Defensive: if the fullnode returns hasNextPage
    // but no cursor (null, undefined, or empty
    // string), bail out to avoid an infinite loop.
    if (!nextCursor) {
      throw new Error(
        "findExistingYesPool: fullnode returned hasNextPage=true without a cursor; " +
          "aborting pagination to avoid an infinite loop",
      );
    }
    cursor = nextCursor;
  }
  throw new Error(
    `findExistingYesPool: exceeded ${MAX_PAGES} pages of dynamic fields without finding a match ` +
      `(registry ${deepbookRegistryId}, expected prefix "${expectedPrefix}", suffix "${expectedSuffix}")`,
  );
}

/**
 * R-WC-1 fix: result of a successful market creation. The
 * `marketId` is the new on-chain `PredictionMarket<Q>`
 * object id; the `poolId` is the DeepBook pool the market
 * is bound to (created by `create_market` or reused from
 * the registry by `create_market_with_pool`); the
 * `balanceManagerId` is a fresh `BalanceManager` for this
 * market's trading.
 */
export interface CreatedMarket {
  marketId: string;
  poolId: string;
  balanceManagerId: string;
  /** "create_market" (new pool) or "create_market_with_pool"
   *  (reused pool). Operators can tell from the agent
   *  log which path was taken on each tick. */
  source: "create_market" | "create_market_with_pool";
}

/**
 * R-WC-1 fix: try `create_market` first, fall back to
 * `create_market_with_pool` on `EPoolAlreadyExists`. The
 * single entry point that the `world-cup-creator` (and
 * the operator's `bootstrap-wc-markets.mjs` script) use
 * to mint a per-market on-chain `PredictionMarket`. Replaces
 * the pre-fix "always `create_market`, catch the abort,
 * write a SQLite-only demo row" path that left 46 of 47
 * WC markets with no on-chain backing.
 *
 * **Why this exists (and not just a try/catch at the
 * call site):** the call site needs the *new* market id
 * and pool id regardless of which path was taken, and the
 * `create_market_with_pool` path requires a pool id at
 * PTB build time. Centralising the lookup + retry
 * keeps the agent code to a single `await` and
 * guarantees both paths are exercised in the same way
 * (idempotent, logged, with a single structured return
 * type for the agent's decision feed).
 *
 * **Wallet-funding gate:** the caller is responsible for
 * funding the wallet with enough SUI for gas + (on the
 * first market) 500 DEEP for the pool-creation fee. This
 * helper does NOT check the wallet balance — the agents
 * gate this themselves before calling, with a clear
 * operator-visible error if underfunded (see
 * `world-cup-creator.ts`).
 *
 * @param client            - Sui client
 * @param signer            - Agent keypair
 * @param deepbookRegistry  - DeepBook registry id (or null
 *                            if no registry configured)
 * @param params            - Market creation params
 * @param params.title            - Market question
 * @param params.resolutionSource - How the market resolves
 * @param params.expiryMs         - Unix ms when resolution allowed
 * @param params.category         - 0..3 topic code
 * @param params.deepCoinId       - Coin<DEEP> for the pool-creation
 *                                  fee (only consumed on the
 *                                  first market; subsequent
 *                                  markets don't touch it)
 * @param params.coinRegistry     - Sui system CoinRegistry id
 *                                  (defaults to "0xc")
 * @param params.tickSize         - Pool tick size (only on
 *                                  create_market path)
 * @param params.lotSize          - Pool lot size (only on
 *                                  create_market path)
 * @param params.minSize          - Pool min size (only on
 *                                  create_market path)
 */
export async function ensureMarketCreated(
  client: SuiClient,
  signer: Ed25519Keypair,
  deepbookRegistry: string | null,
  params: {
    title: string;
    resolutionSource: string;
    expiryMs: bigint;
    category?: number;
    deepCoinId: string;
    coinRegistry?: string;
    tickSize?: bigint;
    lotSize?: bigint;
    minSize?: bigint;
  },
): Promise<CreatedMarket> {
  // R-WC-1 fix: route both paths through the SDK's
  // `executeTransaction` helper, which already handles
  // `setSender` + `waitForTransaction` + transient-error
  // retry. The previous direct call to
  // `client.signAndExecuteTransaction` skipped the wait
  // and could return a digest for a tx that was still
  // propagating (the indexer would then `extractCreatedObjectId`
  // against an empty `effects` array).
  const { executeTransaction } = await import("./predict-client.js");
  // R-WC-1 fix: the `coinRegistry` is a Sui system
  // shared object at the well-known address `0xc`.
  // `create_market_with_pool` takes it as the first
  // argument (used to call `coin_registry::new_currency`
  // for the YES/NO TreasuryCaps). The `create_market`
  // path doesn't need it but doesn't error if it's
  // missing.
  const coinRegistry = params.coinRegistry ?? "0xc";
  // Try `create_market` first (it creates a new pool +
  // BalanceManager + market). The `tickSize` / `lotSize` /
  // `minSize` are required for the pool's first
  // registration; defaults match the world-cup-creator's
  // historical 1_000_000 (1 YES minimum) sizing.
  const tickSize = params.tickSize ?? 1_000_000n;
  const lotSize = params.lotSize ?? 1_000_000n;
  const minSize = params.minSize ?? 1_000_000n;

  if (deepbookRegistry) {
    try {
      const tx = buildCreateMarketTx({
        title: params.title,
        resolutionSource: params.resolutionSource,
        expiryMs: params.expiryMs,
        tickSize,
        lotSize,
        minSize,
        deepCoinId: params.deepCoinId,
        category: params.category ?? 0,
      });
      const result = await executeTransaction(client, tx, signer);
      const marketId = await extractCreatedObjectId(
        client,
        result.digest,
        "PredictionMarket",
      );
      if (marketId) {
        // Also extract the pool id and balance manager id
        // from the same effects. The shared object is
        // named `Pool<YES<Q>, Q>` on-chain; the
        // gRPC `objectChanges` array (when included)
        // lists every created object with its type
        // string. The first `Pool<YES<DUSDC>, DUSDC>` in
        // the array is the new market's pool.
        const poolId = await extractCreatedObjectId(
          client,
          result.digest,
          "Pool",
        );
        const balanceManagerId = await extractCreatedObjectId(
          client,
          result.digest,
          "BalanceManager",
        );
        if (poolId && balanceManagerId) {
          return {
            marketId,
            poolId,
            balanceManagerId,
            source: "create_market",
          };
        }
      }
      // Fall through to the `create_market_with_pool` path
      // if we couldn't extract ids (the Sui gRPC rendering
      // doesn't always carry them in the effects blob).
    } catch (err) {
      // Only swallow `EPoolAlreadyExists`. Re-throw any
      // other failure so the caller can react (e.g. low
      // SUI, missing DEEP, RPC outage).
      const msg = err instanceof Error ? err.message : String(err);
      const isPoolExists =
        /EPoolAlreadyExists/.test(msg) ||
        /register_pool.*abort code: 1/i.test(msg) ||
        (msg.includes("abort code: 1") && msg.includes("register_pool"));
      if (!isPoolExists) {
        throw err;
      }
      // Pool already exists — fall through to the
      // create_market_with_pool path.
    }
  }

  // Fallback path: find the existing YES<DUSDC> pool in the
  // registry, then call `create_market_with_pool`. The
  // caller MUST have set up `deepbookRegistry` for the
  // findExistingYesPool call to succeed.
  if (!deepbookRegistry) {
    throw new Error(
      "ensureMarketCreated: pool already exists but no deepbookRegistry configured; " +
        "set NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID and re-run. " +
        "The first market must use `create_market` (with a DEEP coin) to bootstrap the pool.",
    );
  }
  const existingPoolId = await findExistingYesPool(
    client,
    deepbookRegistry,
  );
  if (!existingPoolId) {
    throw new Error(
      "ensureMarketCreated: pool already exists (per abort) but findExistingYesPool " +
        `returned null. The DeepBook registry ${deepbookRegistry} may not actually ` +
        `contain a YES<DUSDC> pool. Inspect the registry's dynamic fields manually.`,
    );
  }
  const tx = buildCreateMarketWithPoolTx({
    title: params.title,
    resolutionSource: params.resolutionSource,
    expiryMs: params.expiryMs,
    poolId: existingPoolId,
    category: params.category ?? 0,
  });
  const result = await executeTransaction(client, tx, signer);
  // `create_market_with_pool` returns the same object shape
  // as `create_market` minus the `Pool` (it reuses the
  // existing one). The balanceManager is always fresh.
  const marketId = await extractCreatedObjectId(
    client,
    result.digest,
    "PredictionMarket",
  );
  if (!marketId) {
    throw new Error(
      `ensureMarketCreated: PredictionMarket object not found in effects (digest ${result.digest})`,
    );
  }
  const balanceManagerId = await extractCreatedObjectId(
    client,
    result.digest,
    "BalanceManager",
  );
  return {
    marketId,
    poolId: existingPoolId,
    balanceManagerId: balanceManagerId ?? "",
    source: "create_market_with_pool",
  };
}