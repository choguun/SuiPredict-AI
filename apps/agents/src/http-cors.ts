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
 *   - unset in prod   → logs a warning and falls back to "*"
 *   - unset in dev    → defaults to http://localhost:3000
 *
 * The Vary: Origin header is set so a downstream cache doesn't
 * serve the wrong access-control allowlist to a different origin.
 */

let cachedOrigin: string | null = null;
let warnedAboutProductionFallback = false;

function resolveAllowedOrigin(): string {
  if (cachedOrigin !== null) return cachedOrigin;
  const fromEnv = process.env.ALLOWED_ORIGIN?.trim();
  if (fromEnv) {
    cachedOrigin = fromEnv;
    return cachedOrigin;
  }
  if (process.env.NODE_ENV === "production") {
    if (!warnedAboutProductionFallback) {
      console.warn(
        "[agents] ALLOWED_ORIGIN unset in production — falling back to '*'. " +
          "Set ALLOWED_ORIGIN to the deployed web URL to lock down " +
          "side-effecting endpoints.",
      );
      warnedAboutProductionFallback = true;
    }
    cachedOrigin = "*";
    return cachedOrigin;
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
