/**
 * Gamification REST routes.
 *
 *   GET /leaderboard/week?index=N&limit=M&category=K
 *   GET /leaderboard/country?code=us&index=N&limit=M&category=K
 *   GET /leaderboard/user/:addr?week=N
 *   GET /prize/signature/challenge?user=:addr
 *   GET /prize/signature?week=N&rank=R&user=:addr&amount=:a&nonce=…&signature=…&publicKey=…
 *   GET /prize/claims?week=N
 *   GET /profile/:addr
 *   GET /parlay/:id
 *   GET /parlay/user/:addr
 *
 * The first two back the off-chain leaderboard surface. The prize
 * signature endpoint re-signs the canonical claim payload so the user
 * can submit the on-chain `claim_prize` tx from their own wallet.
 * The parlay endpoints serve the off-chain `parlays` mirror written
 * by the position-indexer from ParlayCreated / ParlayLegRecorded /
 * ParlayFinalized events; the web /parlay page uses them to render
 * a user's parlay history and live leg progress without per-poll
 * on-chain reads.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
export declare function handleGamificationRoute(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
//# sourceMappingURL=routes.d.ts.map