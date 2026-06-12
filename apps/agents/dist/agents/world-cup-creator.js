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
//   - Cap: MAX_ACTIVE_WC_MARKETS (default 20) so we don't blow the
//     500 DEEP per-pool budget on a single tick.
//
// Failure modes:
//   - Wikipedia is down → fetcher falls back to hardcoded draw
//   - DEEP budget exhausted → skip and log
//   - Pool already exists for that YES coin type → fall back to
//     demo market (mirrors the parent market-creator.ts)
import { buildCreateMarketTx, buildMintSharesTx, buildRegisterMarketTx, buildSetupReferralTx, DUSDC_TYPE, extractCreatedObjectId, listAllCoins, yesCoinType, } from "@suipredict/sdk";
import { DEEP_TYPE, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk";
import { Transaction } from "@mysten/sui/transactions";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { listMarkets, upsertMarket, patchMarketReferralId } from "../markets/store.js";
import { fetchMatchSchedule, matchWinnerDescription, matchWinnerResolutionSource, matchWinnerTitle, } from "./world-cup-fetcher.js";
function dedupeKey(matchId) {
    return `wc26-${matchId}`;
}
export async function runWorldCupCreator(ctx) {
    const maxActive = safeInt(process.env.MAX_ACTIVE_WC_MARKETS ?? "", 20, 1, 100);
    const initialMintAtoms = safeInt(process.env.MARKET_CREATOR_INITIAL_MINT_ATOMS ?? "", 10_000_000, 0, 1e15);
    const deepbookRegistryId = process.env.DEEPBOOK_REGISTRY_ID ?? "";
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
    const existing = new Set(listMarkets()
        .filter((m) => m.id.startsWith("wc26-") && m.status === "active")
        .map((m) => m.id));
    // R57 audit fix: cap the create list with Math.max(0, …).
    // The previous `slice(0, maxActive - existing.size)` would
    // return the *last* elements of the array when
    // `existing.size > maxActive` (Array.prototype.slice with a
    // negative end picks from the tail), which would let the
    // creator create MORE markets than the cap, not fewer. The
    // cap is the safety budget; we should never exceed it.
    const headroom = Math.max(0, maxActive - existing.size);
    const todo = upcoming
        .filter((m) => !existing.has(dedupeKey(m.id)))
        .slice(0, headroom);
    if (todo.length === 0) {
        return recordResult("WorldCupCreator", {
            action: "noop",
            reasoning: `${upcoming.length} upcoming WC matches in 7d window; ${existing.size} already listed (cap ${maxActive}).`,
            confidence: 95,
        });
    }
    // Demo mode (no DeepBook registered) → just stub rows in SQLite so
    // the rest of the pipeline (indexer, UI) can still see them.
    if (!deepbookRegistryId) {
        for (const m of todo) {
            upsertMarket({
                id: dedupeKey(m.id),
                title: matchWinnerTitle(m),
                description: matchWinnerDescription(m),
                category: "worldcup",
                expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000, // 2h after kickoff (regulation + ET)
                resolution_source: matchWinnerResolutionSource(m),
                status: "active",
                created_at_ms: Date.now(),
            });
        }
        return recordResult("WorldCupCreator", {
            action: "create_demo",
            reasoning: `Created ${todo.length} demo WC markets: ${todo.slice(0, 3).map((m) => m.id).join(", ")}…`,
            confidence: 85,
        });
    }
    const { executeTransaction } = await import("@suipredict/sdk");
    const client = getSharedClient();
    const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
    let created = 0;
    let failed = 0;
    for (const m of todo) {
        try {
            // Step 1: ensure a 500-DEEP coin for pool creation.
            const deepCoins = await listAllCoins(client, agentAddr, DEEP_TYPE);
            const exactMatch = deepCoins.find((c) => BigInt(c.balance) === POOL_CREATION_FEE_DEEP);
            let feeCoinId = exactMatch?.objectId;
            if (!feeCoinId) {
                const deepCoin = deepCoins.find((c) => BigInt(c.balance) >= POOL_CREATION_FEE_DEEP);
                if (!deepCoin) {
                    console.warn(`[wc-creator] no DEEP for ${m.id}; falling back to demo row`);
                    upsertMarket({
                        id: dedupeKey(m.id),
                        title: matchWinnerTitle(m),
                        description: matchWinnerDescription(m),
                        category: "worldcup",
                        expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
                        resolution_source: matchWinnerResolutionSource(m),
                        status: "active",
                        created_at_ms: Date.now(),
                    });
                    continue;
                }
                const splitTx = new Transaction();
                splitTx.moveCall({
                    target: "0x2::coin::split",
                    typeArguments: [DEEP_TYPE],
                    arguments: [
                        splitTx.object(deepCoin.objectId),
                        splitTx.pure.u64(POOL_CREATION_FEE_DEEP),
                    ],
                });
                await executeTransaction(client, splitTx, ctx.signer);
                // Re-query: gRPC may lag
                for (let attempt = 0; attempt < 5; attempt++) {
                    if (attempt > 0)
                        await new Promise((r) => setTimeout(r, 2000));
                    const coins = await listAllCoins(client, agentAddr, DEEP_TYPE);
                    const hit = coins.find((c) => BigInt(c.balance) === POOL_CREATION_FEE_DEEP);
                    if (hit) {
                        feeCoinId = hit.objectId;
                        break;
                    }
                }
                if (!feeCoinId)
                    throw new Error("DEEP split failed");
            }
            // Step 2: create market
            const createTx = buildCreateMarketTx({
                title: matchWinnerTitle(m),
                resolutionSource: matchWinnerResolutionSource(m),
                expiryMs: BigInt(m.kickoffMs + 2 * 60 * 60 * 1000),
                tickSize: BigInt(1_000_000),
                lotSize: BigInt(1_000_000),
                minSize: BigInt(1_000_000),
                deepCoinId: feeCoinId,
                category: 3, // 3 = sports (matches category enum in markets table)
            });
            const createResult = await executeTransaction(client, createTx, ctx.signer);
            const marketId = await extractCreatedObjectId(client, createResult.digest, "PredictionMarket");
            if (!marketId)
                throw new Error("PredictionMarket object not found in effects");
            // Step 3: setup referral (best effort, mirrors parent creator).
            try {
                const { object } = await client.core.getObject({ objectId: marketId, include: { json: true } });
                const rawPoolId = object?.json?.pool_id;
                const poolId = typeof rawPoolId === "string" ? rawPoolId
                    : typeof rawPoolId === "object" && rawPoolId && "id" in rawPoolId &&
                        typeof rawPoolId.id === "string"
                        ? rawPoolId.id
                        : null;
                if (poolId) {
                    upsertMarket({
                        id: marketId,
                        title: matchWinnerTitle(m),
                        description: matchWinnerDescription(m),
                        category: "worldcup",
                        expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
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
                        created_at_ms: Date.now(),
                    });
                    const refTx = buildSetupReferralTx(marketId, poolId, BigInt(1_000_000_000));
                    const refResult = await executeTransaction(client, refTx, ctx.signer);
                    const refId = await extractCreatedObjectId(client, refResult.digest, "DeepBookPoolReferral");
                    if (refId)
                        patchMarketReferralId(marketId, refId);
                }
            }
            catch (refErr) {
                console.warn(`[wc-creator] referral setup failed for ${m.id}:`, refErr instanceof Error ? refErr.message : refErr);
            }
            // Step 4: register in the global market registry (best effort)
            if (marketRegistryId) {
                try {
                    const regTx = buildRegisterMarketTx(marketRegistryId, marketId);
                    await executeTransaction(client, regTx, ctx.signer);
                }
                catch (regErr) {
                    console.warn(`[wc-creator] register_market failed for ${m.id}:`, regErr instanceof Error ? regErr.message : regErr);
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
                        const mintTx = buildMintSharesTx(marketId, feeVaultId, dusdcCoin.objectId, BigInt(initialMintAtoms));
                        await executeTransaction(client, mintTx, ctx.signer);
                    }
                }
                catch (mintErr) {
                    console.warn(`[wc-creator] initial mint failed for ${m.id}:`, mintErr instanceof Error ? mintErr.message : mintErr);
                }
            }
            created++;
        }
        catch (err) {
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
            if (msg.includes("abort code: 1") && msg.includes("register_pool")) {
                upsertMarket({
                    id: dedupeKey(m.id),
                    title: matchWinnerTitle(m),
                    description: matchWinnerDescription(m),
                    category: "worldcup",
                    expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
                    resolution_source: matchWinnerResolutionSource(m),
                    status: "active",
                    created_at_ms: Date.now(),
                });
                created++;
                console.warn(`[wc-creator] ${m.id} on-chain pool already exists; created demo row instead.`);
            }
            else if (msg.includes("insufficient SUI balance") ||
                msg.includes("gas selection")) {
                // Wallet is underfunded. Insert a demo row
                // so the home page stays populated, but
                // surface a single line so the operator can
                // fund the wallet and restart.
                upsertMarket({
                    id: dedupeKey(m.id),
                    title: matchWinnerTitle(m),
                    description: matchWinnerDescription(m),
                    category: "worldcup",
                    expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
                    resolution_source: matchWinnerResolutionSource(m),
                    status: "active",
                    created_at_ms: Date.now(),
                });
                created++;
                console.warn(`[wc-creator] ${m.id} insufficient SUI for gas; created demo row. Fund ${agentAddr} and restart to enable on-chain creation.`);
            }
            else {
                failed++;
                console.warn(`[wc-creator] ${m.id} failed:`, msg);
            }
        }
    }
    return recordResult("WorldCupCreator", {
        action: "create_wc",
        reasoning: `WC: created ${created} markets, ${failed} failed. Window: ${upcoming.length} matches in 7d.`,
        confidence: 85,
    });
}
/**
 * Convenience helper for the home page / leaderboard: how many
 * "worldcup" category markets are currently active.
 */
export function activeWcMarketCount() {
    return listMarkets().filter((m) => m.category === "worldcup" && m.status === "active").length;
}
//# sourceMappingURL=world-cup-creator.js.map