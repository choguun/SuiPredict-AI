export declare const TEAM_NAMES: Record<string, {
    name: string;
    flag: string;
}>;
export interface WcTeam {
    /** ISO 3166-1 alpha-3, e.g. "MEX" */
    code: string;
    /** Group letter + position, e.g. "A1" */
    drawPosition: string;
    name: string;
    flag: string;
    confederation: string;
    pot: number;
}
export interface WcGroup {
    letter: "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "K" | "L";
    teams: WcTeam[];
}
/**
 * R61 audit fix: the post-kickoff resolution
 * window. The on-chain `prediction_market::create_market`
 * `expiry_ms` is set to `kickoff + WC_POST_KICKOFF_RESOLUTION_WINDOW_MS`
 * (regulation 90min + extra time 30min + the resolver's
 * 2-hour post-match window for fetching the score from
 * Wikipedia). Previously this constant was repeated in
 * the wc-creator (`m.kickoffMs + 2 * 60 * 60 * 1000`) and
 * the wc-resolver backfill (`m.kickoffMs + 2 * 60 * 60 * 1000`).
 * A future tweak to 2.5h or 3h would have required two
 * separate edits, and a missing edit would leave the
 * SQLite mirror's `expiry_ms` out of sync with the on-chain
 * value (the resolver's `expired` filter would then
 * surface the wrong markets, or miss them entirely).
 */
export declare const WC_POST_KICKOFF_RESOLUTION_WINDOW_MS: number;
export interface WcMatch {
    /** Stable id, e.g. "A1vA2" */
    id: string;
    group: string;
    /** Draw position, e.g. "A1" */
    homeCode: string;
    /** Draw position, e.g. "A2" */
    awayCode: string;
    /** ISO 3166-1 alpha-3 country code, e.g. "MEX" */
    homeTeamCode: string;
    awayTeamCode: string;
    homeName: string;
    awayName: string;
    homeFlag: string;
    awayFlag: string;
    /** UTC kickoff, ms since epoch */
    kickoffMs: number;
    /** Matchday 1, 2, or 3 (per group, not tournament-wide) */
    matchday: 1 | 2 | 3;
    /** Stadium name (best-effort) */
    stadium: string;
    stage: "group";
}
export interface WcMatchResult {
    matchId: string;
    homeGoals: number;
    awayGoals: number;
    winner: "home" | "away" | "draw";
    status: "completed" | "in_progress" | "scheduled";
    source: string;
    confidence: number;
}
/**
 * Returns the 12 groups / 48 teams. Re-validates against Wikipedia on
 * the first call after `CACHE_TTL_MS` expires; falls back to the
 * hardcoded draw if Wikipedia is rate-limited or returns 4xx/5xx.
 */
export declare function loadWorldCupConfig(): Promise<WcGroup[]>;
/**
 * Generates the 6 matches per group (round-robin, no double-headers):
 *   R1: 1v3, 4v2
 *   R2: 1v4, 3v2
 *   R3: 1v2, 3v4
 * With the group kickoff window from the FIFA schedule (June 11-27,
 * 2026) translated to UTC, every group plays its R1 on a single
 * matchday (MD1), R2 on MD2, etc., spread across 3 matchdays over
 * ~12 days.
 */
export declare function buildGroupMatches(groups: WcGroup[]): WcMatch[];
export declare function fetchMatchSchedule(): Promise<WcMatch[]>;
/**
 * Fetches a single match's result from the per-group Wikipedia page.
 * Returns null if the match hasn't been played yet, or the score
 * once Wikipedia has it.
 */
export declare function fetchMatchResult(match: WcMatch): Promise<WcMatchResult | null>;
/**
 * Build a "binary match winner" market title that reads well on
 * mobile and fits the 120-char limit on the existing `markets` table.
 */
export declare function matchWinnerTitle(m: WcMatch): string;
export declare function matchWinnerDescription(m: WcMatch): string;
export declare function matchWinnerResolutionSource(m: WcMatch): string;
export declare function matchdayFor(m: WcMatch): 1 | 2 | 3;
//# sourceMappingURL=world-cup-fetcher.d.ts.map