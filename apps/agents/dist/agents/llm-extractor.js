// LLM-powered web extractor.
//
// Fetches any URL, truncates the HTML to a token-budget-safe
// slice, then asks MiniMax's MiniMax-M3 to extract structured
// JSON that matches a caller-supplied schema. Used as the
// "smart" fallback when the regex-based world-cup-fetcher
// can't parse a page (Wikipedia template changes, alternate
// sources, etc.).
//
// Cost: MiniMax-M3 is $0.15/1M input tokens. A typical
// extraction (10k HTML chars + 500-token prompt) costs
// ~$0.002. The extractor is intentionally cheap; use
// sparingly in cron paths.
//
// Fallback: when MINIMAX_API_KEY is unset or the call fails,
// every public function in this module returns null and the
// caller is expected to fall back to its existing regex or
// data-source-of-truth path. The WC fetcher's hardcoded
// draw is the last-resort fallback.
//
// Usage:
//   const result = await extractFromUrl<WcGroupTeams>(
//     'https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_A',
//     'WcGroupTeams',
//   );
//   if (result) { ... use result.data ... }
//
// All public functions are pure and side-effect free except
// for the cached HTML read (in-memory) and the MiniMax call.
import { callLlm } from "../lib.js";
// 12k chars is ~3k tokens. Enough for a WC group page or
// match report, cheap enough that even a busy cron can
// fire 100+ extractions per hour without breaking the
// MiniMax rate limit.
const MAX_HTML_CHARS = 12_000;
// 5s fetch timeout. Wikipedia + ESPN + BBC all serve
// sub-second; the timeout is a network safety net.
const FETCH_TIMEOUT_MS = 5_000;
// In-memory cache. Keyed by `${url}::${schema}`. Capped at
// 50 entries with FIFO eviction. The cache is the second
// line of defense — the WC resolver/creator will also have
// their own dedupe logic. Process-local only; for a multi-
// replica deploy, swap in Redis (TODO).
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 50;
function cacheKey(url, schema) {
    return `${url}::${schema}`;
}
function cacheGet(url, schema) {
    const key = cacheKey(url, schema);
    const entry = cache.get(key);
    if (!entry)
        return null;
    if (entry.expires < Date.now()) {
        cache.delete(key);
        return null;
    }
    return entry.result;
}
function cacheSet(result) {
    const key = cacheKey(result.url, result.schema);
    cache.set(key, { result, expires: Date.now() + CACHE_TTL_MS });
    // FIFO eviction
    if (cache.size > CACHE_MAX) {
        const firstKey = cache.keys().next().value;
        if (firstKey !== undefined)
            cache.delete(firstKey);
    }
}
/**
 * Strip HTML to plain text. Cheaper than a full DOM
 * parser and good enough for the LLM. We keep the
 * structural tags (table, tr, td, th, h1-h3, p) so the
 * LLM can see the document layout.
 */
function stripHtml(html) {
    // Remove script/style/noscript blocks entirely
    let s = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
    // Drop class/style/id attributes (just visual noise)
    s = s.replace(/\s+(class|style|id|data-[a-z-]+)="[^"]*"/g, "");
    // Convert <br> and block tags to newlines
    s = s.replace(/<\/?(br|p|div|tr|li|h[1-6])[^>]*>/gi, "\n");
    // Strip remaining tags
    s = s.replace(/<[^>]+>/g, "");
    // Decode common HTML entities
    s = s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
    // Collapse whitespace
    s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n");
    return s.trim();
}
function truncate(s, max) {
    if (s.length <= max)
        return s;
    return `${s.slice(0, max)}\n\n[... truncated at ${max} chars; original was ${s.length} chars]`;
}
const SCHEMA_PROMPTS = {
    WcGroupTeams: `Extract the 4 teams in this World Cup 2026 group page. For each team return:
  - code: 3-letter ISO country code (e.g. "MEX", "BRA", "RSA")
  - name: full country name
  - pot: 1, 2, 3, or 4 (the seeding pot)
Return JSON: {"letter": "A", "teams": [{"code": "MEX", "name": "Mexico", "pot": 1}, ...]}`,
    WcMatchResult: `Extract ALL World Cup match results visible on this page. For every completed or in-progress match in the group, return an object in a top-level "matches" array. For each match:
  - match_id: stable id like "A1v3" (format: GroupLetter + HomeIndex + "v" + AwayIndex, e.g. A1v3 or A4v2)
  - home_team, away_team: country names
  - home_goals, away_goals: integer scores (0 if not yet played)
  - status: "completed" for played matches, "scheduled" for future, "in_progress" if live, "postponed" if delayed
  - competition_stage: e.g. "Group A", "Round of 16", "Quarter-final"
  - venue: stadium name
  - source: the URL or page title
Return JSON only. The shape MUST be {"matches": [...]}. Empty matches array if no matches visible.
No commentary.`,
    WcFixture: `Extract this upcoming World Cup fixture. Return:
  - home_team, away_team: country names
  - kickoff_utc: ISO-8601 timestamp in UTC (e.g. "2026-06-11T17:00:00Z")
  - venue: stadium name
  - stage: competition stage (e.g. "Group A", "Quarter-final")
  - group: group letter if known
Return JSON only.`,
    WcGroupStandings: `Extract the current standings table for this group. For each team return:
  - position: 1, 2, 3, or 4
  - team: country name
  - played, won, drawn, lost: integer counts
  - goals_for, goals_against: integer
  - points: integer
Return JSON: {"group": "A", "standings": [{"position": 1, "team": "Mexico", "played": 0, "won": 0, ...}, ...]}`,
    WcTopScorers: `Extract the top scorers table. For each player return:
  - player: full name
  - team: country name
  - goals: integer
  - assists: integer (0 if unknown)
Return JSON: {"scorers": [{"player": "Kylian Mbappe", "team": "France", "goals": 8, "assists": 3}, ...]}`,
    Freeform: `Extract the requested information as a JSON object. Be concise and only return fields that are present in the source.`,
};
const SYSTEM_PROMPT = `You are an autonomous data extraction agent. You read raw web pages and return ONLY valid JSON that matches the requested schema. Be precise: if a field is not present, omit it (don't fabricate). Use ISO-8601 for timestamps. Use integer counts for numeric fields. If the page is not relevant or you cannot find the requested data, return {"error": "not_found"} or {"data": null}.`;
/**
 * Core extraction. Fetches the URL, strips HTML, calls the
 * LLM with a schema-specific prompt, parses the JSON
 * response. Returns null if anything fails.
 */
