import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// R48 audit fix: disable PWA entirely in production too. R43 added
// an `unregister` effect in `providers-inner.tsx` to tear down the
// legacy Workbox SW on first mount, but the unregister only fires
// *after* hydration — a network race on the very first navigation
// of a session can still hit the SW and serve stale HTML. The
// unregister-then-flash path is the worst of both worlds: an SW
// gets registered (and can intercept) before it's killed. Skip
// `sw.js` generation entirely so the browser never sees it.
const withPWA = withPWAInit({
  dest: "public",
  disable: true,
  register: false,
});

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
    ];
  },
};

export default withPWA(nextConfig);
