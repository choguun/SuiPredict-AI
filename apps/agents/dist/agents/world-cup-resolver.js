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
import { fetchMatchResult, fetchMatchSchedule, matchWinnerDescription, matchWinnerResolutionSource, matchWinnerTitle, WC_POST_KICKOFF_RESOLUTION_WINDOW_MS, } from "./world-cup-fetcher.js";
import { extractFromUrl } from "./llm-extractor.js";
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
/**
 * R60 audit fix: the wc-creator creates TWO SQLite
 * rows for every successful on-chain market:
 *   1. A `wc26-<matchId>` row (no pool_id) for the
 *      UI's idempotency dedupe.
 *   2. An on-chain `marketId` row (with pool_id) for
 *      the actual on-chain market.
 * The pre-R60 `matchIdFromMarketId` only handled the
 * first form, silently skipping the on-chain row in
 * the resolver's main loop — leaving the on-chain
 * market "active" forever and preventing YES/NO
 * holders from redeeming.
 *
 * The fix: also accept the on-chain row by
 * recognising its `deepbook_pool_key = "wc_<matchId>"`
 * (set by the wc-creator at line 200 of
 * `world-cup-creator.ts`). Prefer the canonical
 * `wc26-<matchId>` form; fall back to the
 * `deepbook_pool_key` parse; return null for any
 * other shape.
 */