export async function extractFromUrl(url, schema, opts = {}) {
    if (!process.env.MINIMAX_API_KEY) {
        return null;
    }
    if (!opts.bypassCache) {
        const cached = cacheGet(url, schema);
        if (cached)
            return cached;
    }
    const start = Date.now();
    let html;
    try {
        const res = await fetch(url, {
            headers: {
                "User-Agent": "SuiPredict-WorldCupBot/1.0 (autonomous; +https://sui.io)",
                Accept: "text/html,application/xhtml+xml,application/json",
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            redirect: "follow",
        });
        if (!res.ok) {
            console.warn(`[llm-extractor] ${url} → HTTP ${res.status} ${res.statusText}`);
            return null;
        }
        html = await res.text();
    }
    catch (err) {
        console.warn(`[llm-extractor] fetch ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    const text = truncate(stripHtml(html), MAX_HTML_CHARS);
    const schemaPrompt = SCHEMA_PROMPTS[schema];
    const prompt = `${schemaPrompt}\n\nURL: ${url}\n\n---\n\nWEB PAGE CONTENT (truncated):\n\n${text}\n\n---\n\nRespond with ONLY the JSON object. No prose, no markdown fences.`;
    const raw = await callLlm(prompt);
    if (!raw) {
        console.warn(`[llm-extractor] LLM returned null for ${url} (${schema})`);
        return null;
    }
    // Parse the response. The LLM sometimes wraps JSON in
    // ```json ... ``` fences despite the instruction. Strip
    // them defensively.
    let parsed;
    try {
        parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    }
    catch (e) {
        // One retry with a stricter prompt
        const retryPrompt = `${prompt}\n\nIMPORTANT: respond with valid JSON only. No markdown, no commentary. Just the JSON.`;
        const retryRaw = await callLlm(retryPrompt);
        if (!retryRaw)
            return null;
        try {
            parsed = JSON.parse(retryRaw.replace(/```json|```/g, "").trim());
        }
        catch (e2) {
            console.warn(`[llm-extractor] JSON parse failed twice for ${url}: ${e2 instanceof Error ? e2.message : String(e2)}`);
            return null;
        }
    }
    if (typeof parsed !== "object" || parsed === null) {
        console.warn(`[llm-extractor] non-object response for ${url}`);
        return null;
    }
    // Self-reported confidence for downstream logging
    const obj = parsed;
    const confidence = typeof obj._confidence === "number"
        ? Math.min(100, Math.max(0, obj._confidence))
        : 70;
    delete obj._confidence;
    const result = {
        url,
        schema,
        data: obj,
        confidence,
        source: url,
        fetched_at: Date.now(),
        duration_ms: Date.now() - start,
        tokens_used: Math.ceil((prompt.length + raw.length) / 4),
    };
    cacheSet(result);
    return result;
}
/**
 * Drop the LLM cache (test helper + admin tool).
 */
export function clearExtractionCache() {
    const n = cache.size;
    cache.clear();
    return n;
}
/**
 * Stats for the /wc/sources endpoint.
 */
export function cacheStats() {
    return { size: cache.size, max: CACHE_MAX, hits: 0, misses: 0 };
}
/**
 * Convenience: extract a WC group's 4 teams from a
 * Wikipedia per-group page.
 */
export async function extractGroupTeams(groupLetter) {
    const result = await extractFromUrl(`https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_${groupLetter}`, "WcGroupTeams");
    if (!result)
        return null;
    return result.data;
}
/**
 * Convenience: extract a match's score from a Wikipedia
 * per-group page. Looks for `| A1vA3 || ... 1-0 ...` rows
 * in the wikitext. If the LLM-extracted page doesn't
 * contain a row for the requested match, return null.
 */
export async function extractMatchResult(groupLetter, matchId) {
    const result = await extractFromUrl(`https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_Group_${groupLetter}`, "WcMatchResult");
    if (!result)
        return null;
    const matches = result.data.matches ?? [];
    return matches.find((m) => m.match_id === matchId) ?? null;
}
// `SYSTEM_PROMPT` is exposed for tests.
export { SYSTEM_PROMPT, SCHEMA_PROMPTS };
//# sourceMappingURL=llm-extractor.js.map