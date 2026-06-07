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
import type { SuiClient } from "./predict-client.js";
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
export declare function buildCreateParlayPoolTx(maxPayoutBps: number | bigint, coinType: string): Transaction;
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
export declare function buildFundParlayPoolTx(poolId: string, coinId: string, amountAtoms: number | bigint, coinType: string): Transaction;
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
export declare function buildParlayAdminWithdrawTx(poolId: string, amount: number | bigint, coinType: string): Transaction;
/**
 * Build a PTB that rotates the pool admin to `newAdmin`. The on-chain
 * check rejects `@0x0` (EInvalidNewAdmin).
 *
 * `coinType` is required: `parlay::rotate_admin<Q>` is generic over
 * the pool's collateral type, so the PTB must supply
 * `typeArguments: [coinType]`.
 */
export declare function buildRotateParlayAdminTx(poolId: string, newAdmin: string, coinType: string): Transaction;
/**
 * Build a PTB that updates the pool's max payout multiplier. The
 * new cap must be >= BPS (10_000) — the on-chain check rejects
 * anything below 1x.
 *
 * `coinType` is required: `parlay::set_max_payout_bps<Q>` is generic
 * over the pool's collateral type, so the PTB must supply
 * `typeArguments: [coinType]`.
 */
export declare function buildSetMaxPayoutBpsTx(poolId: string, newMaxBps: number | bigint, coinType: string): Transaction;
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
export declare function buildCreateParlayTx(args: {
    poolId: string;
    coinId: string;
    collateralAtoms: number | bigint;
    marketIds: string[];
    predictions: Array<1 | 2>;
    payoutBps: number | bigint;
    coinType: string;
}): Transaction;
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
export declare function buildRecordLegTx(args: {
    parlayId: string;
    marketId: string;
    coinType: string;
    legIndex: number | bigint;
}): Transaction;
/**
 * Build a PTB that consumes the parlay and pays out. The on-chain
 * check requires `legs_recorded == leg_count` (i.e. every leg must
 * have been recorded). The on-chain `legs_lost` count decides
 * win/lose: zero losses pays out `collateral * payout_bps / 10_000`,
 * any loss zeroes the payout (the collateral is already in the
 * pool, so losing requires no transfer).
 */
export declare function buildFinalizeParlayTx(args: {
    parlayId: string;
    poolId: string;
    coinType: string;
}): Transaction;
/** Fetch the current `pool_balance` (u64) for a `ParlayPool<Q>`. */
export declare function readParlayPoolBalance(client: SuiClient, poolId: string): Promise<bigint>;
/** Fetch the `admin` (address) for a `ParlayPool<Q>`. */
export declare function readParlayPoolAdmin(client: SuiClient, poolId: string): Promise<string>;
/** Fetch the `max_payout_bps` (u64) for a `ParlayPool<Q>`. */
export declare function readParlayMaxPayoutBps(client: SuiClient, poolId: string): Promise<bigint>;
/** Fetch the `total_volume` (u64) for a `ParlayPool<Q>`. */
export declare function readParlayTotalVolume(client: SuiClient, poolId: string): Promise<bigint>;
/** Fetch the `total_paid_out` (u64) for a `ParlayPool<Q>`. */
export declare function readParlayTotalPaidOut(client: SuiClient, poolId: string): Promise<bigint>;
/** Fetch the `collateral_amount` (u64) snapshot for a `Parlay<Q>`. */
export declare function readParlayCollateral(client: SuiClient, parlayId: string): Promise<bigint>;
/** Fetch the `payout_bps` (u64) for a `Parlay<Q>`. */
export declare function readParlayPayoutBps(client: SuiClient, parlayId: string): Promise<bigint>;
/** Fetch the `owner` (address) for a `Parlay<Q>`. */
export declare function readParlayOwner(client: SuiClient, parlayId: string): Promise<string>;
/** Fetch the `legs_recorded` (u64) for a `Parlay<Q>`. */
export declare function readParlayLegsRecorded(client: SuiClient, parlayId: string): Promise<bigint>;
/** Fetch the `legs_lost` (u64) for a `Parlay<Q>`. */
export declare function readParlayLegsLost(client: SuiClient, parlayId: string): Promise<bigint>;
//# sourceMappingURL=parlay-client.d.ts.map