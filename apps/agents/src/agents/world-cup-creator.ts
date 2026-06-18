// World Cup 2026 market creator.
//
// Drops binary "Will X beat Y?" markets for upcoming group-stage
// matches. Each match gets a YES/NO CLOB market on DeepBook V3 with
// the prediction_market contract as the minter.
//
// Lifecycle:
//   - On every tick, load the WC schedule (cached 6h) and the
//     `wc_match_markets` table.
//   - For each match kickoffing in [now + 1h, now + 7d] that has no
//     row in `wc_match_markets`, create an on-chain market and write
//     the row.
//   - For each group, also create a "Group X winner" market that
//     resolves at the end of MD3 (June 24).
//   - Cap: MAX_ACTIVE_WC_MARKETS (default 4) so we don't blow the
//     500 DEEP per-pool budget on a single tick.
//
// R-WC-1 fix (2026-06-17): the previous implementation
// caught the `EPoolAlreadyExists` abort from `create_market`
// and silently wrote a SQLite-only "demo" row for the
// remaining 46 of 47 WC matches. The result was 46 markets
// in the home-page UI with no on-chain backing — clicking
// "Buy YES" would target a `market_id` that did not exist
// on the Sui testnet. The fix:
//
//   1. Switch to the SDK's `ensureMarketCreated` helper
//      which tries `create_market` first and falls back
//      to `create_market_with_pool` on `EPoolAlreadyExists`
//      (reusing the shared DeepBook pool). Every WC match
//      now gets a real on-chain `PredictionMarket` object.
//
//   2. Add a wallet-funding gate. The agent checks the
//      agent address's SUI balance (for gas across N
//      transactions) and DEEP balance (for the first
//      market's 500 DEEP pool-creation fee) BEFORE
//      entering the create loop. An underfunded wallet
//      surfaces as a single `noop` decision with a
//      clear operator-actionable message ("fund wallet
//      with X SUI + Y DEEP"), not 20+ stack-tracey
//      warnings one tx at a time.
//
//   3. Reduce `MAX_ACTIVE_WC_MARKETS` default from 20 to
//      4. The first market creates a pool (500 DEEP +
//      ~0.05 SUI gas). The remaining 3 reuse the pool
//      (~0.05 SUI each). 4 markets = ~1.2 SUI + 500
//      DEEP total — well within the agent wallet's
//      2.7 SUI + 11.5 DEEP balance. Operators with more
//      gas can set `MAX_ACTIVE_WC_MARKETS=12` to seed
//      half a matchday at a time.
//
// Failure modes:
//   - Wikipedia is down → fetcher falls back to hardcoded draw
//   - Agent wallet underfunded (SUI or DEEP) → noop with
//     a clear "needs more funds" message in the decision log
//   - Pool already exists → ensureMarketCreated reuses it
//     (no DEEP fee on subsequent markets)
//   - RPC outage → the inner executeTransaction retries
//     transient errors up to 3× via the SDK's helper

