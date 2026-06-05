/**
 * CORS helper for the agents HTTP service.
 *
 * R35 audit fix: every response previously set
 * `Access-Control-Allow-Origin: *`, which lets any origin drive a
 * victim's wallet to sign-claim on /prize/signature (the signed
 * payload is a transferable asset) or POST /prize/claims. Restrict
 * the side-effecting endpoints to an env-configured allowlist while
 * keeping the read-only /health, /decisions, /agents/manifest
 * routes open (operator dashboards may pull them from a different
 * origin).
 *
 * The allowlist comes from `ALLOWED_ORIGIN`:
 *   - explicit value  → used verbatim
 *   - unset in prod   → hard-fail the boot with an exception
 *   - unset in dev    → defaults to http://localhost:3000
 *
 * R50 audit fix: was "log a warning and fall back to '*'". A
 * script on attacker.com could pre-sign payloads for
 * legitimate winners (the signed payload is a
 * transferable asset, finding #3) and `Access-Control-
 * Allow-Origin: *` on side-effecting endpoints lets
 * that script drive a `fetch()` chain. The browser
 * rejects `* + credentials` (correct), but the
 * preflight for a non-credentialed `fetch()` succeeds.
 * Hard-fail at boot so the misconfiguration is loud,
 * not silent.
 *
 * The Vary: Origin header is set so a downstream cache doesn't
 * serve the wrong access-control allowlist to a different origin.
 */

let cachedOrigin: string | null = null;

function resolveAllowedOrigin(): string {
  if (cachedOrigin !== null) return cachedOrigin;
  const fromEnv = process.env.ALLOWED_ORIGIN?.trim();
  if (fromEnv) {
    cachedOrigin = fromEnv;
    return cachedOrigin;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[agents] ALLOWED_ORIGIN is required in production. " +
        "Set ALLOWED_ORIGIN to the deployed web URL to lock down " +
        "side-effecting endpoints (/prize/signature, /prize/claims).",
    );
  }
  cachedOrigin = "http://localhost:3000";
  return cachedOrigin;
}

/** Resolve once on first call; expose for tests/diagnostics. */
export function getAllowedOrigin(): string {
  return resolveAllowedOrigin();
}

/**
 * Build CORS headers for a response. `sideEffecting=true` applies
 * the allowlist (POST /prize/claims, /prize/signature, /streak/*);
 * `sideEffecting=false` keeps the open "*" (read-only operator
 * dashboards that may live on a separate origin).
 */
export function corsFor(sideEffecting: boolean): Record<string, string> {
  if (!sideEffecting) {
    return { "Access-Control-Allow-Origin": "*" };
  }
  const origin = resolveAllowedOrigin();
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}
