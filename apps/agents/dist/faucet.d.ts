/**
 * Self-hosted DUSDC faucet.
 *
 * The web app's "Mint Shares" path needs DUSDC collateral, and a
 * fresh user has none. Sui's official testnet faucet
 * (https://faucet.sui.io/) only mints SUI for gas — not the
 * protocol's DUSDC. Without a faucet the only path to DUSDC is
 * to publish your own `dusdc` package and mint from a TreasuryCap
 * you own, which is what the operators of this self-hosted
 * DeepBook V3 deploy have already done.
 *
 * This module exposes two HTTP endpoints:
 *
 *   GET  /faucet/info
 *     Returns whether the faucet is enabled, the default mint
 *     amount (in DUSDC, human-readable), the per-request cap,
 *     and the running total of DUSDC minted since the agents
 *     process started. Read-only, no side effects.
 *
 *   POST /faucet/dusdc
 *     Body: { recipient?: "0x…", amount?: number }
 *       - `recipient` defaults to the connected wallet's address.
 *         Validated against the same `0x<64 hex>` regex the rest
 *         of the agents service uses.
 *       - `amount` defaults to `FAUCET_DEFAULT_AMOUNT_DUSDC` and
 *         is hard-capped at `FAUCET_MAX_AMOUNT_DUSDC` to keep a
 *         single request from draining the TreasuryCap.
 *     Mints DUSDC to the recipient via
 *     `0x2::coin::mint_and_transfer<DUSDC>`, signed by the agent
 *     hot wallet. Returns the tx digest on success.
 *
 * Both endpoints are rate-limited per (IP, route) and per
 * (recipient, route) so a single user can't drain the TreasuryCap
 * or saturate the public RPC with mint PTBs. The in-memory
 * `tryConsume` from `rate-limit.ts` is used for the buckets; the
 * on-chain `claimed[user]` map equivalent for this faucet is the
 * rate limiter itself (the TreasuryCap allows unlimited mints
 * but the rate limiter doesn't).
 *
 * Required env:
 *   - AGENT_PRIVATE_KEY       agent hot wallet (signer)
 *   - DUSDC_TREASURY_CAP_ID   shared TreasuryCap for self-hosted
 *                             DUSDC; mirrors the agents-side
 *                             market-maker that uses the same cap
 *                             for DeepBook deposits.
 *
 * The faucet is also gated on `ENABLE_FAUCET` (default true in
 * dev / false in prod) so a mainnet deploy can hard-disable it
 * without removing the routes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
export interface FaucetInfo {
    enabled: boolean;
    configured: boolean;
    reason?: string;
    defaultAmount: number;
    maxAmount: number;
    minAmount: number;
    /** Live cumulative counters from the running process. */
    totalMinted: string;
    totalRequests: number;
    totalErrors: number;
    lastDigest: string;
    lastMintAt: number;
    /** Address of the agent wallet that will sign the mint. */
    faucetAddress: string;
    /** Full DUSDC type for client-side UX hints. */
    dusdcType: string;
}
/**
 * Route the /faucet/* paths. Returns `true` if the request
 * matched a faucet route (handled), `false` otherwise (the
 * outer router should fall through to the next handler).
 */
export declare function handleFaucetRoute(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
//# sourceMappingURL=faucet.d.ts.map