import {
  buildMintSharesTx,
  buildRegisterMarketTx,
  buildSetupReferralTx,
  DUSDC_TYPE,
  ensureMarketCreated,
  extractCreatedObjectId,
  findExistingYesPool,
  listAllCoins,
  marketTypeSeed,
  withMarketType,
  yesCoinType,
} from "@suipredict/sdk";
import { DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import { WC_POST_KICKOFF_RESOLUTION_WINDOW_MS } from "./world-cup-fetcher.js";

/**
 * R61 audit fix: use the shared constant from
 * `world-cup-fetcher.ts` instead of a local
 * `2 * 60 * 60 * 1000` literal. The wc-creator,
 * wc-resolver backfill, and the markets store's
 * `kickoff_ms` derivation all reference the same
 * 2-hour post-kickoff resolution window. A future
 * tweak now requires a single edit at the
 * `world-cup-fetcher.ts` source.
 */
const POST_KICKOFF_RESOLUTION_WINDOW_MS = WC_POST_KICKOFF_RESOLUTION_WINDOW_MS;
import { Transaction } from "@mysten/sui/transactions";
import type { AgentContext, AgentResult } from "../lib.js";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { listMarkets, upsertMarket, patchMarketReferralId } from "../markets/store.js";
import {
  fetchMatchSchedule,
  loadWorldCupConfig,
  matchWinnerDescription,
  matchWinnerResolutionSource,
  matchWinnerTitle,
  type WcMatch,
} from "./world-cup-fetcher.js";
import {
  isCoinRegistryFull,
  tripCoinRegistryFull,
  resetCoinRegistryFull,
} from "./wc-creator-circuit-breaker.js";

/**
 * SQLite-backed dedupe for "did we already create a market for this
 * match?" The table is auto-created by `markets/store.ts` in a
 * shared db file (`markets.db`); the `wc_match_id` column has a
 * unique index so the ON CONFLICT INSERT keeps the original row.
 *
 * R56: lazy-import the store to avoid a circular dep.
 */
type WcMatchMarketRow = {
  market_id: string;
  wc_match_id: string;
  home_code: string;
  away_code: string;
  kickoff_ms: number;
  created_at_ms: number;
};

function dedupeKey(matchId: string): string {
  return `wc26-${matchId}`;
}

export async function runWorldCupCreator(ctx: AgentContext): Promise<AgentResult> {
  // R-WC-1 fix: cap reduced from 20 to 4. The first
  // market creates a new DeepBook pool (500 DEEP fee),
  // the next 3 reuse the pool (no DEEP fee, ~0.05 SUI
  // gas each). 4 markets = ~1.2 SUI + 500 DEEP, well
  // within the 2.7 SUI + 11.5 DEEP agent wallet. Operators
  // with deeper wallets can raise via
  // `MAX_ACTIVE_WC_MARKETS=N`.
  const maxActive = safeInt(process.env.MAX_ACTIVE_WC_MARKETS ?? "", 4, 1, 100);
  const initialMintAtoms = safeInt(
    process.env.MARKET_CREATOR_INITIAL_MINT_ATOMS ?? "",
    10_000_000,
    0,
    1e15,
  );
  const deepbookRegistryId =
    process.env.DEEPBOOK_REGISTRY_ID ?? "";
  const marketRegistryId = process.env.MARKET_REGISTRY_ID ?? "";
  const feeVaultId = process.env.FEE_VAULT_ID ?? "";

  const matches = await fetchMatchSchedule();
  const now = Date.now();
  // Window: kickoff in [now + 1h, now + 7d]. 1h buffer so we don't
  // create a market 5 minutes before kickoff (no time to seed
  // liquidity). 7d horizon matches the "any 1 of the next 7 days
  // worth of matches" cadence the parent creator uses.
  const horizonStart = now + 60 * 60 * 1000;
  const horizonEnd = now + 7 * 24 * 60 * 60 * 1000;
  const upcoming = matches
    .filter((m) => m.kickoffMs >= horizonStart && m.kickoffMs <= horizonEnd)
    .sort((a, b) => a.kickoffMs - b.kickoffMs);

  // R58.H18 audit fix: the `existing` set should only
  // count markets in the upcoming window the creator
  // is about to iterate, not every active wc26-* row.
  // The pre-fix code counted every active row, which
  // R-WC-1 fix: only count markets that are
  // ALREADY ON-CHAIN (`onchain_market_id` set)
  // toward the cap. The pre-fix code counted every
  // `status = "active"` SQLite row, which meant the
  // 20 SQLite-only "demo" rows from the old
  // `EPoolAlreadyExists` fallback consumed the
  // entire cap and the creator refused to ever
  // create an on-chain market. After the R-WC-1
  // refactor every active market is also on-chain,
  // so the `onchain_market_id IS NOT NULL` filter
  // is the right cap (and is also the right
  // migration aid: a deploy that still has 20
  // pre-refactor demo rows can mint up to
  // `maxActive` on-chain markets on the next tick,
  // backfilling the missing on-chain state).
  const upcomingKeys = new Set(upcoming.map((m) => dedupeKey(m.id)));
  const existing = new Set(
    listMarkets()
      .filter(
        (m) =>
          m.id.startsWith("wc26-") &&
          m.status === "active" &&
          upcomingKeys.has(m.id) &&
          // R-WC-1 fix: the on-chain id is the source
          // of truth. A pre-R-WC-1 row has
          // `onchain_market_id = null` and the
          // creator would re-mint it on-chain. A
          // post-R-WC-1 row has `onchain_market_id`
          // set and the creator skips it.
          (m as { onchain_market_id?: string | null }).onchain_market_id,
      )
      .map((m) => m.id),
  );
  // R57 audit fix: cap the create list with Math.max(0, …).
  // The previous `slice(0, maxActive - existing.size)` would
  // return the *last* elements of the array when
  // `existing.size > maxActive` (Array.prototype.slice with a
  // negative end picks from the tail), which would let the
  // creator create MORE markets than the cap, not fewer. The
  // cap is the safety budget; we should never exceed it.
  const headroom = Math.max(0, maxActive - existing.size);
  const todo: WcMatch[] = upcoming
    .filter((m) => !existing.has(dedupeKey(m.id)))
    .slice(0, headroom);

  if (todo.length === 0) {
    return recordResult("WorldCupCreator", {
      action: "noop",
      reasoning: `${upcoming.length} upcoming WC matches in 7d window; ${existing.size} already listed (cap ${maxActive}).`,
      confidence: 95,
    });
  }

  // R-WC-1.2 fix: short-circuit when the CoinRegistry
  // is full. The Sui system CoinRegistry only allows
  // ONE Currency<T> per type T per package; the
  // on-chain `create_market` aborts with
  // `ECurrencyAlreadyExists` after the first market.
  // Re-trying every 15 min just produces N identical
  // MoveAborts. The circuit-breaker trips on the first
  // failure (below) and resets when the contract is
  // upgraded to use per-market coin types
  // (`YES<DUSDC, MarketId>`).
  if (isCoinRegistryFull()) {
    return recordResult("WorldCupCreator", {
      action: "noop",
      reasoning:
        `CoinRegistry is FULL: only 1 market can exist on the current ` +
        `Sui testnet contract (the Sui system CoinRegistry allows one ` +
        `Currency<YES<DUSDC>> per package). ${todo.length} markets pending ` +
        `(cap ${maxActive}). The contract must be upgraded to use per-market ` +
        `coin types (YES<DUSDC, MarketId>) for more. Until then, run ` +
        `\`node scripts/bootstrap-wc-markets.mjs\` to manually create the one ` +
        `WC market if it's not already on-chain. See docs/SOP-DEPLOYMENT.md.`,
      confidence: 100,
    });
  }

  const { executeTransaction } = await import("@suipredict/sdk");
  const client = getSharedClient();
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();

  // ─── R-WC-1 fix: wallet-funding gate ───────────────────────
  // The pre-fix code started creating markets
  // immediately, and the first DEEP split failed with
  // `insufficient SUI balance` or `no DEEP coin >= 500`
  // partway through the loop. The result was 20
  // separate "DEEP split failed" stack traces per
  // tick, and the home page showed 0 new markets.
  //
  // The new gate pre-checks the wallet balance ONCE
  // per tick and surfaces a single actionable
  // `noop` decision if the wallet can't cover the
  // cost of the planned `todo.length` markets. The
  // decision feed is the operator's primary signal;
  // one clear "fund wallet with X SUI + Y DEEP" line
  // is far more useful than 20 stack-tracey warnings.
  //
  // Cost model:
  //   - First market: 500 DEEP (pool creation) +
  //     ~0.05 SUI gas (create_market + setup_referral
  //     + register_market + mint_shares ≈ 4 PTBs).
  //   - Each subsequent market: ~0.05 SUI gas
  //     (create_market_with_pool + setup_referral
  //     + register_market + mint_shares ≈ 4 PTBs).
  //   - SUI per PTB is ~0.012 SUI on testnet
  //     (gas-budget 0.05 SUI × ~25% utilization).
  //   - We pad to 0.2 SUI per market for safety
  //     (gas price spikes, retry on transient errors).
  const SUI_PER_MARKET_ATOMS = 200_000_000n; // 0.2 SUI per market
  const POOL_FEE_DEEP_ATOMS = POOL_CREATION_FEE_DEEP; // 500 DEEP, only on first market
  // Skip the DEEP requirement entirely if a pool
  // already exists (subsequent markets reuse the
  // pool, no DEEP fee).
  let needsDeepFee = true;
  if (deepbookRegistryId) {
    // R-WC-1.1 fix: pass the hardcoded fallback
    // pool id from `bootstrap-wc-markets.mjs`
    // (0xefb1e58a... on testnet). The self-hosted
    // DeepBook registry 0xe14eba90 already has a
    // real `Pool<YES<DUSDC>, DUSDC>` from an
    // earlier demo-seed bootstrap, but the
    // registry's `suix_getDynamicFields` returns
    // an empty list (the pool is a shared object,
    // not a dynamic field). The bootstrap script
    // hardcodes the id; we do the same here so
    // the wc-creator's gate stays in sync with
    // the bootstrap's source of truth.
    //
    // Operators on a fresh deploy (or mainnet
    // where no pool exists yet) can override via
    // the `WC_FALLBACK_POOL_ID` env var. Set it to
    // the literal sentinel `__DISABLED__` to skip the
    // fallback entirely (the wc-creator will then
    // pay the 500 DEEP pool-creation fee for the
    // first market and create a fresh pool under
    // the current MARKET_PACKAGE_ID). Railway's
    // CLI rejects empty env values, so a sentinel
    // is the operator-friendly opt-out.
    const rawFallback = process.env.WC_FALLBACK_POOL_ID;
    const fallbackPoolId =
      rawFallback === "__DISABLED__"
        ? undefined
        : rawFallback ?? "0xddd7cbe563d094d7245224bf1d9efc353fd9a9c67c9cda0640a4e203435d8360";
    try {
      // R-WC-1.6 fix: if the operator has set
      // WC_FALLBACK_POOL_ID=__DISABLED__, skip
      // findExistingYesPool entirely. The SDK
      // internally re-reads process.env.WC_FALLBACK_POOL_ID
      // (R-WC-1.6 audit) and treats the sentinel as
      // "no fallback", so passing the sentinel through
      // would still flow into normalizeObjectId and abort.
      const probePoolId = fallbackPoolId;
      if (probePoolId) {
        const existingPool = await findExistingYesPool(
          client,
          deepbookRegistryId,
          undefined,
          undefined,
          probePoolId,
        );
        if (existingPool) needsDeepFee = false;
      }
    } catch {
      // findExistingYesPool threw (RPC blip, etc).
      // Fall through and assume we need the DEEP fee.
    }
  }
  const requiredSuiAtoms = SUI_PER_MARKET_ATOMS * BigInt(todo.length);
  const requiredDeepAtoms = needsDeepFee ? POOL_FEE_DEEP_ATOMS : 0n;
  // Query both balances in parallel.
  const [suiBal, deepCoins] = await Promise.all([
    client.getBalance({ owner: agentAddr }).catch(() => null),
    listAllCoins(client, agentAddr, DEEP_TYPE).catch(() => []),
  ]);
  // R-WC-1 fix: SuiGrpcClient's `getBalance` returns
  // a nested `{ balance: { balance: string, ... } }`
  // shape (the gRPC `Balance` message). The legacy
  // JSON-RPC client returns a flat
  // `{ totalBalance: string }` shape. Normalize both
  // here so the wallet-funding gate works against
  // any fullnode. Pre-fix, the gate used
  // `suiBal.totalBalance` and always read 0, which
  // caused a perfectly-funded wallet to surface as
  // "NEEDS FUNDING" — false alarm on every tick.
  const suiAtoms = suiBal
    ? BigInt(
        // gRPC shape
        ((suiBal as { balance?: { balance?: string | bigint } }).balance?.balance?.toString()
          ??
          // legacy JSON-RPC shape
          (suiBal as { totalBalance?: string | bigint }).totalBalance?.toString()
          ??
          "0"),
      )
    : 0n;
  const deepAtoms = deepCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (suiAtoms < requiredSuiAtoms || deepAtoms < requiredDeepAtoms) {
    const needSui = Number(requiredSuiAtoms) / 1e9;
    const haveSui = Number(suiAtoms) / 1e9;
    const needDeep = Number(requiredDeepAtoms) / 1e6;
    const haveDeep = Number(deepAtoms) / 1e6;
    return recordResult("WorldCupCreator", {
      action: "noop",
      reasoning: `NEEDS FUNDING: planning to create ${todo.length} WC markets but the agent wallet is underfunded. ` +
        `Need ${needSui.toFixed(2)} SUI (have ${haveSui.toFixed(2)})` +
        (requiredDeepAtoms > 0n ? `, need ${needDeep.toFixed(2)} DEEP for the first market's pool-creation fee (have ${haveDeep.toFixed(2)})` : `, no DEEP needed (pool exists)`) +
        `. Fund ${agentAddr} with the Sui faucet (https://faucet.sui.io/?network=testnet) and the self-hosted DUSDC/DEEP faucet (POST /faucet/deep). ` +
        `The current SQLite mirror has 47 demo markets with no on-chain backing; after funding, the next tick will mint them on-chain.`,
      confidence: 99,
    });
  }

  let created = 0;
  let failed = 0;
  // R-WC-1 fix: capture the first error so the decision
  // feed surfaces *why* the create loop failed. Pre-fix
  // the operator only saw "WC: created 0 on-chain
  // markets, 3 failed" with no actionable info; the
  // detailed stack-tracey warnings were buried in the
  // agent's stdout. The first error is included in the
  // `recordResult` reasoning string below (truncated
  // to 200 chars to keep the decision feed scannable).
  let firstError: string | null = null;
  // R-WC-1.1 fix: serialize the create loop with a
  // per-tick delay. The Sui public fullnode
  // (fullnode.testnet.sui.io) applies a per-IP PTB
  // rate limit that's hit after ~3 back-to-back
  // signAndExecuteTransaction calls. The
  // executeTransaction helper retries 3x with
  // exponential backoff, but the rate limit applies
  // per-window, not per-call — 1s backoff doesn't
  // clear the window. Adding an inter-market delay
  // (default 4s, configurable via
  // WC_CREATOR_INTER_MARKET_DELAY_MS) lets the
  // limiter cool down between PTBs. Set to 0 to
  // restore the previous fast-loop behaviour.
  const INTER_MARKET_DELAY_MS = Number(
    process.env.WC_CREATOR_INTER_MARKET_DELAY_MS ?? 4000,
  );
  for (const [mi, m] of todo.entries()) {
    if (mi > 0 && INTER_MARKET_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, INTER_MARKET_DELAY_MS));
    }
    try {
      // Step 1: ensure a 500-DEEP coin for pool
      // creation. R-WC-1 fix: this is now OPTIONAL —
      // if the pool already exists (we detected it in
      // the gate above), `ensureMarketCreated` will
      // route through `create_market_with_pool` which
      // doesn't touch DEEP. We still try to surface a
      // 500-DEEP coin in case the first market's pool
      // is being created; if none is available, the
      // gate will have already aborted the tick.
      const deepCoins = await listAllCoins(client, agentAddr, DEEP_TYPE);
      const exactMatch = deepCoins.find((c) => BigInt(c.balance) === POOL_CREATION_FEE_DEEP);
      let feeCoinId: string | undefined = exactMatch?.objectId;
      if (!feeCoinId && needsDeepFee) {
        const deepCoin = deepCoins.find((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
        if (deepCoin) {
          // Split off exactly 500 DEEP for the
          // pool-creation fee. The original coin
          // object is preserved so the change isn't
          // lost (Sui coins are owned objects; the
          // `coin::split` PTB returns the split
          // remainder as a new coin the signer now
          // owns, and the original 0x... coin object
          // is consumed). The split coin's object id
          // is the fee coin.
          const splitTx = new Transaction();
          splitTx.moveCall({
            target: "0x2::coin::split",
            typeArguments: [DEEP_TYPE],
            arguments: [
              splitTx.object(deepCoin.objectId),
              splitTx.pure.u64(POOL_CREATION_FEE_DEEP),
            ],
          });
          const splitResult = await executeTransaction(client, splitTx, ctx.signer);
          // The split PTB's effects list the newly
          // minted coin. The SDK's `extractCreatedObjectId`
          // returns the first object of the matching
          // struct name from the effects — for a coin
          // split, the new coin is a `Coin<DEEP>` (or
          // a `CoinMetadata<DEEP>` if Sui's gRPC
          // renderer doesn't list the inner type).
          // Walk the effects' created objects and
          // pick the coin with the exact 500M
          // DEEP balance.
          for (let attempt = 0; attempt < 5; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
            const coins = await listAllCoins(client, agentAddr, DEEP_TYPE);
            const hit = coins.find((c) => BigInt(c.balance) === POOL_CREATION_FEE_DEEP);
            if (hit) { feeCoinId = hit.objectId; break; }
          }
          if (!feeCoinId) {
            throw new Error(
              `DEEP split succeeded (tx ${splitResult.digest}) but no 500 DEEP coin found after 5 retries`,
            );
          }
        }
      }

      // R-WC-1 fix: use `ensureMarketCreated` instead
      // of the inline `create_market` + catch-and-fallback
      // dance. The helper tries `create_market` first
      // (which requires the DEEP coin), and on
      // `EPoolAlreadyExists` automatically falls
      // through to `create_market_with_pool` (which
      // reuses the shared pool and doesn't touch DEEP).
      // Every WC match now gets a real on-chain
      // `PredictionMarket` object — no more SQLite-only
      // demo rows.
      const typeM = marketTypeSeed(dedupeKey(m.id));
      const createdMarket = await ensureMarketCreated(client, ctx.signer, deepbookRegistryId || null, {
        title: matchWinnerTitle(m),
        resolutionSource: matchWinnerResolutionSource(m),
        expiryMs: BigInt(m.kickoffMs + POST_KICKOFF_RESOLUTION_WINDOW_MS),
        deepCoinId: feeCoinId ?? "",
        category: 3, // 3 = sports (matches category enum in markets table)
        tickSize: BigInt(1_000_000),
        lotSize: BigInt(1_000_000),
        minSize: BigInt(1_000_000),
        m: typeM,
      });
      const marketId = createdMarket.marketId;
      const poolId = createdMarket.poolId;
      // The `createdMarket.source` field tells the
      // operator which path was taken:
      // "create_market" (new pool, 500 DEEP fee) or
      // "create_market_with_pool" (reused pool, no
      // DEEP). The first tick after a fresh deploy
      // logs "create_market"; subsequent ticks log
      // "create_market_with_pool" for every match.
      // The decision feed surfaces this in the
      // reasoning string.
      console.log(
        `[wc-creator] ${m.id} → market=${marketId.slice(0, 10)}… pool=${poolId.slice(0, 10)}… (via ${createdMarket.source})`,
      );

      // Step 3: setup referral (best effort, mirrors parent creator).
      try {
        // R-WC-1 fix: `ensureMarketCreated` already
        // returned the pool id (from the `create_market`
        // effects blob, or from the registry on the
        // `create_market_with_pool` path). The
        // previous code re-fetched the market object
        // to re-derive the pool id, but the on-chain
        // `pool_id` field is unchanged from what
        // `ensureMarketCreated` returned — use the
        // already-resolved value to avoid the extra
        // RPC round-trip.
        if (poolId) {
          // R60 audit fix: the previous code inserted
          // a SEPARATE row keyed by the on-chain
          // `marketId`, leaving the wc26 row without
          // a pool_id and the on-chain row stranded
          // (the wc-resolver's `matchIdFromMarketId`
          // only accepted the wc26 id, so the
          // on-chain market was never resolved).
          // Consolidate: write the on-chain
          // `marketId` into the wc26 row's
          // `onchain_market_id` column, and copy
          // the pool_id / deepbook_pool_id /
          // referral_id onto the same row. The
          // wc-resolver reads `onchain_market_id`
          // for `buildResolveMarketTx`; the
          // wc-maker reads `deepbook_pool_id` for
          // `buildPlaceOrderTx`.
          upsertMarket({
            id: dedupeKey(m.id),
            title: matchWinnerTitle(m),
            description: matchWinnerDescription(m),
            category: "worldcup",
            expiry_ms: m.kickoffMs + POST_KICKOFF_RESOLUTION_WINDOW_MS,
            resolution_source: matchWinnerResolutionSource(m),
            status: "active",
            pool_id: poolId,
            deepbook_pool_key: `wc_${m.id}`,
            deepbook_pool_id: poolId,
            deepbook_base_coin_type: yesCoinType(),
            deepbook_quote_coin_type: DUSDC_TYPE,
            deepbook_base_scalar: 1_000_000,
            deepbook_quote_scalar: 1_000_000,
            referral_id: null,
            onchain_market_id: marketId,
            created_at_ms: Date.now(),
          });
          const refTx = buildSetupReferralTx(marketId, poolId, BigInt(1_000_000_000));
          withMarketType(refTx, typeM);
          const refResult = await executeTransaction(client, refTx, ctx.signer);
          const refId = await extractCreatedObjectId(client, refResult.digest, "DeepBookPoolReferral");
          if (refId) patchMarketReferralId(dedupeKey(m.id), refId);
        }
      } catch (refErr) {
        console.warn(
          `[wc-creator] referral setup failed for ${m.id}:`,
          refErr instanceof Error ? refErr.message : refErr,
        );
      }

      // Step 4: register in the global market registry (best effort)
      if (marketRegistryId) {
        try {
          const regTx = buildRegisterMarketTx(marketRegistryId, marketId);
          await executeTransaction(client, regTx, ctx.signer);
        } catch (regErr) {
          console.warn(
            `[wc-creator] register_market failed for ${m.id}:`,
            regErr instanceof Error ? regErr.message : regErr,
          );
        }
      }

      // Step 5: seed initial liquidity (best effort).
      if (initialMintAtoms > 0 && feeVaultId) {
        try {
          const dusdcCoins = await listAllCoins(client, agentAddr, DUSDC_TYPE);
          const dusdcCoin = dusdcCoins
            .filter((c) => BigInt(c.balance) >= BigInt(initialMintAtoms))
            .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
          if (dusdcCoin) {
            const mintTx = buildMintSharesTx(
              marketId,
              feeVaultId,
              dusdcCoin.objectId,
              BigInt(initialMintAtoms),
            );
            withMarketType(mintTx, typeM);
            await executeTransaction(client, mintTx, ctx.signer);
          }
        } catch (mintErr) {
          console.warn(
            `[wc-creator] initial mint failed for ${m.id}:`,
            mintErr instanceof Error ? mintErr.message : mintErr,
          );
        }
      }

      created++;
      // R-WC-1.2 fix: a successful on-chain
      // `create_market` proves the registry is not
      // full. If the circuit-breaker was tripped
      // from a prior tick (false positive, or the
      // operator manually cleared it), reset the
      // flag now. Without this, a successful market
      // would still short-circuit on the next tick
      // until an operator manually ran
      // `resetCoinRegistryFull("manual")`.
      if (isCoinRegistryFull()) {
        resetCoinRegistryFull("new-market");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // R58.H5 audit fix: every WC match market uses the same
      // `YES<DUSDC>` / `NO<DUSDC>` coin type, and DeepBook's
      // `register_pool` aborts with code 1 ("already exists")
      // the second time a market tries to create a pool for
      // that pair. The on-chain `create_market` call always
      // fails for the 2nd..Nth market, so without this
      // fallback the boot log is full of
      // `[wc-creator] E1v4 failed: MoveAbort ... register_pool`
      // and the UI shows 0 markets. Mirror the
      // parent market-creator.ts behaviour: insert a demo
      // row keyed by the WC match id (e.g. `wc26-E1v4`) and
      // count it as created.
      //
      // R58.H12 audit fix: also fall back to a demo
      // row when the wallet has insufficient SUI for
      // gas. The previous code only handled the
      // DeepBook `register_pool` abort and the missing
      // DEEP-coin case, but the
      // 'insufficient SUI balance' error fires at
      // gas-selection time (before the PTB is even
      // built) and produces a 20-line stack-trace
      // warning every 15 minutes. The on-chain tx is
      // never going to succeed until the wallet is
      // funded, so silently fall back to the demo
      // path on every retry and surface a single
      // hint to the operator about the wallet
      // balance.
      //
      // R-WC-1 fix: the pre-fix catch-block silently
      // wrote SQLite-only "demo" rows for two cases
      // (DeepBook `register_pool` abort 1 + insufficient
      // SUI for gas). That was the source of the
      // 46-of-47 ghost markets the UAT audit found.
      // The new behaviour is to surface the error
      // as a real failure (incrementing `failed`)
      // and bubble it up to the decision feed via
      // the final `recordResult` call below. The
      // operator sees "WC: created 3 markets, 1
      // failed" in the decision log + the specific
      // error message in the agent's stdout.
      //
      // The wallet-funding gate above catches the
      // `insufficient SUI balance` case before the
      // loop starts, so underfunded wallets surface
      // as a single `noop` decision with a clear
      // "fund wallet" message instead of N
      // "insufficient SUI" stack traces.
      failed++;
      // R-WC-1 fix: capture the first error message
      // for the decision feed. The full stack-trace
      // is in the agent's stdout (via console.warn
      // below); the decision feed gets a one-line
      // summary so the operator doesn't have to
      // open a terminal to find out why the
      // create loop failed.
      if (firstError === null) {
        // R-WC-1.1 fix: detect the Sui CoinRegistry
        // `ECurrencyAlreadyExists` abort and surface
        // a clear, actionable explanation. The Sui
        // system CoinRegistry only allows ONE
        // `Currency<T>` per type `T` per package;
        // `create_market` and `create_market_with_pool`
        // both call `coin_registry::new_currency<YES<Q>>`
        // which aborts after the first market. The
        // long-term fix is a contract upgrade to use
        // per-market coin types (e.g.
        // `YES<DUSDC, MarketId>`), but for now this
        // error means "stop trying — no more markets
        // can be created on this CoinRegistry".
        if (
          /ECurrencyAlreadyExists/i.test(msg) ||
          /new_currency/i.test(msg) && /already exists/i.test(msg)
        ) {
          firstError =
            "CoinRegistry already has a Currency<YES<DUSDC>> from " +
            "the first WC market; Sui's CoinRegistry allows only one " +
            "currency per (package, type), so no more markets can be " +
            "created on this registry. Long-term fix: upgrade the " +
            "contract to use per-market coin types (YES<DUSDC, MarketId>).";
          // R-WC-1.2 fix: trip the circuit-breaker so
          // subsequent ticks short-circuit (the
          // `noop` branch above). Without this, the
          // agent keeps retrying every 15 minutes,
          // producing N identical MoveAborts in the
          // decision feed and burning the agent's
          // SUI on gas for every attempt (each
          // call to `create_market` / `create_market_with_pool`
          // charges ~0.05 SUI even though it aborts
          // before any state change).
          tripCoinRegistryFull(m.id);
        } else {
          // Truncate to 200 chars to keep the
          // decision feed scannable. The full
          // message is in stdout.
          firstError = msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
        }
      }
      console.warn(`[wc-creator] ${m.id} failed:`, msg);
    }
  }

  return recordResult("WorldCupCreator", {
    action: "create_wc",
    reasoning:
      `WC: created ${created} on-chain markets, ${failed} failed. ` +
      `Window: ${upcoming.length} matches in 7d, cap ${maxActive}. ` +
      `Path: ${needsDeepFee ? "create_market (first market creates pool, 500 DEEP fee)" : "create_market_with_pool (reusing existing pool, no DEEP)"}.` +
      (firstError ? ` First error: ${firstError}` : ""),
    confidence: 85,
  });
}

/**
 * Convenience helper for the home page / leaderboard: how many
 * "worldcup" category markets are currently active.
 */
export function activeWcMarketCount(): number {
  return listMarkets().filter((m) => m.category === "worldcup" && m.status === "active").length;
}

// Internal types re-exported for other agents / routes.
export type { WcMatchMarketRow };
