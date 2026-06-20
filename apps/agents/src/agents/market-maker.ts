import {
  executeTransaction,
  DUSDC_TYPE,
  DUSDC_TREASURY_CAP_ID,
  marketTypeSeed,
  yesCoinType,
  resolveDeepbookPackageId,
  listAllCoins,
} from "@suipredict/sdk";
import { Transaction } from "@mysten/sui/transactions";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { getMarket, listMarkets, upsertOrder, nextDemoOrderId as nextDemoOrderIdFromStore } from "../markets/store.js";

/**
 * BalanceManager ID resolution order:
 *   1. `BALANCE_MANAGER_ID` env (the production override)
 *   2. `BALANCE_MANAGER_ID_FILE` file path (written by bootstrap-gamification)
 *   3. `.balance_manager` in the working directory (dev convenience)
 * If all three are empty, MM is skipped (see skip below).
 *
 * R47 audit fix: the previous module-level
 * `const BALANCE_MANAGER_ID = loadBalanceManagerId()`
 * froze the file-system read at module load.
 * A bootstrap-gamification run that wrote
 * `.balance_manager` *after* the agents service
 * booted would never be picked up; the MM would
 * skip every cycle with "no BalanceManager".
 * Read it inside `runMarketMaker` so a hot
 * deployment is observed.
 */
function loadBalanceManagerId(): string | undefined {
  const env = process.env.BALANCE_MANAGER_ID?.trim();
  if (env) return env;
  const file = process.env.BALANCE_MANAGER_ID_FILE?.trim();
  if (file) {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const v = fs.readFileSync(file, "utf8").trim();
      if (v) return v;
    } catch {
      /* fall through */
    }
  }
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const v = fs.readFileSync(".balance_manager", "utf8").trim();
    if (v) return v;
  } catch {
    /* not present */
  }
  return undefined;
}

/**
 * Per-market monotonic `order_id` counter for the
 * demo path. R47 audit fix: the previous
 * `Date.now()` / `Date.now() + 1` sequence
 * collided for two MM cycles in the same
 * millisecond (the on-chain digest-derived
 * id can also collide back). R56 audit fix:
 * the in-process `Map` (added by R47) was
 * cleared on every Railway redeploy, and the
 * next tick re-seeded from `Date.now()` — a
 * fast redeploy can keep `Date.now()` the
 * same or smaller, so two `upsertOrder`
 * calls would collide on the (market_id,
 * order_id) PK and silently re-flip a
 * cancelled demo order. The counter is now
 * SQLite-backed (`demo_order_counters`
 * table) and atomic across replicas.
 */
function nextDemoOrderId(marketId: string): number {
  return nextDemoOrderIdFromStore(marketId);
}

