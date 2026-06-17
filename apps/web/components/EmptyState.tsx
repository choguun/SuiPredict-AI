import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Generic empty-state card with a single primary CTA and an
 * optional list of "what you'll see here" preview rows.
 *
 * UAT-FN-13 fix: the pre-fix build had 5 nearly-identical
 * "Wallet Disconnected" empty states across
 * /portfolio, /parlay, /vault, /markets/[id], and the
 * DeepBook account panel. Each said the same templated
 * "Connect your Sui wallet to [verb] your [noun]." with no
 * preview of what the user would actually see once
 * connected. The new EmptyState component takes a
 * `previews` prop that renders a labelled preview row per
 * call site, so a user landing on /portfolio without a
 * wallet sees a "You'll see: open positions · daily P&L ·
 * redeemable winners" preview, while /vault shows
 * "deposit DUSDC → mint VLP → earn maker fees" — distinct,
 * useful, and the same component.
 */
export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
  href,
  previews,
  icon = "wallet",
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  /**
   * When set, the action renders as a Next.js <Link> instead of a button.
   * Used by server components that can't pass a client-side `onAction`
   * (e.g. `app/page.tsx` which is a server component).
   */
  href?: string;
  /**
   * Optional list of "what you'll see here" preview rows.
   * Each row is a short label (e.g. "Open positions",
   * "Maker fees earned"). UAT-FN-13: previews make each
   * empty state distinct instead of the previous
   * "Wallet Disconnected" template that was reused 5
   * times.
   */
  previews?: string[];
  /**
   * Icon variant. Different call sites use a different
   * glyph to make the empty state visually distinct from
   * the rest of the app chrome. The previous single
   * document icon was reused 5 times.
   */
  icon?: "wallet" | "parlay" | "vault" | "trade" | "document";
}) {
  const ctaClass =
    "rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-cyan-900/20 transition-all hover:scale-[1.02] hover:shadow-cyan-900/40";
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-white/5 bg-black/20 p-8 text-center backdrop-blur-md">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-zinc-500">
        <EmptyIcon name={icon} />
      </div>
      <h3 className="mb-1 text-lg font-medium text-white">{title}</h3>
      <p className="mb-5 max-w-sm text-sm text-zinc-400">{description}</p>
      {previews && previews.length > 0 && (
        <ul
          aria-label="What you'll see here"
          className="mb-6 w-full max-w-xs space-y-2 rounded-lg border border-dashed border-white/10 bg-white/[0.02] p-3 text-left text-xs text-zinc-300"
        >
          {previews.map((label) => (
            <li key={label} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-400/70"
              />
              {label}
            </li>
          ))}
        </ul>
      )}
      {actionLabel && href && (
        <Link href={href} className={ctaClass}>
          {actionLabel}
        </Link>
      )}
      {actionLabel && onAction && !href && (
        <button onClick={onAction} className={ctaClass}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function EmptyIcon({ name }: { name: "wallet" | "parlay" | "vault" | "trade" | "document" }) {
  // Each variant uses a glyph that's semantically tied to
  // the surface the user is trying to reach. UAT-FN-13:
  // the previous single-document icon was reused 5 times;
  // the new per-surface icons make the empty states
  // visually distinct at a glance.
  switch (name) {
    case "wallet":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 0 0-2.25-2.25H15a3 3 0 1 1-6 0H5.25A2.25 2.25 0 0 0 3 12m18 0v6a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 9m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v3" />
        </svg>
      );
    case "parlay":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
        </svg>
      );
    case "vault":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z" />
        </svg>
      );
    case "trade":
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 6 9 12.75l4.286-4.286a11.948 11.948 0 0 1 4.306 6.43l.776 2.898m0 0 3.182-5.511m-3.182 5.51-5.511-3.181" />
        </svg>
      );
    case "document":
    default:
      return (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
      );
  }
}

/**
 * Common open-wallet dispatch helper. The 5 wallet-gated
 * pages all dispatch the same `open-connect-modal`
 * CustomEvent the Nav already listens for, but they used
 * to inline the same 4-line window check. Centralize it
 * so the open behavior is one line per call site and
 * consistent (no `typeof window === "undefined"` checks
 * on the wrong path, no double-firing).
 */
export function openConnectModal(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("open-connect-modal"));
}

/**
 * Re-export for consumers that already imported the
 * `EmptyState` symbol. The `previews` prop is optional
 * — existing call sites continue to work unchanged.
 */
export type { ReactNode };
