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
  // Commit d34abee hid the Agents / Legacy / Settings nav links but the
  // route directories still exist on disk and load on direct URL. Send
  // them to the home page so the demo is not confused by reachable dead
  // routes. The directories are kept for source history.
  async redirects() {
    return [
      { source: "/agents", destination: "/", permanent: false },
      { source: "/settings", destination: "/", permanent: false },
      { source: "/legacy/:path*", destination: "/", permanent: false },
    ];
  },
};

export default withPWA(nextConfig);
