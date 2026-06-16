import { type WcGroupTeams, type WcMatchResult } from "./llm-extractor.js";
import type { AgentContext, AgentResult } from "../lib.js";
interface ExtractionEventRow {
    url: string;
    schema: string;
    group: string | null;
    success: 0 | 1;
    confidence: number;
    duration_ms: number;
    tokens_used: number | null;
    fetched_at: number;
    data_json: string;
}
export declare function recentExtractions(limit?: number): ExtractionEventRow[];
export declare function runWebExtractor(ctx: AgentContext): Promise<AgentResult>;
export type { WcGroupTeams, WcMatchResult };
//# sourceMappingURL=web-extractor.d.ts.map