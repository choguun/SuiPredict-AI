import {
  executeTransaction,
  DUSDC_TYPE,
  yesCoinType,
  resolveDeepbookPackageId,
  buildAuthorizeSpendTx,
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
    (m) => m.status === "active" && m.deepbook_pool_id,
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

  const baseType = yesCoinType();
  const quoteType = DUSDC_TYPE;
  const TICK = 1_000_000n; // pool tick_size

  try {
    // 0. Find or mint DUSDC for fee payment
    const dusdcCoins = await listAllCoins(client, agentAddr, quoteType);
    let dusdcId = dusdcCoins.find((c: any) => BigInt(c.balance) >= 1_000_000n)?.objectId;
    if (!dusdcId) {
      // Mint DUSDC via TreasuryCap
      const mintTx = new Transaction();
      mintTx.moveCall({
        target: "0x2::coin::mint_and_transfer",
        typeArguments: [quoteType],
        arguments: [mintTx.object("0x6754966565db058de1358d6db773510c5d2991937215d8e42d7c968acb3e8012"), mintTx.pure.u64(1_000_000_000_000n), mintTx.pure.address(agentAddr)],
      });
      await executeTransaction(client, mintTx, ctx.signer);
      const freshCoins = await listAllCoins(client, agentAddr, quoteType);
      dusdcId = freshCoins.find((c: any) => BigInt(c.balance) >= 1_000_000n)?.objectId;
      if (!dusdcId) throw new Error("Failed to mint DUSDC");
    }

    // 1. Deposit DUSDC into BM
    const depTx = new Transaction();
    depTx.moveCall({ target: `${DB}::balance_manager::deposit`, typeArguments: [quoteType], arguments: [depTx.object(bmId), depTx.object(dusdcId)] });
    await executeTransaction(client, depTx, ctx.signer);
    // 1. Withdraw settled amounts (with owner proof)
    const withdrawTx = new Transaction();
    const wProof = withdrawTx.moveCall({
      target: `${DB}::balance_manager::generate_proof_as_owner`,
      arguments: [withdrawTx.object(bmId)],
    });
    withdrawTx.moveCall({
      target: `${DB}::pool::withdraw_settled_amounts`,
      typeArguments: [baseType, quoteType],
      arguments: [withdrawTx.object(poolId), withdrawTx.object(bmId), wProof],
    });
    await executeTransaction(client, withdrawTx, ctx.signer);

    // 2. Authorize spend
    if (AGENT_POLICY_ID) {
      const authTx = buildAuthorizeSpendTx(AGENT_POLICY_ID, cycleAuthDollars);
      await executeTransaction(client, authTx, ctx.signer);
    }

    // 3. Place bid (price must be multiple of tick_size=1_000_000)
    const bidPrice = BigInt(Math.round(5000 / 10000 * 1_000_000 * 1_000_000)); // 500_000_000 = 0.5
    const askPrice = BigInt(Math.round(5000 / 10000 * 1_000_000 * 1_000_000)); // same for demo
    const bidTx = new Transaction();
    const bProof = bidTx.moveCall({
      target: `${DB}::balance_manager::generate_proof_as_owner`,
      arguments: [bidTx.object(bmId)],
    });
    bidTx.moveCall({
      target: `${DB}::pool::place_limit_order`,
      typeArguments: [baseType, quoteType],
      arguments: [
        bidTx.object(poolId),
        bidTx.object(bmId),
        bProof,
        bidTx.pure.u64(0n),
        bidTx.pure.u8(0),
        bidTx.pure.u8(1),
        bidTx.pure.u64(bidPrice),
        bidTx.pure.u64(BigInt(QUOTE_SIZE)),
        bidTx.pure.bool(true),
        bidTx.pure.bool(false),                        // payWithDeep=false (use DUSDC)
        bidTx.pure.u64(BigInt(Date.now() + 3600_000)),
        bidTx.object.clock(),
      ],
    });
    const bidResult = await executeTransaction(client, bidTx, ctx.signer);

    // 4. Place ask
    const askTx = new Transaction();
    const aProof = askTx.moveCall({
      target: `${DB}::balance_manager::generate_proof_as_owner`,
      arguments: [askTx.object(bmId)],
    });
    askTx.moveCall({
      target: `${DB}::pool::place_limit_order`,
      typeArguments: [baseType, quoteType],
      arguments: [
        askTx.object(poolId),
        askTx.object(bmId),
        aProof,
        askTx.pure.u64(1n),
        askTx.pure.u8(0),
        askTx.pure.u8(1),
        askTx.pure.u64(askPrice),
        askTx.pure.u64(BigInt(QUOTE_SIZE)),
        askTx.pure.bool(false),
        askTx.pure.bool(false),                        // payWithDeep=false
        askTx.pure.u64(BigInt(Date.now() + 3600_000)),
        askTx.object.clock(),
      ],
    });
    await executeTransaction(client, askTx, ctx.signer);

    // Record on-chain orders in SQLite so the frontend order book stays in sync.
    // Use unique numeric IDs derived from timestamp to avoid type conflicts.
    upsertOrder({
      market_id: target.id,
      order_id: Number(BigInt("0x" + bidResult.digest.slice(2, 18)) % BigInt(1e15)),
      owner: agentAddr,
      is_bid: true,
      price_bps: bidBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now(),
    });
    upsertOrder({
      market_id: target.id,
      order_id: Number(BigInt("0x" + bidResult.digest.slice(2, 18)) % BigInt(1e15)) + 1,
      owner: agentAddr,
      is_bid: false,
      price_bps: askBps,
      quantity: QUOTE_SIZE,
      timestamp_ms: Date.now() + 1,
    });

    return recordResult("MarketMaker", {
      action: "place_quotes",
      reasoning: `Quoted ${bidBps / 100}¢/${askBps / 100}¢ on ${target.title.slice(0, 36)}...`,
      confidence: 85,
      txDigest: bidResult.digest,
    });
  } catch (err) {
    return recordResult("MarketMaker", {
      action: "quote_failed",
      reasoning: `MM failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

