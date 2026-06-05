/**
 * Parlay SDK — multi-leg parlay bets
 *
 * Wraps `parlay.move` (parlay module) functions:
 *   create_pool, fund_pool, create_parlay, record_leg, finalize_parlay
 *   rotate_admin, set_max_payout_bps, admin_withdraw
 *
 * A parlay is a single wager that resolves to "all win" or "any loss":
 * the user picks N market outcomes (YES/NO) and locks collateral
 * against a payout multiplier. If every leg resolves in the user's
 * favour the user receives `collateral * payout_bps / 10_000`, paid
 * out of a shared `ParlayPool<Q>`. If any leg loses, the collateral
 * is retained by the pool.
 *
 * The lifecycle is multi-step inside one PTB:
 *   1. `create_parlay` locks collateral and mints the `Parlay<Q>`.
 *   2. For each leg: `record_leg` reads the corresponding resolved
 *      market and stamps the leg as won / lost.
 *   3. `finalize_parlay` consumes the `Parlay<Q>` and pays out from
 *      the pool (or retains the collateral if any leg lost).
 */
import { Transaction } from "@mysten/sui/transactions";
import { TransactionObjectInput } from "@mysten/sui/transactions";
import { AGENT_POLICY_PACKAGE_ID, CLOCK_OBJECT_ID } from "./constants.js";
import { normalizeObjectId, isValidSuiAddress } from "./utils.js";
import type { SuiClient } from "./predict-client.js";
import { asBalance } from "./protocol-reads.js";

const PKG = () => AGENT_POLICY_PACKAGE_ID;
// Basis points denominator (10_000 = 100%). Mirrored from the
// on-chain `parlay::BPS` constant in the Move module. Used by the
// builder-time pre-checks (R49) so a typo surfaces here instead
// of as `EInvalidPayoutBps` inside the wallet spinner.
const BPS = 10_000;
// `parlay.move` accepts 2–5 legs per parlay. Hard-cap at the
// builder so a UI bug (or a future "add 10 legs" feature flag)
// can't ship a tx that aborts on `EInvalidLegCount`.
const MIN_LEGS = 2;
const MAX_LEGS = 5;

// ============================================================
// Pool admin
// ============================================================

/**
 * Build a PTB that calls `parlay::create_pool<Q>(max_payout_bps)`.
 * The new pool is shared. The deployer (caller) becomes the initial
 * admin; `rotate_admin` can hand off later.
 *
 * `max_payout_bps` is the cap on the per-parlay multiplier (e.g.
 * 50_000 = 5x). The on-chain check requires `>= BPS` (10_000).
 *
 * `coinType` is the generic `Q` (the collateral coin type, e.g.
 * `DUSDC_TYPE` for dUSDC). The Move function is generic over `Q`,
 * so the PTB must supply `typeArguments: [coinType]` or the
 * transaction will fail at signature with a type-argument-count
 * mismatch.
 */
