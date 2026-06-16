import type { AgentContext, AgentResult } from "../lib.js";
import { type WcMatch } from "./world-cup-fetcher.js";
/**
 * Returns the predicted YES probability for a WC match. Uses
 * log5-style draw adjustment: `P(home) = 1 / (1 + 10^((E_away -
 * E_home) / 400))`, then `P(draw) = max(0.05, 0.22 - 0.6 * |P - 0.5|)`,
 * then `P(yes) = (P(home) - P(draw) / 2) / (1 - P(draw))`.
 *
 * The "P(draw) / 2" adjustment is the standard soccer Elo trick
 * that allocates half the draw probability to each side so the
 * "no draw" probabilities sum to 1.0.
 */
export declare function predictYesProbability(match: WcMatch): number;
export declare function runWorldCupMaker(ctx: AgentContext): Promise<AgentResult>;
//# sourceMappingURL=world-cup-maker.d.ts.map