process.on("uncaughtException", (e) => console.error("[market-maker] CRASH:", e.message));
process.on("unhandledRejection", (e) => console.error("[market-maker] REJECT:", e));
export async function runMarketMaker(ctx: AgentContext): Promise<AgentResult> {
  // Boot marker — ensures this module is loaded
  if (!(globalThis as any).__mm_booted) {
    (globalThis as any).__mm_booted = true;
    console.log("[market-maker] Module loaded, starting ticks");
  }
  // R47 audit fix: re-read the runtime-tunable knobs
  // (`SPREAD_THRESHOLD_BPS`, `QUOTE_SIZE`,
  // `BALANCE_MANAGER_ID`, `AGENT_POLICY_ID`) at the
  // top of the run function. The previous module-level
  // reads froze the boot-time snapshot forever, so a
  // hot-patch of `MM_QUOTE_SIZE` via `bootstrap-env.ts`
  // would have been ignored for the rest of the
  // process lifetime. R43 already fixed
  // `prize-admin.ts` and `risk-monitor.ts`; this is
  // the same pattern applied here.
  // R55 audit fix: route both through `safeInt` so a
  // non-integer env value (e.g. `MM_SPREAD_THRESHOLD_BPS=NaN`
  // or `MM_QUOTE_SIZE=1e20` OOM-bomb) doesn't break the
  // market-maker silently. Clamp the spread threshold to
  // a sane `[1, 10_000]` bps range and the quote size to
  // `[1, 1e15]` atoms.
  const SPREAD_THRESHOLD_BPS = safeInt(
    process.env.MM_SPREAD_THRESHOLD_BPS,
    400,
    1,
    10_000,
  );
  const QUOTE_SIZE = safeInt(
    process.env.MM_QUOTE_SIZE,
    10_000_000,
    1,
    1_000_000_000_000_000,
  );
  const BALANCE_MANAGER_ID = loadBalanceManagerId();
  const AGENT_POLICY_ID = process.env.AGENT_POLICY_ID ?? "";
  // Estimated DBUSDC notional per side per cycle: price*qty. Used for authorize_spend.
  const PER_ORDER_NOTIONAL_DOLLARS = Math.max(
    1,
    Math.round((QUOTE_SIZE * (SPREAD_THRESHOLD_BPS / 10_000 + 0.05)) / 1_000_000),
  );
  // R56 audit fix: clamp the per-cycle auth amount to the policy
  // budget. With QUOTE_SIZE=1e15 and SPREAD_THRESHOLD_BPS=10000
  // (the R55-safe max), PER_ORDER_NOTIONAL_DOLLARS computes to
  // ~1.05e9, so *2 (both sides) is ~2.1e9 — far above the default
  // ctx.maxBudgetUsdc=500. The on-chain authorize_spend would
  // abort with a budget error, the worker catches it at line 298
  // and logs quote_failed, then retries the same doomed tx every
  // minute. Clamp to the budget so the worker can either
  // authorize (when budget is reasonable) or skip cleanly with
  // over_budget_skip when it's not.
  const cycleAuthDollars = Math.min(
    PER_ORDER_NOTIONAL_DOLLARS * 2,
    ctx.maxBudgetUsdc,
  );

  // Find an active market that has a DeepBook pool
  const target = listMarkets().find(
    (m) =>
      m.status === "active" &&
      typeof m.deepbook_pool_id === "string" &&
      m.deepbook_pool_id.length === 66 &&
      // R-WC-1.7 fix: a stale SQLite mirror may carry a
      // pool id that no longer exists on-chain (e.g. an
      // orphan pool from a previous package publish).
      // Skip markets whose on-chain pool type doesn't
      // match the DeepBook package we're calling
      // `place_limit_order` against. The full on-chain
      // type check happens below (after we have DB).
      m.category !== "worldcup",
  );
  if (!target) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "No active markets with DeepBook pools.",
    });
  }

  const poolId = target.deepbook_pool_id!;
  const client = getSharedClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
  const DB = resolveDeepbookPackageId();
  const bmId = BALANCE_MANAGER_ID;

  if (!poolId || !bmId) {
    return recordResult("MarketMaker", {
      action: "skip",
      reasoning: "No active market with pool or no BalanceManager configured.",
    });
  }

  // R-WC-1.7 fix: verify the pool's on-chain type matches
  // `${DB}::pool::Pool<YES<DUSDC>, DUSDC>` — but a
  // deeper check is needed for the YES coin's owning
  // package. The SDK's `yesCoinType()` returns
  // `${MARKET_PACKAGE_ID}::prediction_market::YES<DUSDC>`,
  // which only matches pools whose YES type was
  // registered by the current `prediction_market`
  // package. On multi-package deployments where the
  // SQLite mirror carries pools from older publishes
  // (different `prediction_market::YES` types), the
  // guard must compare the pool's YES-type package to
  // the SDK's expected YES package and skip mismatches.
  try {
    const expectedPoolTypePrefix = `${DB}::pool::Pool<`;
    const expectedYesTypePrefix = `${process.env.MARKET_PACKAGE_ID ?? ""}::prediction_market::YES<`;
    const RPC =
      process.env.SUI_RPC_URL ??
      (process.env.SUI_NETWORK === "mainnet"
        ? "https://fullnode.mainnet.sui.io:443"
        : process.env.SUI_NETWORK === "devnet"
          ? "https://fullnode.devnet.sui.io:443"
          : "https://fullnode.testnet.sui.io:443");
    const typeRes = await fetch(RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "sui_getObject",
        params: [poolId, { showType: true }],
        id: 1,
      }),
    });
    const typeJson = (await typeRes.json()) as {
      result?: { data?: { type?: string } };
    };
    const onChainType = typeJson.result?.data?.type ?? "";
    // Pool object must live under the DeepBook package
    if (!onChainType.startsWith(expectedPoolTypePrefix)) {
      return recordResult("MarketMaker", {
        action: "skip",
        reasoning:
          `Pool ${poolId.slice(0, 18)}… on-chain type "${onChainType || "<missing>"}" ` +
          `does not start with "${expectedPoolTypePrefix}". Stale SQLite row — clear deepbook_pool_id ` +
          `and let the wc-creator / market-creator tick rebuild the market.`,
      });
    }
    // R-WC-1.7 follow-up: the pool's YES coin must live
    // in the same package as `prediction_market::YES<Q>`.
    // On multi-package deployments where older markets
    // were published from a different package, the YES
    // type lives elsewhere and `place_limit_order`
    // aborts with `TypeMismatch` on the Pool arg.
    if (
      expectedYesTypePrefix &&
      !onChainType.includes(expectedYesTypePrefix)
    ) {
      return recordResult("MarketMaker", {
        action: "skip",
        reasoning:
          `Pool ${poolId.slice(0, 18)}… has YES coin from a different package ` +
          `(expected "${expectedYesTypePrefix}" inside the pool type). ` +
          `The SDK's yesCoinType() will type-mismatch against this pool.`,
      });
    }
  } catch (err) {
    console.warn(
      `[MarketMaker] pool-type pre-flight failed for ${poolId.slice(0, 18)}…: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Skip order book depth query — use fixed spread quoting
  const midBps = 5000; // 0.50 DUSDC mid
  const bidBps = 4800; // below mid
  const askBps = 5200; // above mid

  if (target.id.startsWith("demo-")) {
    const nextOrderId = nextDemoOrderId(target.id);
    upsertOrder({ market_id: target.id, order_id: nextOrderId, owner: agentAddr, is_bid: true, price_bps: bidBps, quantity: QUOTE_SIZE, timestamp_ms: Date.now() });
    upsertOrder({ market_id: target.id, order_id: nextOrderId + 1, owner: agentAddr, is_bid: false, price_bps: askBps, quantity: QUOTE_SIZE, timestamp_ms: Date.now() });
    return recordResult("MarketMaker", { action: "quote_demo", reasoning: `Demo quotes ${bidBps / 100}¢ / ${askBps / 100}¢ on ${target.title.slice(0, 36)}...`, confidence: 80 });
  }

  const baseType = yesCoinType(undefined, marketTypeSeed(target.id));
  const quoteType = DUSDC_TYPE;
  const TICK = 1_000_000n; // pool tick_size

  try {
    // 0. Find or mint DUSDC for fee payment
    const dusdcCoins = await listAllCoins(client, agentAddr, quoteType);
    let dusdcId = dusdcCoins.find((c: any) => BigInt(c.balance) >= 1_000_000n)?.objectId;
    if (!dusdcId) {
      // R60 audit fix: the previous code hardcoded
      // `0x6754966565db058de1358d6db773510c5d2991937215d8e42d7c968acb3e8012`
      // for the TreasuryCap. The TreasuryCap is a
      // deployment-specific one-time-published object
      // (a TreasuryCap migration would publish a new
      // object under a new id), and the SDK already
      // exports `DUSDC_TREASURY_CAP_ID` resolved from
      // `DUSDC_TREASURY_CAP_ID` / `NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID`
      // env vars with a testnet fallback. Use the SDK
      // constant so a mainnet deploy that rotates the
      // cap (or a self-hosted dUSDC package) honours
      // the env without a code change.
      //
      // The mint step stays as its own PTB because
      // `mint_and_transfer` is a one-shot
      // transfer-to-address operation; it doesn't
      // depend on any of the BM objects the rest of
      // this function touches, so combining it would
      // force the whole atomic PTB to fail (and roll
      // back the mint) on a downstream error. Keep
      // it separate.
      const treasuryCapId = DUSDC_TREASURY_CAP_ID;
      if (!treasuryCapId) {
        throw new Error("DUSDC_TREASURY_CAP_ID is unset; cannot mint DUSDC.");
      }
      const mintTx = new Transaction();
      mintTx.moveCall({
        target: "0x2::coin::mint_and_transfer",
        typeArguments: [quoteType],
        arguments: [mintTx.object(treasuryCapId), mintTx.pure.u64(1_000_000_000_000n), mintTx.pure.address(agentAddr)],
      });
      await executeTransaction(client, () => mintTx, ctx.signer);
      const freshCoins = await listAllCoins(client, agentAddr, quoteType);
      dusdcId = freshCoins.find((c: any) => BigInt(c.balance) >= 1_000_000n)?.objectId;
      if (!dusdcId) throw new Error("Failed to mint DUSDC");
    }

    // 1. Atomic PTB #1: deposit + authorize_spend.
    // R61 fix: the pre-fix build submitted these as 4
    // separate PTBs in sequence. The agents service has
    // other workers (RiskMonitor every 5min,
    // PositionIndexer every 1min, the WC maker every
    // 2min) all sharing the same gas coin (the agent
    // account has only one SUI coin). Between PTBs the
    // gas coin was consumed by another worker, the
    // next PTB was rebuilt with the stale version, and
    // the Sui node returned:
    //   "Transaction needs to be rebuilt because object
    //    <gas-coin> version <X> is unavailable for
    //    consumption, current version: <X+N>"
    // Producing a `quote_failed` every minute and an
    // empty on-chain order book. Combining the BM
    // setup into one PTB eliminates that race.
    //
    // R61.b follow-up: the original 8-call PTB and the
    // 4-call PTB both failed with
    // `balance_manager::withdraw_with_proof` abort
    // code 3 (`EInvalidProof`). The
    // `withdraw_settled_amounts` call in the same
    // PTB invalidated the proofs that the bid and ask
    // `place_limit_order` calls needed. Even putting
    // the orders in a separate PTB didn't help because
    // the MM's `withdraw_settled_amounts` (a BM
    // state-touching op) invalidated the proof the
    // same PTB used. The fix: drop the
    // `withdraw_settled_amounts` from the per-cycle
    // critical path. The settled balance carries over
    // from cycle to cycle (it only needs to be
    // withdrawn when the maker changes pools or
    // withdraws inventory) so running it on every
    // tick is unnecessary. Keep the deposit so the
    // BM has fresh DUSDC to quote against.
    const bidPrice = BigInt(Math.round((bidBps / 10_000) * 1_000_000 * 1_000_000));
    const askPrice = BigInt(Math.round((askBps / 10_000) * 1_000_000 * 1_000_000));
    const setupTx = new Transaction();
    setupTx.moveCall({
      target: `${DB}::balance_manager::deposit`,
      typeArguments: [quoteType],
      arguments: [setupTx.object(bmId), setupTx.object(dusdcId)],
    });
    if (AGENT_POLICY_ID) {
      setupTx.moveCall({
        target: `${process.env.AGENT_POLICY_PACKAGE_ID ?? ""}::agent_policy::authorize_spend`,
        typeArguments: [],
        arguments: [
          setupTx.object(AGENT_POLICY_ID),
          setupTx.pure.u64(BigInt(cycleAuthDollars * 1_000_000)),
          setupTx.object.clock(),
        ],
      });
    }
    await executeTransaction(client, () => setupTx, ctx.signer);

    // 2. Atomic PTB #2: place_limit_order bid + place_limit_order ask.
    // The bid and ask are placed in the same PTB with
    // distinct `client_order_id` values (0 and 1) so
    // the on-chain matcher sees two independent orders.
    // Sharing a PTB means a single gas-coin read, but
    // PTB-A's `withdraw_settled_amounts` would
    // invalidate the TradeProof if it ran in the same
    // PTB, so the orders are isolated to their own
    // PTB. Two PTBs vs the pre-fix four is still a
    // 50% reduction in gas-coin reads, which is the
    // minimum to avoid the version race against the
    // 1-min PositionIndexer and 2-min WorldCupMaker.
    const orderTx = new Transaction();
    const bProof = orderTx.moveCall({
      target: `${DB}::balance_manager::generate_proof_as_owner`,
      arguments: [orderTx.object(bmId)],
    });
    orderTx.moveCall({
      target: `${DB}::pool::place_limit_order`,
      typeArguments: [baseType, quoteType],
      arguments: [
        orderTx.object(poolId),
        orderTx.object(bmId),
        bProof,
        orderTx.pure.u64(0n),
        orderTx.pure.u8(0),
        orderTx.pure.u8(1),
        orderTx.pure.u64(bidPrice),
        orderTx.pure.u64(BigInt(QUOTE_SIZE)),
        orderTx.pure.bool(true),
        orderTx.pure.bool(false),
        orderTx.pure.u64(BigInt(Date.now() + 3600_000)),
        orderTx.object.clock(),
      ],
    });
    const aProof = orderTx.moveCall({
      target: `${DB}::balance_manager::generate_proof_as_owner`,
      arguments: [orderTx.object(bmId)],
    });
    orderTx.moveCall({
      target: `${DB}::pool::place_limit_order`,
      typeArguments: [baseType, quoteType],
      arguments: [
        orderTx.object(poolId),
        orderTx.object(bmId),
        aProof,
        orderTx.pure.u64(1n),
        orderTx.pure.u8(0),
        orderTx.pure.u8(1),
        orderTx.pure.u64(askPrice),
        orderTx.pure.u64(BigInt(QUOTE_SIZE)),
        orderTx.pure.bool(false),
        orderTx.pure.bool(false),
        orderTx.pure.u64(BigInt(Date.now() + 3600_000)),
        orderTx.object.clock(),
      ],
    });
    const result = await executeTransaction(client, () => orderTx, ctx.signer);

    // Record on-chain orders in SQLite so the frontend order book stays in sync.
    // Use unique numeric IDs derived from the shared
    // digest (0/1 offset) so the bid and ask are
    // distinct rows in the SQLite mirror.
    const baseOrderId = Number(
      BigInt("0x" + result.digest.slice(2, 18)) % BigInt(1e15),
    );
    upsertOrder({
      market_id: target.id,
      order_id: baseOrderId,
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: baseOrderId + 1,
      owner: agentAddr,
      is_bid: false,
      price_bps: askBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now() + 1,
    });

    return recordResult("MarketMaker", {
      action: "place_quotes",
      reasoning: `Quoted ${bidBps / 100}¢/${askBps / 100}¢ on ${target.title.slice(0, 36)}... (atomic PTB)`,
      confidence: 85,
      txDigest: result.digest,
    });
  } catch (err) {
    return recordResult("MarketMaker", {
      action: "quote_failed",
      reasoning: `MM failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