export function buildCreateParlayPoolTx(
  maxPayoutBps: number | bigint,
  coinType: string,
): Transaction {
  // R49 audit fix: on-chain `parlay::create_pool` aborts with
  // `EInvalidPayoutBps` when `max_payout_bps < BPS` (10_000, the
  // breakeven multiplier). Catch the typo at the build boundary.
  const bps = BigInt(maxPayoutBps);
  if (bps < BigInt(BPS)) {
    throw new Error(
      `buildCreateParlayPoolTx: maxPayoutBps must be >= BPS (${BPS}), got ${maxPayoutBps}`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::create_pool`,
    typeArguments: [coinType],
    arguments: [tx.pure.u64(bps)],
  });
  return tx;
}

/**
 * Build a PTB that tops up an existing `ParlayPool<Q>`. Anyone can
 * call this — the function doesn't gate on admin. Useful for the
 * protocol seeding bot and partner donations.
 *
 * R38 audit fix: the on-chain `parlay::fund_pool<Q>` takes a
 * `Coin<Q>` BY VALUE and absorbs the entire balance into
 * `pool.pool_balance`. The previous builder passed
 * `tx.object(coinId)` directly, which would have drained the
 * user's full DUSDC balance. Split `amountAtoms` off the source
 * coin in-PTB and pass the split result, matching the R36
 * parlay::create_parlay fix.
 */
export function buildFundParlayPoolTx(
  poolId: string,
  coinId: string,
  amountAtoms: number | bigint,
  coinType: string,
): Transaction {
  const amount = BigInt(amountAtoms);
  if (amount <= 0n) {
    throw new Error(
      `buildFundParlayPoolTx: amountAtoms must be > 0 (got ${amountAtoms})`,
    );
  }
  const tx = new Transaction();
  // R45 audit fix: normalize the source coin id and pool id. The
  // R42 audit pass added `normalizeObjectId` to most builder
  // call sites but the parlay pool admin builders (fund_pool,
  // admin_withdraw, rotate_admin, set_max_payout_bps) were
  // survivors. A mixed-case or whitespace-suffixed id silently
  // fails with `invalid input object` at BCS resolution; the
  // drift detector on the web side doesn't catch this because
  // the agents runtime already stores normalized ids in
  // `process.env.PARLAY_POOL_ID`. Match the prize-client.ts
  // pattern.
  const [fundCoin] = tx.splitCoins(
    tx.object(normalizeObjectId(coinId)),
    [tx.pure.u64(amount)],
  );
  tx.moveCall({
    target: `${PKG()}::parlay::fund_pool`,
    typeArguments: [coinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.object(fundCoin)],
  });
  return tx;
}

/**
 * Build a PTB that withdraws `amount` from the pool. Admin only —
 * the on-chain check is `ctx.sender() == pool.admin`.
 *
 * R42 audit fix: the Move `parlay::admin_withdraw<Q>` returns a
 * `Coin<Q>` (see parlay.move:204-214). Sui requires every non-
 * `Result` Move return to be either consumed by a subsequent
 * command or explicitly transferred; an unconsumed `Coin` causes
 * the PTB to abort with "Unused result without the ability to
 * assign". The previous builder left the returned coin dangling,
 * so every admin withdrawal silently failed at the wallet. We
 * now capture the moveCall result and transfer the coin back to
 * the sender (the only sensible destination for an admin-only
 * withdraw endpoint). Mirrors the pattern in
 * `buildVaultWithdrawTx` (prediction-market-client.ts:923).
 */
export function buildParlayAdminWithdrawTx(
  poolId: string,
  amount: number | bigint,
  coinType: string,
): Transaction {
  const amt = BigInt(amount);
  if (amt <= 0n) {
    throw new Error(
      `buildParlayAdminWithdrawTx: amount must be > 0 (got ${amount})`,
    );
  }
  const tx = new Transaction();
  const out = tx.moveCall({
    target: `${PKG()}::parlay::admin_withdraw`,
    typeArguments: [coinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.pure.u64(amt)],
  });
  tx.transferObjects([out], tx.pure.address("@{sender}"));
  return tx;
}

/**
 * Build a PTB that rotates the pool admin to `newAdmin`. The on-chain
 * check rejects `@0x0` (EInvalidNewAdmin).
 *
 * `coinType` is required: `parlay::rotate_admin<Q>` is generic over
 * the pool's collateral type, so the PTB must supply
 * `typeArguments: [coinType]`.
 */
export function buildRotateParlayAdminTx(
  poolId: string,
  newAdmin: string,
  coinType: string,
): Transaction {
  // R48 audit fix: pre-validate `newAdmin` so a typo (`""`,
  // `"0x0"`) surfaces as a build-time error instead of a Move
  // abort at execute time. Mirror the R37 streak guard.
  // R49 audit fix: route through `isValidSuiAddress` for
  // consistency with the other builders and to also reject
  // whitespace, mixed-case-with-trailing-space, and the
  // all-zeros placeholder (the previous inline check missed
  // e.g. `"  0x0…0  "` and a paste with a leading newline).
  if (!isValidSuiAddress(newAdmin)) {
    throw new Error(
      `buildRotateParlayAdminTx: newAdmin must be a non-zero Sui address (got "${newAdmin}")`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::rotate_admin`,
    typeArguments: [coinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.pure.address(newAdmin)],
  });
  return tx;
}

/**
 * Build a PTB that updates the pool's max payout multiplier. The
 * new cap must be >= BPS (10_000) — the on-chain check rejects
 * anything below 1x.
 *
 * `coinType` is required: `parlay::set_max_payout_bps<Q>` is generic
 * over the pool's collateral type, so the PTB must supply
 * `typeArguments: [coinType]`.
 */
