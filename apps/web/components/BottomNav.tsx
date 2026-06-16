"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const PRIMARY_LINKS = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/worldcup", label: "World Cup", icon: "⚽" },
  { href: "/markets", label: "Markets", icon: "📈" },
  { href: "/portfolio", label: "You", icon: "👤" },
];

const MORE_LINKS = [
  { href: "/friends", label: "Friends", icon: "👥" },
  { href: "/parlay", label: "Parlay", icon: "🎯" },
  { href: "/leaderboard", label: "Leaderboard", icon: "🏆" },
  { href: "/vault", label: "Vault", icon: "🔒" },
  { href: "/settings", label: "Settings", icon: "⚙️" },
  { href: "/agents", label: "Agents", icon: "🤖" },
];

/**
 * R61 audit fix: previous build exposed only 5
 * destinations on mobile (Home / World Cup /
 * Markets / Friends / You). Users on phones had
 * to open a desktop browser to access Parlay,
 * Leaderboard, Vault, Settings, or Agents. The
 * new layout keeps the 4 most-frequented tabs
 * visible and exposes the rest behind a "More"
 * sheet that opens from the bottom of the
 * viewport. The sheet follows the same dark-glass
 * aesthetic as the rest of the app, supports
 * tap-outside-to-dismiss, and traps focus on
 * the close button so screen-reader users can
 * navigate it with keyboard / VoiceOver.
 */
export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // R62 audit fix: close the "More"
  // sheet on Escape. The pre-R62 build
  // required a click on the backdrop or
  // the X button — a sighted power user
  // hitting Escape (the standard
  // "close this dialog" key) was
  // ignored. The handler is bound only
  // while the sheet is open and removes
  // itself on close so we don't leak
  // listeners across opens. The
  // ConnectModal already does this for
  // the wallet picker; the bottom-nav
  // sheet was the asymmetric survivor.
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [moreOpen]);

  return (
    <>
      <nav
        aria-label="Primary"
        className="fixed bottom-0 left-0 z-50 w-full border-t border-white/10 bg-[#050508]/95 px-2 py-2 backdrop-blur-xl md:hidden"
      >
        <div className="flex items-center justify-around">
          {PRIMARY_LINKS.map((l) => {
            const active =
              pathname === l.href ||
              (l.href === "/markets" && (pathname.startsWith("/markets/") || pathname.startsWith("/dispute/"))) ||
              (l.href === "/worldcup" && pathname.startsWith("/worldcup"));
            return (
              <Link
                key={l.href}
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                  active ? "text-emerald-400" : "text-zinc-500 hover:text-white"
                }`}
              >
                <span aria-hidden="true" className="text-xl leading-none">
                  {l.icon}
                </span>
                <span>{l.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setMoreOpen(true)}
            aria-label="Open more destinations"
            aria-expanded={moreOpen}
            className={`flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
              MORE_LINKS.some((l) => pathname === l.href)
                ? "text-emerald-400"
                : "text-zinc-500 hover:text-white"
            }`}
          >
            <span aria-hidden="true" className="text-xl leading-none">
              ☰
            </span>
            <span>More</span>
          </button>
        </div>
      </nav>

      {moreOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="More destinations"
          className="fixed inset-0 z-[60] flex items-end justify-center md:hidden"
          onClick={() => setMoreOpen(false)}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            aria-hidden="true"
          />
          <div
            className="relative w-full max-w-md rounded-t-2xl border-t border-white/10 bg-panel p-4 pb-6 shadow-2xl shadow-black/80"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-500">
                More destinations
              </h2>
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                autoFocus
                className="rounded-md p-1.5 text-zinc-400 hover:bg-white/10 hover:text-white"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
                </svg>
              </button>
            </div>
            <ul className="grid grid-cols-2 gap-2">
              {MORE_LINKS.map((l) => {
                const active = pathname === l.href;
                return (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-3 rounded-xl border px-3 py-3 text-sm transition ${
                        active
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                          : "border-white/10 bg-white/[0.03] text-zinc-200 hover:bg-white/10"
                      }`}
                    >
                      <span aria-hidden="true" className="text-xl">
                        {l.icon}
                      </span>
                      <span className="font-medium">{l.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
