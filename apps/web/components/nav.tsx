"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConnectModal } from "@/components/ConnectModal";

const PRIMARY_LINKS = [
  { href: "/", label: "Home" },
  { href: "/worldcup", label: "World Cup" },
  { href: "/markets", label: "Markets" },
  { href: "/parlay", label: "Parlay" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/vault", label: "Vault" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/friends", label: "Friends" },
];

// R30 sweep fix: the desktop nav was missing
// /settings, /agents, and /admin. A first-time
// desktop user had no clickable path to those
// routes — they were only reachable by typing
// the URL or via the mobile "More" sheet. The
// fix: a "More" dropdown on the desktop nav
// (hidden on mobile, where the BottomNav's own
// "More" sheet already covers the gap). The
// dropdown closes on outside-click, Escape, or
// link click — standard menu affordances. The
// admin link is always present (clicking it
// without admin authority surfaces a friendly
// "no admin key" gate inside the page itself).
const MORE_LINKS = [
  { href: "/settings", label: "Settings", icon: "⚙️" },
  { href: "/agents", label: "Agents", icon: "🤖" },
  { href: "/admin", label: "Admin", icon: "🛡️" },
];

export function Nav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);

  // Close the "More" dropdown on outside click.
  // Mirrors the BottomNav sheet's outside-click-to-dismiss.
  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      if (!moreRef.current) return;
      if (!moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

  const isMoreActive = MORE_LINKS.some((l) => pathname === l.href);

  return (
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#07090d]/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="shrink-0 text-lg font-bold tracking-tight text-white sm:text-xl">
          SuiPredict<span className="text-emerald-400">.AI</span>
        </Link>
        <nav className="hidden min-w-0 items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] p-1 md:flex">
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
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  active
                    ? "bg-white text-zinc-950"
                    : "text-zinc-400 hover:bg-white/10 hover:text-white"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
          <div className="relative" ref={moreRef}>
            <button
              type="button"
              onClick={() => setMoreOpen((v) => !v)}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              aria-current={isMoreActive ? "page" : undefined}
              className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition ${
                isMoreActive || moreOpen
                  ? "bg-white text-zinc-950"
                  : "text-zinc-400 hover:bg-white/10 hover:text-white"
              }`}
            >
              More
              <svg
                aria-hidden="true"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                className={`transition-transform ${moreOpen ? "rotate-180" : ""}`}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {moreOpen && (
              <div
                role="menu"
                aria-label="More destinations"
                className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-lg border border-white/10 bg-[#11141d] p-1 shadow-2xl shadow-black/60"
              >
                {MORE_LINKS.map((l) => {
                  const active = pathname === l.href;
                  return (
                    <Link
                      key={l.href}
                      href={l.href}
                      role="menuitem"
                      onClick={() => setMoreOpen(false)}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition ${
                        active
                          ? "bg-white/10 text-white"
                          : "text-zinc-300 hover:bg-white/10 hover:text-white"
                      }`}
                    >
                      <span aria-hidden="true">{l.icon}</span>
                      {l.label}
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </nav>
        <div className="flex items-center gap-2">
          <ConnectModal />
        </div>
      </div>
    </header>
  );
}
