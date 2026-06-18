/**
 * Pool Provisioner (R-WC-1.8)
 *
 * Scans the SQLite mirror for active markets that don't yet have
 * a DeepBook pool and mints the missing pool + on-chain
 * `PredictionMarket` via the SDK's `ensureMarketCreated`. Writes
 * the resulting ids back to the mirror so the maker's
 * `place_limit_order` and the web UI's order book can route
 * through the live pool.
 *
 * Cadence: every 15 minutes (matches the wc-creator so the two
 * agents don't race against each other).
 *
 * Self-funding: the auto-funder agent (auto-funder.ts,
 * also every 10 minutes) tops up the agent wallet with DUSDC
 * whenever the balance drops below the threshold. DEEP has no
 * mint path on this deployment (Sui system coin), so when the
 * wallet is short on DEEP this agent surfaces a single clear
 * `noop` decision with the operator-actionable funding URL —
 * same shape as the wc-creator's `NEEDS FUNDING` branch.
 *
 * Out of scope (until the contract is upgraded to per-market
 * coin types — see AGENTS.md#multi-package-deployment-reality):
 *   - more than one fresh WC market per package per epoch (the
 *     ECurrencyAlreadyExists circuit-breaker will trip after
 *     the first successful provision).
 */
import {
  ensureMarketCreated,
  DUSDC_TYPE,
  DEEP_TYPE,
  POOL_CREATION_FEE_DEEP,
  listAllCoins,
  marketTypeSeed,
} from "@suipredict/sdk";
import { getSharedClient, recordResult } from "../lib.js";
import type { AgentContext, AgentResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

/** 0.2 SUI per provision tx (matches the wc-creator's gate). */
const SUI_PER_PROVISION_ATOMS = 200_000_000n;

/**
 * Per-call SUI budget. We default to 4 provisions per tick
 * (one SUI for SUI) which matches the wc-creator's
 * `MAX_ACTIVE_WC_MARKETS` default of 4.
 */
const MAX_PROVISIONS_PER_TICK = 4;

export async function runPoolProvisioner(
  ctx: AgentContext,
): Promise<AgentResult> {
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();

  // 1. Find candidates: active markets without a DeepBook pool.
  //    Exclude `wc26-*` ghost rows (the on-chain `PredictionMarket`
  //    doesn't exist — the prior wc-creator tick tripped the
  //    circuit-breaker on ECurrencyAlreadyExists). Re-running
  //    ensureMarketCreated on those would just re-abort and burn
  //    gas. Honour the circuit-breaker's `coinRegistryFull` flag.
  const all = listMarkets();
  const candidates = all.filter((m) => {
    if (m.status !== "active") return false;
    if (typeof m.deepbook_pool_id === "string" && m.deepbook_pool_id.length === 66) return false;
    if (m.id.startsWith("wc26-") && m.onchain_market_id) return false;
    return true;
  });
  if (candidates.length === 0) {
    return recordResult("PoolProvisioner", {
      action: "skip",
      reasoning: `No active markets without a DeepBook pool (${all.length} markets scanned).`,
    });
  }
  // Cap to MAX_PROVISIONS_PER_TICK so the per-tick SUI spend
  // stays predictable even if 50 markets are suddenly eligible.
  const queue = candidates.slice(0, MAX_PROVISIONS_PER_TICK);

  // 2. Pre-flight balance gate.
  const client = getSharedClient();
  const deepCoins = await listAllCoins(client, agentAddr, DEEP_TYPE).catch(() => []);
  const totalDeep = deepCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const suiRes = await client.getBalance({ owner: agentAddr }).catch(() => null);
  // R-WC-1.8 fix: SuiGrpcClient's `getBalance` returns
  // a nested `{ balance: { balance: string, ... } }`
  // shape (the gRPC `Balance` message). The legacy
  // JSON-RPC client returns a flat `{ totalBalance: string }`.
  // Normalize both shapes — pre-fix this read
  // `totalBalance` and always got 0 from the gRPC
  // client, which made the wallet-funding gate
  // permanently trip "NEEDS FUNDING: have 0.00 SUI"
  // even after the operator topped up the wallet.
  const totalSui = (() => {
    if (!suiRes) return 0n;
    const j = suiRes as unknown as {
      totalBalance?: string | bigint;
      balance?: { balance?: string | bigint };
    };
    const nested = j.balance?.balance;
    const flat = j.totalBalance;
    const raw = nested ?? flat;
    return BigInt((raw as string | bigint | undefined)?.toString() ?? "0");
  })();

  const requiredSui = SUI_PER_PROVISION_ATOMS * BigInt(queue.length);
  // DEEP only matters for the FIRST market on the current
  // package — subsequent markets reuse the existing pool via
  // create_market_with_pool (no DEEP fee). But because the
  // wc-creator may have already minted a market on this package,
  // we check the live on-chain count.
  const PREDICT_PKG = process.env.MARKET_PACKAGE_ID ?? process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ?? "";
  const RPC =
    process.env.SUI_RPC_URL ??
    (process.env.SUI_NETWORK === "mainnet"
      ? "https://fullnode.mainnet.sui.io:443"
      : process.env.SUI_NETWORK === "devnet"
        ? "https://fullnode.devnet.sui.io:443"
        : "https://fullnode.testnet.sui.io:443");
  let onPackageCount = 0;
  try {
    const { countMarketsWithOnchainByPackage } = await import("../markets/store.js");
    onPackageCount = await countMarketsWithOnchainByPackage(PREDICT_PKG, RPC);
  } catch {
    onPackageCount = 0;
  }
  const isFirstOnPackage = onPackageCount === 0;
  const requiredDeep = isFirstOnPackage ? POOL_CREATION_FEE_DEEP : 0n;

  if (totalSui < requiredSui || totalDeep < requiredDeep) {
    const needSui = Number(requiredSui) / 1e9;
    const haveSui = Number(totalSui) / 1e9;
    const needDeep = Number(requiredDeep) / 1e6;
    const haveDeep = Number(totalDeep) / 1e6;
    return recordResult("PoolProvisioner", {
      action: "noop",
      reasoning:
        `NEEDS FUNDING: planning to provision ${queue.length} market(s) but the agent wallet is underfunded. ` +
        `Need ${needSui.toFixed(2)} SUI (have ${haveSui.toFixed(2)})${
          requiredDeep > 0n
            ? `, need ${needDeep.toFixed(2)} DEEP for the first market's pool-creation fee (have ${haveDeep.toFixed(2)})`
            : ""
        }. ` +
        `Fund ${agentAddr} via the Sui faucet (https://faucet.sui.io/?network=testnet) for SUI ` +
        `and the testnet DEEP swap (https://deepbookv3-portal.onrender.com/) for DEEP. ` +
        `The auto-funder agent will top up DUSDC automatically once SUI + DEEP land; this agent will then mint the missing pools on the next tick.`,
      confidence: 99,
    });
  }

  // 3. Find a fresh DEEP coin (only needed for the first market).
  let feeCoinId: string | null = null;
  if (isFirstOnPackage) {
    const deepCoin = deepCoins
      .filter((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP)
      .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
    if (!deepCoin) {
      return recordResult("PoolProvisioner", {
        action: "noop",
        reasoning:
          `NEEDS FUNDING: no single DEEP coin >= ${Number(POOL_CREATION_FEE_DEEP) / 1e6} DEEP for the first market's pool-creation fee. ` +
          `The wallet has ${deepCoins.length} DEEP coins but the largest is below the threshold. ` +
          `Merge coins on-chain or fund ${agentAddr} via the testnet DEEP swap.`,
        confidence: 99,
      });
    }
    feeCoinId = deepCoin.objectId;
  }

  // 4. Provision each market sequentially. Stop the loop on
  //    ECurrencyAlreadyExists — the circuit-breaker stops
  //    subsequent attempts for the rest of the epoch.
  const { isCoinRegistryFull, tripCoinRegistryFull } = await import(
    "./wc-creator-circuit-breaker.js"
  );

  const created: string[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

  // Bypass the breaker for the very first tick of a freshly
  // bootstrapped package — if it's not yet tripped, we still
  // attempt the first provision.
  for (const m of queue) {
    if (isCoinRegistryFull()) {
      failed.push({ id: m.id, reason: "CoinRegistry circuit-breaker tripped (see /wc/circuit-breaker)" });
      break;
    }
    try {
      const expiryMs = BigInt(Math.max(Date.now() + 60 * 60 * 1000, m.expiry_ms));
      const result = await ensureMarketCreated(client, ctx.signer, process.env.DEEPBOOK_REGISTRY_ID ?? null, {
        title: m.title,
        resolutionSource: m.resolution_source || "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup",
        expiryMs,
        deepCoinId: feeCoinId ?? "",
        category: m.category === "worldcup" ? 3 : 0,
        tickSize: BigInt(1_000_000),
        lotSize: BigInt(1_000_000),
        minSize: BigInt(1_000_000),
      });
      const marketId = result.marketId;
      const poolId = result.poolId;
      // Persist the on-chain ids to the SQLite mirror.
      upsertMarket({
        ...m,
        deepbook_pool_id: poolId,
        deepbook_pool_key: m.deepbook_pool_key ?? `wc_${m.id}`,
        deepbook_base_coin_type: m.deepbook_base_coin_type ?? DUSDC_TYPE,
        deepbook_quote_coin_type: m.deepbook_quote_coin_type ?? DUSDC_TYPE,
        deepbook_base_scalar: m.deepbook_base_scalar ?? 1_000_000,
        deepbook_quote_scalar: m.deepbook_quote_scalar ?? 1_000_000,
        onchain_market_id: marketId,
      });
      created.push(`${m.id} (via ${result.source})`);
      console.log(`[pool-provisioner] ${m.id} → market=${marketId.slice(0, 10)}… pool=${poolId.slice(0, 10)}… (via ${result.source})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ECurrencyAlreadyExists/i.test(msg) || (/new_currency/i.test(msg) && /already exists/i.test(msg))) {
        tripCoinRegistryFull(m.id);
        failed.push({ id: m.id, reason: "ECurrencyAlreadyExists (circuit-breaker tripped)" });
        break;
      }
      failed.push({ id: m.id, reason: msg.slice(0, 200) });
    }
  }

  // 5. Surface the tick summary.
  const action = created.length > 0 && failed.length === 0
    ? "provisioned"
    : created.length > 0
      ? "partial"
      : failed.length > 0
        ? "noop"
        : "skip";
  const summary =
    `${created.length} provisioned, ${failed.length} failed` +
    (created.length > 0 ? `: ${created.join(", ")}` : "") +
    (failed.length > 0 ? `. Failures: ${failed.map((f) => `${f.id} (${f.reason})`).join("; ")}` : "");
  return recordResult("PoolProvisioner", {
    action,
    reasoning: summary,
    confidence: 90,
  });
}
