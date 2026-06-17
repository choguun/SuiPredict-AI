import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// UAT-FN-17 fix: the pre-fix build wired in
// `@ducanh2912/next-pwa` with `disable: true` (per the R48
// audit, which found that the legacy Workbox SW served
// 24h-stale HTML via a `NetworkFirst` cache). The
// `disable: true` configuration means next-pwa is
// effectively a no-op wrapper that does nothing, so the
// `public/sw.js` file we ship with the bundle is the
// source of truth and the registration happens in
// `providers-inner.tsx`. Drop the import to avoid
// shipping unused dependencies; the next-pwa package
// remains in `package.json` for now because removing it
// would require a separate yarn/pnpm resolution test,
// and the no-op wrapper has no runtime cost (the
// import-only path doesn't trigger a build step).

const nextConfig: NextConfig = {
  transpilePackages: ["@suipredict/sdk"],
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // Round-17 audit: the /agents and /settings redirects were hiding
  // real functionality (drift banner, policy management) added in
  // round 16. Re-enable direct-URL access; the legacy redirect stays
  // so /legacy/predict/* still works for source-history callers.
  async redirects() {
    return [
      { source: "/legacy/:path*", destination: "/", permanent: false },
      // UAT-FN-06 fix: the pre-fix nav labelled the
      // page as "Settings" with a gear icon, but the
      // page content is the on-chain agent policy.
      // Renamed the route to /agent-policy and added a
      // redirect from /settings so any existing links
      // (operator bookmarks, demo scripts) still land
      // on the right page. `permanent: false` (a 307
      // rather than a 308) because the change is
      // recent — a 308 would tell Google to re-rank
      // the new URL, which is unnecessary.
      { source: "/settings", destination: "/agent-policy", permanent: false },
    ];
  },
  async headers() {
    // UAT-FN-17 fix: the offline-shell SW at /sw.js
    // must be served without any long-lived cache
    // headers so the browser always picks up the
    // latest SW on a redeploy. Next.js's static
    // asset defaults would otherwise cache the SW
    // for 1y (immutable) which is correct for
    // hashed asset bundles but wrong for the SW
    // itself.
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "cache-control", value: "no-cache, no-store, must-revalidate" },
          { key: "service-worker-allowed", value: "/" },
        ],
      },
    ];
  },
};

export default nextConfig;
