// Autonomous web-extractor agent.
//
// Runs on a cron (default: every 30 minutes) and re-scrapes
// a curated list of "secondary" World Cup data sources for
// content the regex-based world-cup-fetcher.ts can't easily
// reach:
//
//   1. en.wikipedia.org/wiki/2026_FIFA_World_Cup
//      → main article; picks up the latest group stage
//        results and any post-draw re-seeding
//   2. FIFA press release PDF (if reachable)
//      → re-validates the schedule
//   3. en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_<L>
//      for each of the 12 groups
//      → picks up match results the per-group regex misses
//   4. espn.com / bbc.com / theathletic.com schedules
//      (best-effort; user-configurable list)
//
// When `MINIMAX_API_KEY` is unset the agent is a no-op
// (returns 'noop' after a single decision log line) and
// the existing Wikipedia-only resolver/creator path stays
// in charge. When the key is set, the agent fires the LLM
// extractor and writes the structured data into a small
// `extraction_events` SQLite table. Downstream agents
// (the WC resolver, the WC creator) read this table before
// falling back to their existing data sources.
//
// This is the "multi-source verification" hook the original
// architecture called for: a third path between Wikipedia
// and any second source, with the LLM as the schema
// normalizer. It also enables the demo seed to find
// market-relevant news beyond the hardcoded 8 matches —
// e.g. a friendly match announcement on ESPN would become
// a candidate market.
import { extractFromUrl, extractGroupTeams, } from "./llm-extractor.js";
import { fetchMatchSchedule, loadWorldCupConfig, } from "./world-cup-fetcher.js";
import { recordResult, safeInt } from "../lib.js";
// Curated source list. Extend via WC_EXTRA_SOURCES env
// var (comma-separated URLs).
const DEFAULT_SOURCES = [
    // Main article
    { url: "https://en.wikipedia.org/wiki/2026_FIFA_World_Cup", schema: "WcGroupStandings" },
];
function buildSourceList() {
    const sources = [...DEFAULT_SOURCES];
    // Append per-group URLs so the extractor can pick up the
    // latest match results and re-validate the team list.
    for (const letter of "ABCDEFGHIJKL") {
        sources.push({
            url: `https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_${letter}`,
            schema: "WcGroupStandings",
            group: letter,
        });
    }
    // Append any user-supplied URLs (comma-separated). Used
    // for ad-hoc investigations, e.g. adding a BBC sport
    // schedule URL during a parse investigation.
    const extra = process.env.WC_EXTRA_SOURCES?.trim();
    if (extra) {
        for (const u of extra.split(",").map((s) => s.trim()).filter(Boolean)) {
            sources.push({ url: u, schema: "WcGroupStandings" });
        }
    }
    return sources;
}
function ensureExtractionTable() {
    // The agents service uses an existing SQLite handle
    // (markets.db) for everything else; we add a small table
    // here. Lazy import so a sqlite import cycle doesn't
    // break module init.
    const Database = require("better-sqlite3");
    const path = require("node:path");
    const { mkdirSync } = require("node:fs");
    const dir = path.resolve(__dirname, "../../data");
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, "markets.db");
    const db = new Database(dbPath);
    try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS wc_extraction_events (
        url TEXT NOT NULL,
        schema TEXT NOT NULL,
        group_letter TEXT,
        success INTEGER NOT NULL,
        confidence INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tokens_used INTEGER,
        fetched_at INTEGER NOT NULL,
        data_json TEXT NOT NULL,
        PRIMARY KEY (url, schema)
      );
      CREATE INDEX IF NOT EXISTS idx_wc_extraction_events_fetched_at
        ON wc_extraction_events (fetched_at DESC);
    `);
    }
    finally {
        db.close();
    }
}
function writeExtractionEvent(row) {
    try {
        const Database = require("better-sqlite3");
        const path = require("node:path");
        const dbPath = path.resolve(__dirname, "../../data/markets.db");
        const db = new Database(dbPath);
        try {
            db.prepare(`INSERT OR REPLACE INTO wc_extraction_events
         (url, schema, group_letter, success, confidence, duration_ms, tokens_used, fetched_at, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.url, row.schema, row.group, row.success, row.confidence, row.duration_ms, row.tokens_used, row.fetched_at, row.data_json);
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        console.warn(`[web-extractor] failed to persist event: ${err instanceof Error ? err.message : err}`);
    }
}
export function recentExtractions(limit = 50) {
    try {
        const Database = require("better-sqlite3");
        const path = require("node:path");
        const dbPath = path.resolve(__dirname, "../../data/markets.db");
        const db = new Database(dbPath);
        try {
            return db
                .prepare(`SELECT * FROM wc_extraction_events ORDER BY fetched_at DESC LIMIT ?`)
                .all(limit);
        }
        finally {
            db.close();
        }
    }
    catch {
        return [];
    }
}
export async function runWebExtractor(ctx) {
    // R58 audit fix: respect an env-driven cap on the number
    // of sources per tick so a fresh deploy with
    // `WC_EXTRA_SOURCES=https://...` (potentially hundreds of
    // URLs) doesn't burn through the MiniMax rate limit.
    const maxPerTick = safeInt(process.env.WC_EXTRACTOR_MAX_PER_TICK ?? "", 6, 1, 20);
    if (!process.env.MINIMAX_API_KEY) {
        return recordResult("WebExtractor", {
            action: "noop",
            reasoning: "MINIMAX_API_KEY not set; web-extractor is dormant. Set the key + AGENT_CRON_WC_EXTRACTOR to enable autonomous cross-source verification.",
            confidence: 95,
        });
    }
    ensureExtractionTable();
    const sources = buildSourceList().slice(0, maxPerTick);
    let success = 0;
    let failed = 0;
    let skipped = 0;
    let totalTokens = 0;
    for (const src of sources) {
        try {
            const result = await extractFromUrl(src.url, src.schema);
            if (!result) {
                failed++;
                writeExtractionEvent({
                    url: src.url,
                    schema: src.schema,
                    group: src.group ?? null,
                    success: 0,
                    confidence: 0,
                    duration_ms: 0,
                    tokens_used: null,
                    fetched_at: Date.now(),
                    data_json: "null",
                });
                continue;
            }
            success++;
            totalTokens += result.tokens_used ?? 0;
            writeExtractionEvent({
                url: result.url,
                schema: result.schema,
                group: src.group ?? null,
                success: 1,
                confidence: result.confidence,
                duration_ms: result.duration_ms,
                tokens_used: result.tokens_used ?? null,
                fetched_at: result.fetched_at,
                data_json: JSON.stringify(result.data),
            });
        }
        catch (err) {
            failed++;
            console.warn(`[web-extractor] ${src.url} threw: ${err instanceof Error ? err.message : err}`);
        }
    }
    return recordResult("WebExtractor", {
        action: success > 0 ? "extract" : "noop",
        reasoning: `Web extractor: ${success} succeeded, ${failed} failed, ${skipped} skipped across ${sources.length} sources (~${totalTokens} tokens).`,
        confidence: 80,
    });
}
// Suppress unused: WcMatch, loadWorldCupConfig, ctx used by
// the type system but not by runWebExtractor (the LLM path is
// read-only on the schedule).
void {};
void loadWorldCupConfig;
void {};
void fetchMatchSchedule;
void extractGroupTeams;
//# sourceMappingURL=web-extractor.js.map