"use client";

/**
 * SuiVision deep-link icon. Renders a small
 * chain-link icon that opens the
 * market/transaction on SuiVision when
 * clicked. Used as a corner overlay on
 * market cards so the SuiVision link
 * doesn't double-fire the parent card
 * navigation (a nested <a> inside a
 * server-rendered <Link> is invalid HTML,
 * and passing an onClick from a server
 * component to an <a> would also fail
 * the App Router's "no event handlers in
 * server components" check).
 *
 * R30 sweep fix: extracted from
 * `app/page.tsx` (server component) and
 * `app/markets/page.tsx` (also server).
 * Both pages used the same pattern —
 * `<a onClick={stopPropagation}>` next to
 * a wrapping `<Link>` — which the App
 * Router rejects with "Event handlers
 * cannot be passed to Client Component
 * props". The home page was failing the
 * dev-server render check on this exact
 * pattern. Centralizing the link here
 * also keeps the SUI_NETWORK allowlist
 * logic in one place.
 */
import Link from "next/link";

const SUI_NETWORKS = ["testnet", "mainnet", "devnet"] as const;
type SuiNetwork = (typeof SUI_NETWORKS)[number];
function resolveSuiNetwork(raw: string | undefined): SuiNetwork {
  if (raw && (SUI_NETWORKS as readonly string[]).includes(raw)) {
    return raw as SuiNetwork;
  }
  return "testnet";
}

export function SuivisionLink({
  objectId,
  className = "",
}: {
  /** Sui object id (`0x` + 64 hex chars). Renders nothing if missing or malformed. */
  objectId: string | undefined | null;
  className?: string;
}) {
  if (!objectId) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(objectId)) return null;
  const network = resolveSuiNetwork(process.env.NEXT_PUBLIC_SUI_NETWORK);
  const href = `https://${network}.suivision.xyz/object/${objectId}`;
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      aria-label="View on SuiVision"
      className={`inline-flex h-7 w-7 items-center justify-center rounded-lg border border-white/10 bg-black/40 text-cyan-400 opacity-0 transition-all hover:bg-cyan-500/20 hover:text-cyan-200 hover:border-cyan-500/30 group-hover:opacity-100 ${className}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path strokeLinecap="round" d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path strokeLinecap="round" d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </Link>
  );
}
