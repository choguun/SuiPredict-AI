// Demo seed for World Cup 2026 markets.
//
// The MVP home page and markets list look "alive" even when the
// agents service is in dry-run mode (no AGENT_PRIVATE_KEY) — the
// seed writes demo rows for the 8 most exciting upcoming group
// matches straight into the SQLite mirror. The web UI reads the
// same mirror via `/markets`, so the home page shows real
// fixtures and live mid-prices right after `pnpm dev:agents`.
//
// Idempotency: keyed on `wc26-${match.id}`. Re-running is a no-op
// when the rows already exist; safe to call from `index.ts` boot.
import { fetchMatchSchedule } from "./world-cup-fetcher.js";
import { matchWinnerDescription, matchWinnerResolutionSource, matchWinnerTitle, } from "./world-cup-fetcher.js";
import { listMarkets, upsertMarket } from "../markets/store.js";
export async function seedWcDemoMarkets() {
    const matches = await fetchMatchSchedule();
    const now = Date.now();
    const oneWeekAhead = now + 7 * 24 * 60 * 60 * 1000;
    // Demo seed surfaces matches that are in-play (kicked off
    // within the last 24h) OR upcoming (within the next 7d).
    // The previous `kickoffMs > now` filter excluded in-play
    // matches, which meant a user looking at the home page at
    // 16:00 UTC on Matchday 1 would see no markets for the
    // matches that had already kicked off (e.g. A1v3
    // Mexico vs South Korea at 17:00 UTC the day before).
    // The full 72-match schedule is always exposed via
    // `/wc/schedule` for the dedicated dashboard.
    const matchesToShow = matches
        .filter((m) => (m.kickoffMs > now - 24 * 60 * 60 * 1000 && m.kickoffMs < now) ||
        (m.kickoffMs >= now && m.kickoffMs <= oneWeekAhead))
        .sort((a, b) => a.kickoffMs - b.kickoffMs)
        .slice(0, 8);
    const existing = new Set(listMarkets()
        .filter((m) => m.id.startsWith("wc26-"))
        .map((m) => m.id));
    let seeded = 0;
    let skipped = 0;
    for (const m of matchesToShow) {
        const id = `wc26-${m.id}`;
        if (existing.has(id)) {
            skipped++;
            continue;
        }
        // For in-play matches (kickoffMs < now), the expiry is
        // already past by definition. Insert them as `active`
        // with `outcome: null` so the wc-resolver's main loop
        // (`status === "active" && expiry_ms <= now`) picks
        // them up on the next tick and overwrites the row with
        // the real Wikipedia result.
        //
        // R60 audit fix: the previous version marked
        // in-play matches as `"resolved"` with the
        // placeholder outcome `"yes"`. That made the
        // resolver's main loop skip the row (filter is
        // `status === "active" && expiry_ms <= now`) so
        // the placeholder stayed forever and the user saw
        // a fabricated `yes` resolution for every
        // in-play match. The resolver's R58.H11.1
        // backfill branch was the workaround, but a
        // correct seed should never insert a fabricated
        // outcome in the first place.
        upsertMarket({
            id,
            title: matchWinnerTitle(m),
            description: matchWinnerDescription(m),
            category: "worldcup",
            expiry_ms: m.kickoffMs + 2 * 60 * 60 * 1000,
            resolution_source: matchWinnerResolutionSource(m),
            // In-play matches: keep `status = "active"` so
            // the resolver processes them; the actual
            // outcome will be written by the resolver once
            // the Wikipedia scrape returns a score. Upcoming
            // matches: same `active` status, with
            // `outcome = null` and the standard
            // `expiry_ms = kickoff + 2h`.
            status: "active",
            outcome: null,
            created_at_ms: Date.now(),
        });
        seeded++;
    }
    return { seeded, skipped, totalCandidates: matchesToShow.length };
}
//# sourceMappingURL=wc-demo-seed.js.map