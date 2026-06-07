/**
 * Position indexer — poll MintedEvent, RedeemedEvent, OrderPlacedEvent,
 * and SettledEvent and write to the off-chain tables so `/portfolio`,
 * `/markets/:id/book`, and `/markets/:id/orders` work without a full
 * Sui indexer.
 *
 * Uses a `last_cursor` row in the SQLite `indexer_state` table so
 * restarts resume from where we left off. Events arrive in
 * chronological order (ascending cursor).
 *
 *   - MintedEvent      → +yes_minted YES, +no_minted NO  → `positions`
 *   - RedeemedEvent    → -winning_amount of the winning side → `positions`
 *   - OrderPlacedEvent → → `chain_orders` (any user's order, not just the agent's)
 *   - SettledEvent     → → `settlements` (withdraw_settled notifications)
 *   - PrizeClaimed     → → `prize_claims` (backstops the POST /prize/claims
 *                        web notification; converges the off-chain table
 *                        even when the POST fails)
 *
 * `winning_amount` is the gross share count burned. To know which side
 * was burned we look up the market's outcome (set by the resolver via
 * MarketResolvedEvent and stored in the `markets.outcome` column).
 */
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import type { AgentContext, AgentResult } from "../lib.js";
type EventCursor = Parameters<SuiJsonRpcClient["queryEvents"]>[0]["cursor"];
export declare function readCursor(stateKey: string): EventCursor;
export declare function writeCursor(stateKey: string, cursor: EventCursor): void;
export declare function runPositionIndexer(_ctx: AgentContext): Promise<AgentResult>;
export {};
//# sourceMappingURL=position-indexer.d.ts.map