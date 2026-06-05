import {
  buildCreateMarketTx,
  buildMintSharesTx,
  buildRegisterMarketTx,
  buildSetupReferralTx,
  DUSDC_TYPE,
  extractCreatedObjectId,
  listAllCoins,
  yesCoinType,
} from "@suipredict/sdk";
import { DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import type { AgentContext, AgentResult } from "../lib.js";
import { callLlm, getSharedClient, recordResult } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";

// R43 audit fix: removed the module-level MAX_ACTIVE and
// INITIAL_MINT_ATOMS constants. Both are re-read at the top of
// `runMarketCreator` so an env-var hot-patch (e.g. via
// `bootstrap-env.ts`) is honored without a process restart. The
// operational ids (DEEPBOOK_REGISTRY_ID / MARKET_REGISTRY_ID /
// FEE_VAULT_ID) were also module-level; the R54 audit fix
// re-reads them at the top of `runMarketCreator` too (see
// `runMarketCreator` body) so a hot-patch via
// `bootstrap-env.ts` is honored. The `bootstrap-env.ts` flow
// does occasionally rotate `MARKET_REGISTRY_ID` and
// `FEE_VAULT_ID` (e.g. after a `devnet` → `testnet` env
// transition) and the previous module-level freeze kept the
// process publishing to the wrong registry.

/** Map the LLM's free-form category string to the gamification
 *  enum emitted on `MarketCreatedEvent.category`. The leaderboard
 *  worker filters on this code, so the mapping has to be consistent
 *  between market-creator.ts and the streak-sweeper. Currently:
 *  "crypto" → 2 (crypto price), everything else → 3 (other). The
 *  LLM's "defi" / "politics" / "sports" don't have a dedicated
 *  leaderboard bucket yet — falls through to "other". */
function categoryToCode(category: string | undefined): 0 | 1 | 2 | 3 {
  if (category === "crypto") return 2;
  return 3;
}

const FALLBACK_MARKETS = [
  {
    title: "Will ETH flip BTC market cap in 2026?",
    description: "Resolves YES if ETH market cap exceeds BTC on CoinGecko.",
    category: "crypto",
    days: 21,
    resolution_source: "CoinGecko market cap",
  },
  {
    title: "Will DeepBook V3 TVL exceed $50M by Q3?",
    description: "Resolves YES if DeepBook V3 total value locked >= $50M.",
    category: "defi",
    days: 30,
    resolution_source: "DeepBook analytics",
  },
];

interface MarketSpec {
  title: string;
  description: string;
  category: string;
  expiry_days: number;
  resolution_source: string;
}

async function proposeMarket(): Promise<{
  spec: MarketSpec;
  source: "llm" | "fallback";
  fallbackReason?: string;
}> {
  const prompt = `Propose one binary prediction market for a Polymarket-style exchange on Sui/DeepBook.
Respond ONLY with JSON: {"title":"...","description":"...","category":"crypto|politics|sports|defi","expiry_days":7-30,"resolution_source":"..."}`;

  // Reason the LLM path was skipped — recorded in the agent decision
  // and the boot health endpoint so an operator can tell at a glance
  // whether the agent is brainstorming or running on autopilot.
  if (!process.env.OPENAI_API_KEY) {
    return pickFallback("OPENAI_API_KEY not set");
  }
  const raw = await callLlm(prompt);
  if (!raw) {
    return pickFallback("LLM call returned null (network error, 4xx/5xx, or empty response)");
  }
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim()) as MarketSpec;
    if (parsed.title && parsed.expiry_days >= 1 && parsed.expiry_days <= 30) {
      return { spec: parsed, source: "llm" };
    }
    return pickFallback(`LLM JSON missing required fields: ${JSON.stringify(parsed).slice(0, 80)}`);
  } catch (e) {
    return pickFallback(`LLM JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function pickFallback(reason: string): {
  spec: MarketSpec;
  source: "fallback";
  fallbackReason: string;
} {
  const fb = FALLBACK_MARKETS[Math.floor(Math.random() * FALLBACK_MARKETS.length)]!;
  // Loud console warning so the operator sees the fallback in their
  // log stream even before checking the decision store.
  console.warn(
    `[market-creator] LLM unavailable — using FALLBACK_MARKETS. Reason: ${reason}`,
  );
  return {
    spec: {
      title: fb.title,
      description: fb.description,
      category: fb.category,
      expiry_days: fb.days,
      resolution_source: fb.resolution_source,
    },
    source: "fallback",
    fallbackReason: reason,
  };
}

export async function runMarketCreator(ctx: AgentContext): Promise<AgentResult> {
  // R43 audit fix: re-read the env-driven knobs at the top of
  // the run function rather than relying on the module-level
  // snapshot above. The bootstrap script
  // (`scripts/bootstrap-env.ts`) can rewrite
  // `MAX_ACTIVE_MARKETS` and `MARKET_CREATOR_INITIAL_MINT_ATOMS`
  // after the agents process has already imported this module
  // — a hot-restart-style update where the file is patched
  // while the worker is still running. With the previous
  // module-level `const`s, the worker kept the boot-time
  // value forever, so a 1 → 10 cap increase would have
  // required a full `pnpm --filter @suipredict/agents
  // restart` instead of just rewriting the env file.
  const maxActive = Number(process.env.MAX_ACTIVE_MARKETS ?? 5);
  const initialMintAtoms = BigInt(
    process.env.MARKET_CREATOR_INITIAL_MINT_ATOMS ?? 10_000_000,
  );
  // R54 audit fix: re-read the operational ids at function-body
  // scope. They were module-level before, which froze them at
  // import time and made a `bootstrap-env.ts` rotation
  // ineffective until the process restarted.
  const deepbookRegistryId =
    process.env.DEEPBOOK_REGISTRY_ID ??
    "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";
  const marketRegistryId = process.env.MARKET_REGISTRY_ID ?? "";
  const feeVaultId = process.env.FEE_VAULT_ID ?? "";
  const active = listMarkets().filter((m) => m.status === "active");
  if (active.length >= maxActive) {
    return recordResult("MarketCreator", {
      action: "skip",
      reasoning: `${active.length} active markets — at cap of ${maxActive}.`,
      confidence: 90,
    });
  }

  const { spec, source, fallbackReason } = await proposeMarket();
  const expiryMs = BigInt(Date.now() + spec.expiry_days * 86_400_000);
  const sourceTag =
    source === "fallback"
      ? ` [FALLBACK: ${fallbackReason ?? "unknown reason"}]`
      : " [llm]";

  if (!deepbookRegistryId) {
    // Demo mode — no on-chain
    const id = `demo-${Date.now()}`;
    upsertMarket({
      id,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Number(expiryMs),
      resolution_source: spec.resolution_source,
      status: "active",
      created_at_ms: Date.now(),
    });
    return recordResult("MarketCreator", {
      action: "demo_market",
      reasoning: `Created demo market${sourceTag}: ${spec.title}`,
      confidence: 75,
    });
  }

  const { executeTransaction } = await import("@suipredict/sdk");
  // R51 audit fix: shared gRPC client (see lib.ts).
  // The previous per-tick `createClient()` opened a
  // fresh HTTP/2 connection on every call; the SDK
  // never closed the prior ones, so the gRPC client
  // pool grew to ~60 idle connections after a few
  // minutes of polling. Use the singleton.
  const client = getSharedClient();

  try {
    // Step 1: acquire a Coin<DEEP> with enough for pool creation fee (500 DEEP)
    const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
    // R53 audit fix: paginate
    // `listCoins` via `listAllCoins`
    // (mirrors the prize-admin
    // fix). A busy agent with
    // 50+ DEEP fragments would
    // have the eligible coin
    // missed and fall through to
    // the demo-market fallback.
    const deepCoins = await listAllCoins(client, agentAddr, DEEP_TYPE);
    const deepCoin = deepCoins.find((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
    if (!deepCoin) {
      // Fall back to demo market. The previous behavior was to hard-fail
      // with `action: "no_deep"`, which left the protocol with zero
      // active markets on a fresh testnet deploy (the agent gets 0.1
      // SUI from the faucet, never 500 DEEP). Treating this as
      // "off-chain-only" keeps the UI populated with markets the
      // resolver can still act on, and the agent stays observable
      // rather than silently inert.
      console.warn(
        `[market-creator] no DEEP coin >= ${POOL_CREATION_FEE_DEEP} ` +
          `(${deepCoins.length} candidate(s) found); falling back to demo market.`,
      );
      const demoId = `demo-${Date.now()}`;
      upsertMarket({
        id: demoId,
        title: spec.title,
        description: spec.description,
        category: spec.category,
        expiry_ms: Number(expiryMs),
        resolution_source: spec.resolution_source,
        status: "active",
        created_at_ms: Date.now(),
      });
      return recordResult("MarketCreator", {
        action: "demo_market",
        reasoning:
          `No DEEP for pool creation (${deepCoins.length} candidate(s) found). ` +
          `Created demo market${sourceTag}: ${spec.title}. ` +
          `Fund the agent with 500 DEEP to enable on-chain CLOB.`,
        confidence: 60,
      });
    }

    // Step 2: create the market (includes pool creation + YES/NO coin types)
    const createTx = buildCreateMarketTx({
      title: spec.title,
      resolutionSource: spec.resolution_source,
      expiryMs,
      tickSize: BigInt(1_000_000),  // 0.001 DUSDC tick
      lotSize: BigInt(1_000_000),    // 1 YES minimum
      minSize: BigInt(1_000_000),    // 1 YES minimum
      deepCoinId: deepCoin.objectId,
      category: categoryToCode(spec.category),
    });

    const createResult = await executeTransaction(client, createTx, ctx.signer);
    const marketId = await extractCreatedObjectId(client, createResult.digest, "PredictionMarket");
    if (!marketId) throw new Error("PredictionMarket object not found in effects");

    // Step 3: setup DeepBook referral for this market's pool
    // We need the pool ID and referral ID from the market — fetch market object
    const { object } = await client.core.getObject({ objectId: marketId, include: { json: true } });
    const poolId = object?.json?.pool_id as string | undefined;
    let referralId: string | null = null;
    if (poolId) {
      const referralTx = buildSetupReferralTx(marketId, poolId, BigInt(1_000_000_000));
      const referralResult = await executeTransaction(client, referralTx, ctx.signer);
      // `extractCreatedObjectId` returns null if the struct name
      // doesn't match the suffix used by gRPC's `objectTypes[objectId]`
      // render — a typo here means `referral_id` is never persisted,
      // `referral-keeper` then skips this market forever with no
      // alert. Surface a loud warning on null so the operator can
      // grep the tx digest in SuiVision and confirm the actual
      // struct name (and update this string) before deploying.
      referralId = await extractCreatedObjectId(
        client,
        referralResult.digest,
        "DeepBookPoolReferral",
      );
      if (!referralId) {
        console.warn(
          `[market-creator] setup_referral tx ${referralResult.digest} succeeded but ` +
            `extractCreatedObjectId(..., "DeepBookPoolReferral") returned null. ` +
            `The on-chain DeepBookPoolReferral exists but its struct-name suffix ` +
            `may have changed; the row's referral_id will stay null and ` +
            `referral-keeper will skip this market. Inspect the tx in SuiVision ` +
            `and update the suffix above.`,
        );
      }
    }

    // Step 3b: register the market in the global MarketRegistry so any
    // off-chain or on-chain consumer can list all live markets. Only the
    // registry admin (this agent) may call. Silent no-op if the registry
    // id isn't configured — keeps demo/single-market environments clean.
    if (marketRegistryId) {
      try {
        const registerTx = buildRegisterMarketTx(marketRegistryId, marketId);
        await executeTransaction(client, registerTx, ctx.signer);
      } catch (regErr) {
        console.warn(
          `[market-creator] register_market failed for ${marketId}:`,
          regErr instanceof Error ? regErr.message : regErr,
        );
      }
    }

    // Step 4: seed liquidity by minting initial YES+NO shares.
    // The market's quote type is DUSDC (see `upsertMarket` below which
    // records `DUSDC_TYPE` in `deepbook_quote_coin_type`). Querying
    // DBUSDC_TYPE here — the prior behaviour — would return Mysten Labs'
    // testnet DBUSDC coins that the on-chain `mint_shares` cannot
    // accept (it expects a Coin<DUSDC>). The result was a guaranteed
    // Move abort on every fresh deploy where the agent only had DUSDC
    // minted from the VLP TreasuryCap. Skipped silently if the agent
    // has no DUSDC >= INITIAL_MINT_ATOMS.
    let initialMintDigest: string | null = null;
    if (initialMintAtoms > 0n) {
      try {
        // R53 audit fix: same
        // `listAllCoins` rationale
        // as Step 1 above.
        const dusdcCoins = await listAllCoins(client, agentAddr, DUSDC_TYPE);
        const dusdcCoin = dusdcCoins
          .filter((c) => BigInt(c.balance) >= initialMintAtoms)
          .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
        if (dusdcCoin) {
          if (!feeVaultId) {
            console.warn(
              `[market-creator] FEE_VAULT_ID not configured — skipping initial mint for ${marketId}`,
            );
          } else {
            const mintTx = buildMintSharesTx(
              marketId,
              feeVaultId,
              dusdcCoin.objectId,
              initialMintAtoms,
            );
            const mintResult = await executeTransaction(client, mintTx, ctx.signer);
            initialMintDigest = mintResult.digest;
          }
        } else {
          console.warn(
            `[market-creator] no DUSDC coin with >= ${initialMintAtoms} atoms — skipping initial mint for ${marketId}`,
          );
        }
      } catch (mintErr) {
        console.warn(
          `[market-creator] initial mint failed for ${marketId}:`,
          mintErr instanceof Error ? mintErr.message : mintErr,
        );
      }
    }

    upsertMarket({
      id: marketId,
      title: spec.title,
      description: spec.description,
      category: spec.category,
      expiry_ms: Number(expiryMs),
      resolution_source: spec.resolution_source,
      status: "active",
      pool_id: poolId ?? null,
      deepbook_pool_key: poolId ? `market_${marketId.slice(0, 8)}` : null,
      deepbook_pool_id: poolId ?? null,
      deepbook_base_coin_type: poolId ? yesCoinType() : null,
      deepbook_quote_coin_type: poolId ? DUSDC_TYPE : null,
      deepbook_base_scalar: 1_000_000,
      deepbook_quote_scalar: 1_000_000,
      referral_id: referralId,
      created_at_ms: Date.now(),
    });

    return recordResult("MarketCreator", {
      action: "create_market",
      reasoning: `On-chain market${sourceTag}: ${spec.title} (pool: ${poolId ? poolId.slice(0, 10) + "..." : "N/A"}${initialMintDigest ? ", seeded" : ", unseeded"})`,
      confidence: 85,
      txDigest: createResult.digest,
    });
  } catch (err) {
    return recordResult("MarketCreator", {
      action: "create_failed",
      reasoning: `Market creation failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}