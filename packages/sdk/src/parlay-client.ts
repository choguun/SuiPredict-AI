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

const PKG = () => AGENT_POLICY_PACKAGE_ID;

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
 */
export function buildCreateParlayPoolTx(
  maxPayoutBps: number | bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::create_pool`,
    typeArguments: [],
    arguments: [tx.pure.u64(maxPayoutBps)],
  });
  return tx;
}

/**
 * Build a PTB that tops up an existing `ParlayPool<Q>`. Anyone can
 * call this — the function doesn't gate on admin. Useful for the
 * protocol seeding bot and partner donations.
 */
export function buildFundParlayPoolTx(
  poolId: string,
  coinId: string,
  coinType: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::fund_pool`,
    typeArguments: [coinType],
    arguments: [tx.object(poolId), tx.object(coinId)],
  });
  return tx;
}

/**
 * Build a PTB that withdraws `amount` from the pool. Admin only —
 * the on-chain check is `ctx.sender() == pool.admin`.
 */
export function buildParlayAdminWithdrawTx(
  poolId: string,
  amount: number | bigint,
  coinType: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::admin_withdraw`,
    typeArguments: [coinType],
    arguments: [tx.object(poolId), tx.pure.u64(amount)],
  });
  return tx;
}

/**
 * Build a PTB that rotates the pool admin to `newAdmin`. The on-chain
 * check rejects `@0x0` (EInvalidNewAdmin).
 */
export function buildRotateParlayAdminTx(
  poolId: string,
  newAdmin: string,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::rotate_admin`,
    typeArguments: [],
    arguments: [tx.object(poolId), tx.pure.address(newAdmin)],
  });
  return tx;
}

/**
 * Build a PTB that updates the pool's max payout multiplier. The
 * new cap must be >= BPS (10_000) — the on-chain check rejects
 * anything below 1x.
 */
export function buildSetMaxPayoutBpsTx(
  poolId: string,
  newMaxBps: number | bigint,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::set_max_payout_bps`,
    typeArguments: [],
    arguments: [tx.object(poolId), tx.pure.u64(newMaxBps)],
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
 * The created `Parlay<Q>` is transferred to the sender.
 */
export function buildCreateParlayTx(args: {
  poolId: string;
  coinId: string;
  marketIds: string[];
  predictions: Array<1 | 2>; // 1 = YES, 2 = NO
  payoutBps: number | bigint;
  coinType: string;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::create_parlay`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.poolId),
      tx.object(args.coinId),
      tx.pure.vector("id", args.marketIds),
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
 */
export function buildRecordLegTx(args: {
  parlayId: string;
  marketId: string;
  marketType: string;
  legIndex: number | bigint;
}): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::record_leg`,
    typeArguments: [args.marketType],
    arguments: [
      tx.object(args.parlayId),
      tx.object(args.marketId),
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
  const tx = new Transaction();
  tx.moveCall({
    target: `${PKG()}::parlay::finalize_parlay`,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.parlayId), tx.object(args.poolId)],
  });
  return tx;
}

// ============================================================
// Reads
// ============================================================

/** Fetch the current `pool_balance` (u64) for a `ParlayPool<Q>`. */
export async function readParlayPoolBalance(
  client: { getObject: Function },
  poolId: string,
  coinType: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: poolId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as
    | { pool_balance?: string; id?: { id?: string } }
    | undefined;
  if (!fields) return 0n;
  // Balance is a `Balance<Q>` wrapper. Sui renders it as a struct with
  // a `value` field. The parlay struct stores it under
  // `pool_balance`; for a generic-object read, look for either the
  // raw `value` or the wrapped form.
  const bal = (fields as Record<string, unknown>).pool_balance as
    | string
    | { fields?: { value?: string | number } };
  if (typeof bal === "string") return BigInt(bal);
  if (bal && typeof bal === "object" && "fields" in bal) {
    const v = (bal as { fields: { value?: string | number } }).fields.value;
    if (v != null) return BigInt(v);
  }
  // Fallback: many Sui RPCs return a `value` sibling.
  const direct = (fields as Record<string, unknown>).value as
    | string
    | number
    | undefined;
  if (direct != null) return BigInt(direct);
  return 0n;
  // coinType is reserved for the call site that needs to disambiguate
  // phantom types — kept in the signature so a typed client can pass
  // it through without changes.
  void coinType;
}

/** Fetch the `admin` (address) for a `ParlayPool<Q>`. */
export async function readParlayPoolAdmin(
  client: { getObject: Function },
  poolId: string,
): Promise<string> {
  const res = await client.getObject({
    id: poolId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { admin?: string } | undefined;
  return fields?.admin ?? "";
}

/** Fetch the `max_payout_bps` (u64) for a `ParlayPool<Q>`. */
export async function readParlayMaxPayoutBps(
  client: { getObject: Function },
  poolId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: poolId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { max_payout_bps?: string | number } | undefined;
  return BigInt(fields?.max_payout_bps ?? 0);
}

/** Fetch the `total_volume` (u64) for a `ParlayPool<Q>`. */
export async function readParlayTotalVolume(
  client: { getObject: Function },
  poolId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: poolId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { total_volume?: string | number } | undefined;
  return BigInt(fields?.total_volume ?? 0);
}

/** Fetch the `total_paid_out` (u64) for a `ParlayPool<Q>`. */
export async function readParlayTotalPaidOut(
  client: { getObject: Function },
  poolId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: poolId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { total_paid_out?: string | number } | undefined;
  return BigInt(fields?.total_paid_out ?? 0);
}

/** Fetch the `collateral_amount` (u64) snapshot for a `Parlay<Q>`. */
export async function readParlayCollateral(
  client: { getObject: Function },
  parlayId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: parlayId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { collateral_amount?: string | number } | undefined;
  return BigInt(fields?.collateral_amount ?? 0);
}

/** Fetch the `payout_bps` (u64) for a `Parlay<Q>`. */
export async function readParlayPayoutBps(
  client: { getObject: Function },
  parlayId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: parlayId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { payout_bps?: string | number } | undefined;
  return BigInt(fields?.payout_bps ?? 0);
}

/** Fetch the `owner` (address) for a `Parlay<Q>`. */
export async function readParlayOwner(
  client: { getObject: Function },
  parlayId: string,
): Promise<string> {
  const res = await client.getObject({
    id: parlayId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { owner?: string } | undefined;
  return fields?.owner ?? "";
}

/** Fetch the `legs_recorded` (u64) for a `Parlay<Q>`. */
export async function readParlayLegsRecorded(
  client: { getObject: Function },
  parlayId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: parlayId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { legs_recorded?: string | number } | undefined;
  return BigInt(fields?.legs_recorded ?? 0);
}

/** Fetch the `legs_lost` (u64) for a `Parlay<Q>`. */
export async function readParlayLegsLost(
  client: { getObject: Function },
  parlayId: string,
): Promise<bigint> {
  const res = await client.getObject({
    id: parlayId,
    options: { showContent: true },
  });
  const fields = (res.data?.content as { fields?: Record<string, unknown> })
    ?.fields as { legs_lost?: string | number } | undefined;
  return BigInt(fields?.legs_lost ?? 0);
}
