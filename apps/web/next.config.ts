import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";
import withPWAInit from "@ducanh2912/next-pwa";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const withPWA = withPWAInit({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  register: true,
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
