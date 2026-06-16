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
import { normalizeObjectId } from "./utils.js";
/** Read the agents URL at call time so a hot-patch via
 *  `bootstrap-env.ts` (the agents service) or a Next.js
 *  rebuild (the web bundle) takes effect on the next request.
 *  Same pattern as `getIndexerUrl()` in
 *  `markets/indexer-client.ts:18-32`. */
function getAgentsUrl() {
    return (process.env.INDEXER_URL ??
        process.env.NEXT_PUBLIC_AGENTS_URL ??
        "http://localhost:3001");
}
async function fetchJson(path, init) {
    const url = `${getAgentsUrl()}${path}`;
    const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(8_000),
        headers: {
            accept: "application/json",
            ...(init?.body ? { "content-type": "application/json" } : {}),
            ...(init?.headers ?? {}),
        },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`faucet ${path}: HTTP ${res.status}${body ? " — " + body.slice(0, 256) : ""}`);
        err.status = res.status;
        const retry = res.headers.get("Retry-After");
        if (retry) {
            const n = Number(retry);
            if (Number.isFinite(n) && n > 0)
                err.retryAfter = n;
        }
        throw err;
    }
    return (await res.json());
}
/** Read /faucet/info. Returns the live config and the
 *  running counters. The caller (UI) should branch on
 *  `info.enabled && info.configured` to decide whether to
 *  render the action button. */
export async function getFaucetInfo() {
    return fetchJson("/faucet/info");
}
/** POST /faucet/dusdc. Throws on non-2xx with an enriched
 *  `Error` (`status`, `retryAfter`) so the UI can render
 *  per-status copy (rate-limit vs. "out of gas" vs.
 *  "faucet disabled" etc.). */
export async function requestFaucetDusdc(params) {
    // Defensive: validate the recipient is a Sui address before
    // sending. The server also validates, but a client-side
    // guard saves a round-trip on a typo'd address and gives
    // a cleaner error.
    if (!/^0x[0-9a-fA-F]{64}$/.test(params.recipient)) {
        throw new Error(`requestFaucetDusdc: recipient must be a 32-byte Sui address (got "${params.recipient}")`);
    }
    // Normalize to lowercase so the rate-limiter's
    // `recipient.toLowerCase()` key in the agents service
    // matches regardless of the caller's casing. Same
    // pattern as `getPortfolio(address)` in
    // `markets/indexer-client.ts`.
    const recipient = normalizeObjectId(params.recipient);
    return fetchJson("/faucet/dusdc", {
        method: "POST",
        body: JSON.stringify({ recipient, amount: params.amount }),
    });
}
//# sourceMappingURL=faucet-client.js.map