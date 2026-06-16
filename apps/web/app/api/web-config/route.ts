/**
 * Server-side endpoint that returns the web bundle's
 * `NEXT_PUBLIC_*` env values as JSON. The agents dashboard
 * fetches this on first mount and uses the values to
 * compare against the agents `/health` payload.
 *
 * Why this exists: Next.js inlines `process.env.NEXT_PUBLIC_X`
 * at BUILD time only — at runtime in the BROWSER, `process`
 * is undefined, so client code can't read the values. The
 * `/agents` page is a "use client" component (so the values
 * never get inlined into the served HTML), and the drift
 * detector needs the values to know whether the bundle
 * was built with the matching ids. This server route
 * resolves that.
 *
 * Endpoint: `GET /api/web-config` → 200 with `{ ... }`.
 * The shape mirrors the subset of the agents `/health`
 * payload that the drift detector compares. Empty string
 * means the env var was unset at build time (drift-bundle
 * side: the bundle submitted PTBs against a zero-id
 * sentinel).
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const PUBLIC_ENV = {
  NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID:
    process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ?? "",
  NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID:
    process.env.NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID ?? "",
  NEXT_PUBLIC_VAULT_OBJECT_ID:
    process.env.NEXT_PUBLIC_VAULT_OBJECT_ID ?? "",
  NEXT_PUBLIC_PRIZE_POOL_ID:
    process.env.NEXT_PUBLIC_PRIZE_POOL_ID ?? "",
  NEXT_PUBLIC_PARLAY_POOL_ID:
    process.env.NEXT_PUBLIC_PARLAY_POOL_ID ?? "",
  NEXT_PUBLIC_STREAK_REGISTRY_ID:
    process.env.NEXT_PUBLIC_STREAK_REGISTRY_ID ?? "",
  NEXT_PUBLIC_FEE_VAULT_ID:
    process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? "",
  NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS:
    process.env.NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS ?? "",
  NEXT_PUBLIC_PRIZE_ADMIN_ID:
    process.env.NEXT_PUBLIC_PRIZE_ADMIN_ID ?? "",
  NEXT_PUBLIC_PROFILE_REGISTRY_ID:
    process.env.NEXT_PUBLIC_PROFILE_REGISTRY_ID ?? "",
  NEXT_PUBLIC_ADMIN_ADDRESS:
    process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "",
  NEXT_PUBLIC_PARLAY_ADMIN_ID:
    process.env.NEXT_PUBLIC_PARLAY_ADMIN_ID ?? "",
  NEXT_PUBLIC_DEEPBOOK_POOL_ID:
    process.env.NEXT_PUBLIC_DEEPBOOK_POOL_ID ?? "",
  NEXT_PUBLIC_DEEPBOOK_POOL_KEY:
    process.env.NEXT_PUBLIC_DEEPBOOK_POOL_KEY ?? "",
} as const;

export function GET() {
  return NextResponse.json(PUBLIC_ENV, {
    headers: {
      "cache-control": "no-store",
    },
  });
}
