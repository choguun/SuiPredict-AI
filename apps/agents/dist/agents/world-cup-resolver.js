// World Cup 2026 resolver.
//
// Specialized resolver for the binary "Will X beat Y?" markets
// created by `world-cup-creator.ts`. Scans the SQLite mirror for
// markets with `category = "worldcup"` and `status = "active"` that
// have expired (kickoff + 2h ≤ now), scrapes the actual score from
// the per-group Wikipedia page, and either:
//   - on-chain: calls `prediction_market::resolve_market` with
//     outcome 1 (YES = home win) or 2 (NO = away win; draw is
//     resolved NO because the binary question was "will X beat
//     Y?" — a draw means X did not beat Y).
//   - demo: writes the resolved status to the SQLite mirror so the
//     web UI reflects it.
//
// Multi-source verification:
//   - Primary: Wikipedia per-group page (90% confidence). The
//     Wikipedia per-group page is updated by humans (with FIFA
//     press releases as their source) within 5-15 minutes of the
//     final whistle, so a successful parse + score read is enough
//     to commit a resolution.
//   - Secondary: Wikipedia main 2026 FIFA World Cup article, parsed
//     for the same fixture in the results section. This is the
//     same dataset the per-group page uses, so the two agree by
//     construction; the secondary check just catches a stale
//     per-group page that hasn't been updated yet. Boosts to 95%
//     confidence when both agree (we don't gate on this — see the
//     R57 audit note in `matchWinnerResolutionSource`).
//   - Tertiary: agent's own LLM (callLlm) on the LLM-gated branch
//     at parent market-resolver.ts; we don't LLM-gate here because
//     the data is binary and the Wikipedia table is the source of
//     truth.
//
// We deliberately do NOT use the BTC oracle fallback — that was for
// crypto markets. Sports markets resolve on the Wikipedia fixture
// page only.
import { buildResolveMarketTx, executeTransaction, } from "@suipredict/sdk";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import { listMarkets, upsertMarket } from "../markets/store.js";
import { fetchMatchResult, fetchMatchSchedule, } from "./world-cup-fetcher.js";
/**
 * Map a match's binary YES/NO outcome to the `prediction_market`
 * resolve encoding. We use 1 = YES (home wins) and 2 = NO
 * (anything else: away win or draw).
 */
function outcomeFor(result) {
    return result.winner === "home" ? 1 : 2;
}
/** Parse a market id back to the underlying WC match id. */
function matchIdFromMarketId(marketId) {
    if (!marketId.startsWith("wc26-"))
        return null;
    return marketId.slice("wc26-".length);
}
export async function runWorldCupResolver(ctx) {
    // R51 audit fix: read these at function-body scope so a hot-patch
    // via `bootstrap-env.ts` is honored on the next tick. Module-level
    // capture (the pre-R51 pattern) froze the boot-time snapshot.
    const confidenceThreshold = safeInt(process.env.WC_RESOLVER_CONFIDENCE ?? "", 85, 0, 100);
    const now = Date.now();
    const expired = listMarkets()
        .filter((m) => m.category === "worldcup" &&
        m.status === "active" &&
        m.expiry_ms <= now)
        .sort((a, b) => a.expiry_ms - b.expiry_ms);
    if (expired.length === 0) {
        return recordResult("WorldCupResolver", {
            action: "monitor",
            reasoning: "No expired WC markets awaiting resolution.",
            confidence: 95,
        });
    }
    // Load the schedule once; we need it to map market id -> match.
    const schedule = await fetchMatchSchedule();
    const matchById = new Map(schedule.map((m) => [m.id, m]));
    let resolved = 0;
    let skipped = 0;
    let failed = 0;
    for (const market of expired.slice(0, 5)) {
        // Cap to 5 per tick to avoid hammering the chain during a
        // matchday that produced a wave of expired markets.
        const matchId = matchIdFromMarketId(market.id);
        if (!matchId) {
            skipped++;
            continue;
        }
        const match = matchById.get(matchId);
        if (!match) {
            console.warn(`[wc-resolver] schedule missing for ${matchId}; skipping`);
            skipped++;
            continue;
        }
        const result = await fetchMatchResult(match);
        if (!result) {
            // Match not yet reported (Wikipedia lags by 5-15 min
            // post-match); skip and retry next tick.
            skipped++;
            continue;
        }
        if (result.confidence < confidenceThreshold) {
            skipped++;
            continue;
        }
        const outcome = outcomeFor(result);
        // Demo path (id starts with "demo-" OR no on-chain market id).
        // WC market ids are "wc26-<matchId>" but the on-chain
        // PredictionMarket id is the digest-derived one (set after
        // `buildCreateMarketTx`). The SQLite mirror stores both; we
        // use the SQLite `id` as the market id everywhere.
        if (market.id.startsWith("demo-") || !market.pool_id) {
            upsertMarket({
                ...market,
                status: "resolved",
                outcome: outcome === 1 ? "yes" : "no",
            });
            resolved++;
            continue;
        }
        try {
            const client = getSharedClient();
            const tx = buildResolveMarketTx(market.id, outcome);
            const result2 = await executeTransaction(client, tx, ctx.signer);
            upsertMarket({
                ...market,
                status: "resolved",
                outcome: outcome === 1 ? "yes" : "no",
            });
            resolved++;
            console.log(`[wc-resolver] ${matchId} → ${outcome === 1 ? "YES" : "NO"} (${result.homeGoals}-${result.awayGoals}, tx ${result2.digest.slice(0, 12)}…)`);
        }
        catch (err) {
            failed++;
            console.warn(`[wc-resolver] on-chain resolve failed for ${matchId}:`, err instanceof Error ? err.message : err);
        }
    }
    return recordResult("WorldCupResolver", {
        action: "resolve",
        reasoning: `WC: ${resolved} resolved, ${skipped} skipped, ${failed} failed. ${expired.length} expired total.`,
        confidence: 90,
    });
}
/**
 * Diagnostic: list all WC markets that are within 1h of expiry and
 * not yet resolved. The leaderboard / agents page uses this to
 * surface a "match about to start!" teaser.
 */
export function upcomingWcMarkets(windowMs = 60 * 60 * 1000) {
    const now = Date.now();
    return listMarkets()
        .filter((m) => m.category === "worldcup" &&
        m.status === "active" &&
        Math.abs(m.expiry_ms - now) < 24 * 60 * 60 * 1000)
        .map((m) => ({
        id: m.id,
        title: m.title,
        kickoffIn: m.expiry_ms - 2 * 60 * 60 * 1000 - now, // kickoff is 2h before expiry
    }))
        .filter((m) => m.kickoffIn <= windowMs)
        .sort((a, b) => a.kickoffIn - b.kickoffIn);
}
// Re-export for the parent resolver to call into us when it
// encounters a `category = "worldcup"` market.
export { fetchMatchResult };
//# sourceMappingURL=world-cup-resolver.js.map