export function buildSetMaxPayoutBpsTx(
  poolId: string,
  newMaxBps: number | bigint,
  coinType: string,
): Transaction {
  // R49 audit fix: on-chain `parlay::set_max_payout_bps` aborts
  // with `EInvalidPayoutBps` when `new_max_bps < BPS`. The
  // comment above the function already says the new cap must
  // be `>= BPS` — enforce it at the build boundary so a
  // misconfigured admin script doesn't burn gas on a doomed tx.
  if (BigInt(newMaxBps) < BigInt(BPS)) {
    throw new Error(
      `buildSetMaxPayoutBpsTx: newMaxBps must be >= BPS (${BPS}) (got ${newMaxBps})`,
    );
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::set_max_payout_bps`,
    typeArguments: [coinType],
    arguments: [tx.object(normalizeObjectId(poolId)), tx.pure.u64(newMaxBps)],
  });
  return tx;
}

// ============================================================
// Parlay lifecycle
// ============================================================

/**
 * Build a PTB that creates a new parlay. The caller supplies the
 * market IDs they want to bet on (same order as `predictions`);
 * both vectors must have the same length, between MIN_LEGS (2) and
 * MAX_LEGS (5). The pool must have enough balance to cover the
 * worst-case payout at creation time (the on-chain check is
 * `pool_balance + collateral >= max_payout`).
 *
 * `payoutBps` is the multiplier in bps (e.g. 30_000 = 3x). It must
 * be > BPS and <= pool.max_payout_bps.
 *
 * `collateralAtoms` is the amount of Q (in base units) to lock as
 * the parlay's collateral. The on-chain `parlay::create_parlay` takes
 * a `Coin<Q>` BY VALUE and locks the entire balance via
 * `coin::value(&coin)` — so we MUST split the requested amount off
 * `coinId` in-PTB and pass the split result. Passing the source
 * coin object directly would drain the user's full DUSDC balance
 * and leave them with no coin for the next parlay or withdrawal.
 *
 * The created `Parlay<Q>` is transferred to the sender; the
 * remainder of the source coin (if any) is returned to the sender
 * unchanged.
 */
export function buildCreateParlayTx(args: {
  poolId: string;
  coinId: string;
  collateralAtoms: number | bigint;
  marketIds: string[];
  predictions: Array<1 | 2>; // 1 = YES, 2 = NO
  payoutBps: number | bigint;
  coinType: string;
}): Transaction {
  if (args.marketIds.length !== args.predictions.length) {
    throw new Error(
      `buildCreateParlayTx: marketIds (${args.marketIds.length}) and ` +
        `predictions (${args.predictions.length}) must have the same length`,
    );
  }
  // R49 audit fix: enforce the 2–5 leg cap at the build boundary.
  // The on-chain `parlay::create_parlay` aborts with
  // `EInvalidLegCount` outside this range. Catching it here gives
  // the user a friendlier error than a Move abort inside the
  // wallet spinner.
  if (args.marketIds.length < MIN_LEGS || args.marketIds.length > MAX_LEGS) {
    throw new Error(
      `buildCreateParlayTx: marketIds must have ${MIN_LEGS}–${MAX_LEGS} legs (got ${args.marketIds.length})`,
    );
  }
  // R52 audit fix: validate per-element
  // `predictions` are 1 (YES) or 2 (NO).
  // The TS type is `Array<1 | 2>` but
  // this is a structural type — at
  // runtime a `[1, 2, 99]` vector
  // compiles and runs, and the on-chain
  // `parlay.move` asserts per-element
  // `pred == PREDICT_YES ||
  // pred == PREDICT_NO` (i.e. `1|2`).
  // A `0` or `3` aborts the entire PTB
  // with `ELegPredictionMismatch`,
  // losing the user's collateral gas.
  if (!args.predictions.every((p) => p === 1 || p === 2)) {
    const bad = args.predictions
      .map((p, i) => (p === 1 || p === 2 ? null : i))
      .filter((i) => i !== null);
    throw new Error(
      `buildCreateParlayTx: predictions must be 1 (YES) or 2 (NO) for every leg ` +
        `(bad indices: ${bad.join(", ")})`,
    );
  }
  const collateral = BigInt(args.collateralAtoms);
  if (collateral <= 0n) {
    throw new Error(
      `buildCreateParlayTx: collateralAtoms must be > 0 (got ${args.collateralAtoms})`,
    );
  }
  // R49 audit fix: validate `payoutBps`. On-chain requires
  // `> BPS` and `<= pool.max_payout_bps`. We can't read the pool
  // from this builder, so just enforce the lower bound here and
  // let the on-chain check reject over-cap values. The `<= BPS`
  // case would still abort with `EPayoutTooLarge`.
  const payoutBps = BigInt(args.payoutBps);
  if (payoutBps <= BigInt(BPS)) {
    throw new Error(
      `buildCreateParlayTx: payoutBps must be > BPS (${BPS}) (got ${args.payoutBps})`,
    );
  }
  const tx = new Transaction();
  // Split exactly `collateral` off the source coin in-PTB and pass
  // the split result to `create_parlay`. Mirrors the pattern in
  // `buildMintSharesTx` (prediction-market-client.ts) — without
  // this split, the contract's `coin::value(&coin)` would lock the
  // entire source coin balance as collateral.
  // R46 audit fix: normalize the source coin id. R45 normalized
  // the pool id, market ids, and the four parlay pool admin
  // builders but missed this one — a coin id with mixed-case
  // hex (e.g. a Suiscan link with a leading `0xAbc…`) would
  // resolve to a different BCS object than the canonical
  // lowercase form and the `splitCoins` would target a
  // non-existent object, aborting the PTB.
  const [parlayCoin] = tx.splitCoins(tx.object(normalizeObjectId(args.coinId)), [
    tx.pure.u64(collateral),
  ]);
  // R43 audit fix: normalize every market id in the vector to
  // the canonical 0x + 64 hex form before serializing. The
  // on-chain `parlay::create_parlay<Q>` rejects the PTB at BCS
  // resolution if any vector element is mixed-case (the BCS
  // decoder is case-sensitive; `0xAbc…` and `0xabc…` are
  // distinct bytes). A single bad entry in a 5-leg parlay
  // bricks the entire PTB.
  const normalizedMarketIds = args.marketIds.map((id) => normalizeObjectId(id));
  tx.moveCall({
    target: `${PKG()}::parlay::create_parlay`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(normalizeObjectId(args.poolId)),
      tx.object(parlayCoin),
      tx.pure.vector("id", normalizedMarketIds),
      tx.pure.vector("u8", args.predictions),
      tx.pure.u64(args.payoutBps),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

/**
 * Build a PTB that records the outcome of one leg. `market` must be
 * the on-chain `PredictionMarket<Q>` that the leg was bound to, and
 * it must be resolved (the on-chain check calls
 * `prediction_market::is_resolved`). The leg's status flips to WON
 * or LOST based on whether the market outcome matched the user's
 * prediction.
 *
 * R41 audit fix: the previous `marketType` parameter was named
 * misleadingly. The Move function `record_leg<Q>(parlay: &mut Parlay<Q>,
 * market: &PredictionMarket<Q>, …)` has only ONE type parameter `Q`
 * (shared between the parlay and the market). The caller was
 * passing the full `PredictionMarket<DUSDC_TYPE>` string as the
 * type arg, which is a 2-arg form Move rejects at type-check
 * (`PTB type-argument count mismatch`). Rename the parameter to
 * `coinType` and pass the Q value (e.g. `DUSDC_TYPE`) directly.
 * The market's `PredictionMarket<Q>` type is then pinned by Q
 * automatically.
 */
export function buildRecordLegTx(args: {
  parlayId: string;
  marketId: string;
  coinType: string;
  legIndex: number | bigint;
}): Transaction {
  // R47 audit fix: normalize `parlayId` and `marketId`.
  // R45 normalized the parlay pool admin builders
  // and `buildCreateParlayTx` but missed the
  // per-leg `record_leg` and the `finalize_parlay`
  // lifecycle builders. These are the most-touched
  // hot paths in the parlay-worker (a single tick
  // can issue hundreds of `record_leg` calls); a
  // mixed-case paste in the agents `.env` would
  // abort the entire PTB at BCS resolution.
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::record_leg`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(normalizeObjectId(args.parlayId)),
      tx.object(normalizeObjectId(args.marketId)),
      tx.pure.u64(args.legIndex),
    ],
  });
  return tx;
}

/**
 * Build a PTB that consumes the parlay and pays out. The on-chain
 * check requires `legs_recorded == leg_count` (i.e. every leg must
 * have been recorded). The on-chain `legs_lost` count decides
 * win/lose: zero losses pays out `collateral * payout_bps / 10_000`,
 * any loss zeroes the payout (the collateral is already in the
 * pool, so losing requires no transfer).
 */
export function buildFinalizeParlayTx(args: {
  parlayId: string;
  poolId: string;
  coinType: string;
}): Transaction {
  // R47 audit fix: normalize `parlayId` and `poolId`.
  // The finalize path is the highest-value PTB the
  // worker submits (it transfers the parlay's
  // collateral to the winner) — losing precision
  // here is unrecoverable.
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::finalize_parlay`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(normalizeObjectId(args.parlayId)),
      tx.object(normalizeObjectId(args.poolId)),
    ],
  });
  return tx;
}

// ============================================================
// Reads
// ============================================================

async function readParlayObject(
  client: SuiClient,
  objectId: string,
): Promise<Record<string, unknown> | null> {
  const { object } = await client.core.getObject({
    objectId,
    include: { json: true },
  });
  return (object.json as Record<string, unknown> | null) ?? null;
}

/** Fetch the current `pool_balance` (u64) for a `ParlayPool<Q>`. */
export async function readParlayPoolBalance(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, poolId);
  if (!fields) return 0n;
  // R48 audit fix: route through the shared `asBalance` helper. The
  // previous inline check only handled the legacy `fields.value`
  // shape and silently returned 0n on the modern gRPC
  // `{value: "..."}` form, which the R39 migration made the only
  // shape seen in production. The pre-flight pool-balance check
  // and the bootstrap/resume scripts that read this value all
  // reported an empty pool post-migration.
  return asBalance(fields, "pool_balance");
}

