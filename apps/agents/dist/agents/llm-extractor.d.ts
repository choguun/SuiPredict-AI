export type ExtractionSchema = "WcGroupTeams" | "WcMatchResult" | "WcFixture" | "WcGroupStandings" | "WcTopScorers" | "Freeform";
export interface WcGroupTeams {
    letter: string;
    teams: Array<{
        code: string;
        name: string;
        pot: number;
    }>;
}
export interface WcMatchResult {
    match_id: string;
    home_team: string;
    away_team: string;
    home_goals: number;
    away_goals: number;
    status: "scheduled" | "in_progress" | "completed" | "postponed";
    competition_stage: string;
    venue: string;
    source: string;
}
export interface WcFixture {
    home_team: string;
    away_team: string;
    kickoff_utc: string;
    venue: string;
    stage: string;
    group?: string;
}
export interface WcGroupStandings {
    group: string;
    standings: Array<{
        position: number;
        team: string;
        played: number;
        won: number;
        drawn: number;
        lost: number;
        goals_for: number;
        goals_against: number;
        points: number;
    }>;
}
export interface WcTopScorers {
    scorers: Array<{
        player: string;
        team: string;
        goals: number;
        assists: number;
    }>;
}
export type ExtractionData = WcGroupTeams | WcMatchResult | WcFixture | WcGroupStandings | WcTopScorers | Record<string, unknown>;
export interface ExtractionResult<T = ExtractionData> {
    url: string;
    schema: ExtractionSchema;
    data: T;
    confidence: number;
    source: string;
    fetched_at: number;
    duration_ms: number;
    tokens_used?: number;
}
declare const SCHEMA_PROMPTS: Record<ExtractionSchema, string>;
declare const SYSTEM_PROMPT = "You are an autonomous data extraction agent. You read raw web pages and return ONLY valid JSON that matches the requested schema. Be precise: if a field is not present, omit it (don't fabricate). Use ISO-8601 for timestamps. Use integer counts for numeric fields. If the page is not relevant or you cannot find the requested data, return {\"error\": \"not_found\"} or {\"data\": null}.";
/**
 * Core extraction. Fetches the URL, strips HTML, calls the
 * LLM with a schema-specific prompt, parses the JSON
 * response. Returns null if anything fails.
 */
export declare function extractFromUrl<T = ExtractionData>(url: string, schema: ExtractionSchema, opts?: {
    bypassCache?: boolean;
}): Promise<ExtractionResult<T> | null>;
/**
 * Drop the LLM cache (test helper + admin tool).
 */
export declare function clearExtractionCache(): number;
/**
 * Stats for the /wc/sources endpoint.
 */
export declare function cacheStats(): {
    size: number;
    max: number;
    hits: number;
    misses: number;
};
/**
 * Convenience: extract a WC group's 4 teams from a
 * Wikipedia per-group page.
 */
export declare function extractGroupTeams(groupLetter: string): Promise<WcGroupTeams | null>;
/**
 * Convenience: extract a match's score from a Wikipedia
 * per-group page. Looks for `| A1vA3 || ... 1-0 ...` rows
 * in the wikitext. If the LLM-extracted page doesn't
 * contain a row for the requested match, return null.
 */
export declare function extractMatchResult(groupLetter: string, matchId: string): Promise<WcMatchResult | null>;
export { SYSTEM_PROMPT, SCHEMA_PROMPTS };
//# sourceMappingURL=llm-extractor.d.ts.map