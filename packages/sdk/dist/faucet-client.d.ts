/**
 * Client-side helpers for the self-hosted DUSDC faucet.
 *
 * The agents service exposes:
 *   GET  /faucet/info  — config + live counters
 *   POST /faucet/dusdc — mint DUSDC to a given address
 *
 * These thin wrappers do the env-aware URL resolution (the
 * SDK reads `NEXT_PUBLIC_AGENTS_URL` / `INDEXER_URL` with a
 * localhost fallback so a dev server picks up the env without
 * a code change) and a 8s fetch timeout. The web app's
 * `FaucetButton` component can use them directly, as can
 * third-party tooling that already imports from
 * `@suipredict/sdk`.
 *
 * Both functions are mirrors of the SDK's `indexer-client.ts`
 * helpers (`getMarket`, `listMarkets`, etc.) — same URL
 * resolver, same timeout, same error shape. The barrel
 * re-exports them so a consumer can do
 * `import { requestFaucetDusdc } from "@suipredict/sdk"`.
 */
export interface FaucetInfo {
    enabled: boolean;
    configured: boolean;
    reason?: string;
    defaultAmount: number;
    maxAmount: number;
    minAmount: number;
    totalMinted: string;
    totalRequests: number;
    totalErrors: number;
    lastDigest: string;
    lastMintAt: number;
    faucetAddress: string;
    dusdcType: string;
}
export interface FaucetMintResponse {
    ok: true;
    digest: string;
    amount: number;
    amountAtoms: string;
    recipient: string;
    info: FaucetInfo;
}
/** Read /faucet/info. Returns the live config and the
 *  running counters. The caller (UI) should branch on
 *  `info.enabled && info.configured` to decide whether to
 *  render the action button. */
export declare function getFaucetInfo(): Promise<FaucetInfo>;
export interface RequestFaucetDusdcParams {
    recipient: string;
    /** DUSDC amount in human-readable units. Clamped to the
     *  server-side [min, max] from /faucet/info. */
    amount?: number;
}
/** POST /faucet/dusdc. Throws on non-2xx with an enriched
 *  `Error` (`status`, `retryAfter`) so the UI can render
 *  per-status copy (rate-limit vs. "out of gas" vs.
 *  "faucet disabled" etc.). */
export declare function requestFaucetDusdc(params: RequestFaucetDusdcParams): Promise<FaucetMintResponse>;
//# sourceMappingURL=faucet-client.d.ts.map