/** Fetch the `admin` (address) for a `ParlayPool<Q>`. */
export async function readParlayPoolAdmin(
  client: SuiClient,
  poolId: string,
): Promise<string> {
  const fields = await readParlayObject(client, poolId);
  return (fields?.admin as string | undefined) ?? "";
}

/** Fetch the `max_payout_bps` (u64) for a `ParlayPool<Q>`. */
export async function readParlayMaxPayoutBps(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, poolId);
  return BigInt((fields?.max_payout_bps as string | number | undefined) ?? 0);
}

/** Fetch the `total_volume` (u64) for a `ParlayPool<Q>`. */
export async function readParlayTotalVolume(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, poolId);
  return BigInt((fields?.total_volume as string | number | undefined) ?? 0);
}

/** Fetch the `total_paid_out` (u64) for a `ParlayPool<Q>`. */
export async function readParlayTotalPaidOut(
  client: SuiClient,
  poolId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, poolId);
  return BigInt((fields?.total_paid_out as string | number | undefined) ?? 0);
}

/** Fetch the `collateral_amount` (u64) snapshot for a `Parlay<Q>`. */
export async function readParlayCollateral(
  client: SuiClient,
  parlayId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, parlayId);
  return BigInt((fields?.collateral_amount as string | number | undefined) ?? 0);
}

/** Fetch the `payout_bps` (u64) for a `Parlay<Q>`. */
export async function readParlayPayoutBps(
  client: SuiClient,
  parlayId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, parlayId);
  return BigInt((fields?.payout_bps as string | number | undefined) ?? 0);
}

/** Fetch the `owner` (address) for a `Parlay<Q>`. */
export async function readParlayOwner(
  client: SuiClient,
  parlayId: string,
): Promise<string> {
  const fields = await readParlayObject(client, parlayId);
  return (fields?.owner as string | undefined) ?? "";
}

/** Fetch the `legs_recorded` (u64) for a `Parlay<Q>`. */
export async function readParlayLegsRecorded(
  client: SuiClient,
  parlayId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, parlayId);
  return BigInt((fields?.legs_recorded as string | number | undefined) ?? 0);
}

/** Fetch the `legs_lost` (u64) for a `Parlay<Q>`. */
export async function readParlayLegsLost(
  client: SuiClient,
  parlayId: string,
): Promise<bigint> {
  const fields = await readParlayObject(client, parlayId);
  return BigInt((fields?.legs_lost as string | number | undefined) ?? 0);
}