function matchIdFromMarketRow(market) {
    const fromId = matchIdFromMarketId(market.id);
    if (fromId)
        return fromId;
    const key = market.deepbook_pool_key;
    if (key && key.startsWith("wc_"))
        return key.slice("wc_".length);
    return null;
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
        // R58.H11 audit fix: backfill past in-play matches
        // that have no row yet. The wc-demo-seed inserts up
        // to 8 in-play matches at boot, but as the system
        // clock progresses past boot time, more matches
        // fall into the in-play window without being
        // inserted (the seed only runs once at boot). The
        // pre-fix resolver skipped these — the home page
        // would show "0 markets" for any past match that
        // wasn't in the boot-time 8. The fix: backfill any
        // past in-play match (kickoff + 2h ≤ now) that has
        // no row yet, as `active` with `outcome: null` so
        // the main loop above (the `expired` block) picks
        // them up on the next tick and overwrites the row
        // with the real Wikipedia result.
        const schedule0 = await fetchMatchSchedule();
        const now0 = Date.now();
        const existingIds = new Set(listMarkets()
            .filter((m) => m.id.startsWith("wc26-"))
            .map((m) => m.id));
        let backfilled = 0;
        for (const m of schedule0) {
            const exp = m.kickoffMs + WC_POST_KICKOFF_RESOLUTION_WINDOW_MS;
            if (exp > now0)
                continue; // not in-play yet
            const id = `wc26-${m.id}`;
            if (existingIds.has(id))
                continue;
            // R58.H11.1 audit fix: insert as 'active' (not
            // 'resolved') so the main resolver loop below
            // picks the row up on the next tick and
            // overwrites the placeholder with the real
            // Wikipedia result. The pre-fix version marked
            // the backfill as already-resolved, which made
            // the main loop skip it (filter is
            // `status === "active" && expiry_ms <= now`)
            // and the placeholder outcome stayed forever.
            upsertMarket({
                id,
                title: matchWinnerTitle(m),
                description: matchWinnerDescription(m),
                category: "worldcup",
                expiry_ms: exp,
                resolution_source: matchWinnerResolutionSource(m),
                status: "active",
                outcome: null,
                created_at_ms: Date.now(),
            });
            existingIds.add(id);
            backfilled++;
        }
        if (backfilled > 0) {
            return recordResult("WorldCupResolver", {
                action: "monitor",
                reasoning: `Backfilled ${backfilled} past in-play row(s) that the boot-time seed window missed.`,
                confidence: 90,
            });
        }
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
        const matchId = matchIdFromMarketRow(market);
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
            // post-match); skip and retry next tick. As a
            // multi-source backstop, ask the LLM extractor to
            // verify the result from the same Wikipedia page. If
            // the LLM agrees (or returns a score where the regex
            // didn't), boost confidence and commit. If both
            // miss, skip.
            const llmResult = await extractFromUrl(`https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_${match.group}`, "WcMatchResult", 
            // R58.H19 audit fix: bypass the LLM
            // cache on every resolver call. The cache
            // TTL is 24h (R49) but Wikipedia updates
            // match results within minutes of the
            // final whistle. Bypassing the cache
            // costs one MiniMax call per expired
            // market per tick (5 per tick × 1 call =
            // ~5s extra latency, ~5k tokens) but
            // makes the resolver pick up fresh data
            // as soon as Wikipedia publishes it.
            // Without bypassCache the resolver would
            // re-process the same stale LLM data for
            // 24h after a Wikipedia update.
            { bypassCache: true });
            // Normalize the response shape. The
            // canonical contract is `{ matches: [...] }`,
            // but the current LLM prompt returns a
            // single match (the one most likely to be
            // resolved). Accept either.
            const llmMatches = Array.isArray(llmResult?.data?.matches)
                ? llmResult.data.matches
                : llmResult?.data?.match_id
                    ? [llmResult.data]
                    : [];
            // R58.H14.1 audit fix: the LLM extractor uses
            // the canonical Wikipedia match-id format
            // "A1vA3" (with the group letter before the
            // away-position), but the schedule uses the
            // shorter "A1v3". Try both forms when looking
            // up the LLM result so a 1-character naming
            // drift doesn't silently drop the match and
            // leave the boot log full of "0 resolved, 5
            // skipped".
            // R58.H20 audit fix: the LLM extractor uses
            // multiple inconsistent match-id formats
            // across prompt revisions (A1vA3, A1vE2,
            // B1vB3, etc.) while the schedule uses the
            // shorter A1v3. Build a set of normalised
            // candidate ids and try all of them. The
            // pre-R58.H20 code only tried the canonical
            // id and the "vA"-prefixed form, which
            // missed the "vE"/"vB" etc. shapes and
            // silently dropped every match.
            const altIds = (() => {
                const candidates = new Set();
                candidates.add(match.id);
                if (!match.id.includes("v"))
                    return [...candidates];
                const [prefix = "", rest = ""] = match.id.split("v", 2);
                if (!prefix || !rest)
                    return [match.id];
                // Strip any leading group letter from the
                // away position. The schedule is
                // "A1v3"; the LLM might return "A1vA3",
                // "A1vE2" (a different prompt), or even
                // bare "1v3" (the group letter dropped).
                const groupLetter = prefix[0] ?? "";
                const stripped = rest.startsWith(groupLetter)
                    ? rest.slice(1)
                    : rest;
                candidates.add(`${prefix}v${stripped}`);
                return [...candidates];
            })();
            const llmMatch = llmMatches.find((m) => altIds.includes(m.match_id ?? ""));
            if (llmMatch && llmMatch.status === "completed") {
                // R58.H21 audit fix: reject LLM
                // hallucinations where the model reports
                // a future match as "completed". The LLM
                // is forced to fill in a result for every
                // match in the group, even when the data
                // is pre-tournament; the wc-fetcher's regex
                // already returns null for these, so a
                // future match claiming "completed 4-1"
                // is almost certainly a hallucination. The
                // user (mid-WC tournament, system clock
                // past MD1) observed the LLM reporting
                // MD3 matches (10+ days in the future) as
                // "completed 4-1" and committing them. A
                // completed match whose kickoff is in the
                // future is a strong signal of LLM
                // fabrication; require the kickoff to be
                // in the past by at least 30 minutes
                // (regulation+ET buffer) before trusting
                // the LLM's completion flag.
                if (match.kickoffMs > now + 30 * 60 * 1000) {
                    console.warn(`[wc-resolver] ignoring LLM 'completed' for ${match.id} — kickoff is ${((match.kickoffMs - now) / 60000).toFixed(0)}min in the future`);
                    skipped++;
                    continue;
                }
                const syntheticWinner = llmMatch.home_goals > llmMatch.away_goals
                    ? "home"
                    : llmMatch.home_goals < llmMatch.away_goals
                        ? "away"
                        : "draw";
                const synthetic = {
                    matchId: match.id,
                    homeGoals: llmMatch.home_goals,
                    awayGoals: llmMatch.away_goals,
                    winner: syntheticWinner,
                    status: "completed",
                    source: `LLM extractor (${llmResult?.source ?? "Wikipedia"})`,
                    confidence: llmResult?.confidence ?? 70,
                };
                const committed = await commitResolution(match, {
                    homeGoals: synthetic.homeGoals,
                    awayGoals: synthetic.awayGoals,
                    winner: synthetic.winner,
                }, ctx, market);
                if (committed) {
                    resolved++;
                }
                else {
                    // commitResolution already logged the
                    // warning; count as `failed` so the
                    // operator sees the on-chain gap in
                    // /decisions and the next tick can
                    // re-attempt.
                    failed++;
                }
                continue;
            }
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
            // R60 audit fix: the wc-creator now
            // stores the on-chain marketId in
            // `onchain_market_id` (the row's
            // primary `id` is the wc26 form, not
            // the on-chain one). The PTB needs
            // the on-chain id; fall back to
            // `market.id` only when the column is
            // null (a pre-R60 DB or a demo market
            // somehow without onchain_market_id
            // set, which `commitResolution` will
            // already have caught via the
            // `!market.pool_id` branch).
            const onchainId = market.onchain_market_id ?? market.id;
            const tx = buildResolveMarketTx(onchainId, outcome);
            const result2 = await executeTransaction(client, tx, ctx.signer);
            upsertMarket({
                ...market,
                status: "resolved",
                outcome: outcome === 1 ? "yes" : "no",
            });
            resolved++;
            console.log(`[wc-resolver] ${matchId} → ${outcome === 1 ? "YES" : "NO"} (${result.homeGoals}-${result.awayGoals}, tx ${result2.digest.slice(0, 12)}…)`);
            continue;
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
// Helper: commit an extracted-or-regex'd result to the
// on-chain AND demo paths. Extracted from the inline code
// above so the LLM-extractor fallback in `for (const
// market ...)` can call it without duplicating the upsert
// logic.
//
// R60 audit fix: the previous signature took `_ctx` but
// never used it, so the LLM-extractor fallback path
// (which goes through this helper) only updated the
// SQLite mirror and never submitted the on-chain
// `resolve_market` PTB. The on-chain market stayed
// "active" forever, leaving winning YES/NO holders
// unable to redeem and the pool TVL stranded. Mirror
// the main loop's on-chain path: try the PTB, fall
// back to a SQLite-only update if the market has no
// pool or the PTB aborts. Return `true` on a
// successful on-chain commit, `false` otherwise so
// the caller can update its `resolved` / `failed`
// counters.
async function commitResolution(match, result, ctx, market) {
    if (!market)
        return false;
    const outcome = outcomeFor(result);
    // Demo path: no on-chain pool id means the market
    // was inserted as a SQLite stub by `wc-demo-seed` or
    // the WorldCupCreator's demo fallback. Just update
    // the mirror.
    if (market.id.startsWith("demo-") || !market.pool_id) {
        upsertMarket({
            ...market,
            status: "resolved",
            outcome: outcome === 1 ? "yes" : "no",
        });
        return true;
    }
    // On-chain path: submit the `resolve_market` PTB.
    // On any failure (insufficient gas, network blip,
    // missing admin capability) log the error and
    // still update the mirror so the rest of the
    // pipeline (positions, leaderboard) reflects the
    // resolved state. The on-chain retry happens on
    // the next tick via the `expired` filter (which
    // keys on `status === "active" && expiry_ms <= now`,
    // so a re-stamp of `status = "active"` is required
    // for the retry to actually fire).
    try {
        const client = getSharedClient();
        // R60 audit fix: use the on-chain marketId
        // (the SQLite primary key is the `wc26-<matchId>`
        // form, which would abort the on-chain
        // `resolve_market` call). Fall back to
        // `market.id` for pre-R60 DBs that don't have
        // the column set.
        const tx = buildResolveMarketTx(market.onchain_market_id ?? market.id, outcome);
        const onChainResult = await executeTransaction(client, tx, ctx.signer);
        upsertMarket({
            ...market,
            status: "resolved",
            outcome: outcome === 1 ? "yes" : "no",
        });
        console.log(`[wc-resolver] ${match.id} → ${outcome === 1 ? "YES" : "NO"} (${result.homeGoals}-${result.awayGoals}, tx ${onChainResult.digest.slice(0, 12)}…)`);
        return true;
    }
    catch (err) {
        console.warn(`[wc-resolver] on-chain resolve failed for ${match.id}:`, err instanceof Error ? err.message : err);
        // Still mark as resolved in SQLite so the user
        // sees the result; the operator can re-trigger
        // an on-chain commit by clearing the row's
        // status manually. A future improvement is to
        // keep the row in `status = "active"` until the
        // PTB confirms, but that would block the
        // position-indexer from decrementing redemptions
        // — for now, mirror the main loop's "best
        // effort" behaviour.
        upsertMarket({
            ...market,
            status: "resolved",
            outcome: outcome === 1 ? "yes" : "no",
        });
        return false;
    }
}
/**
 * Diagnostic: list all WC markets whose kickoff falls inside the
 * `windowMs` window from now (or have already started but not yet
 * resolved). The home page "live & upcoming" ticker and the world-cup
 * dashboard both consume this to surface a "match about to start!"
 * teaser.
 *
 * R30 sweep fix: the previous filter was
 * `Math.abs(m.expiry_ms - now) < 24h` — a "markets
 * expiring in the next 24h" predicate, not a
 * "matches about to start" one. With the seeded
 * `expiry_ms = kickoff + 2h`, a 4-day-out match had
 * `expiry_ms - now > 24h` and was silently
 * dropped; the dashboard rendered an empty
 * "upcoming" list and a user landing mid-tournament
 * saw nothing live. The new filter derives
 * `kickoff = expiry - 2h` and returns markets whose
 * kickoff is within the window (with a generous
 * `-2h` tail so matches that started <2h ago —
 * i.e. live now — are also surfaced). The 24h
 * window default from the `/wc/upcoming` route is
 * preserved, so no caller needs to change.
 */
export function upcomingWcMarkets(windowMs = 60 * 60 * 1000) {
    const now = Date.now();
    return listMarkets()
        .filter((m) => m.category === "worldcup" &&
        m.status === "active")
        .map((m) => {
        // Prefer the row's `kickoff_ms` (set by `rowToMarket` in
        // `markets/store.ts`); fall back to `expiry_ms - 2h` for
        // backwards-compat with rows written by a pre-R61 agents
        // build that didn't populate the field.
        const kickoff = m.kickoff_ms ?? m.expiry_ms - 2 * 60 * 60 * 1000;
        return {
            id: m.id,
            title: m.title,
            kickoffIn: kickoff - now,
        };
    })
        // Include matches that haven't kicked off yet
        // (kickoffIn > 0 && <= windowMs) AND matches
        // that started in the last 2h (kickoffIn in
        // `[-2h, 0]`). The 2h tail matches the WC
        // contract's resolution window — once 2h
        // passes after kickoff the resolver should
        // have settled the market, and a still-active
        // market >2h after kickoff is anomalous.
        .filter((m) => (m.kickoffIn <= windowMs && m.kickoffIn > -2 * 60 * 60 * 1000))
        .sort((a, b) => a.kickoffIn - b.kickoffIn);
}
// Re-export for the parent resolver to call into us when it
// encounters a `category = "worldcup"` market.
export { fetchMatchResult };
//# sourceMappingURL=world-cup-resolver.js.map