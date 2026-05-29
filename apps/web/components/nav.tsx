"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";

const links = [
  { href: "/", label: "Home" },
  { href: "/markets", label: "Markets" },
  { href: "/vault", label: "Vault" },
  { href: "/portfolio", label: "Portfolio" },
  { href: "/agents", label: "Agents" },
  { href: "/legacy/predict/trade", label: "Legacy ▾" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-white/10 bg-black/20 backdrop-blur-md sticky top-0 z-50 shadow-sm shadow-black/20">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="text-xl font-bold tracking-tight">
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-violet-400 to-cyan-400 drop-shadow-sm">
            SuiPredict
          </span>
          <span className="text-zinc-400 font-medium">.AI</span>
        </Link>
        <nav className="hidden md:flex gap-1 bg-white/5 border border-white/10 rounded-xl p-1 backdrop-blur-sm">
          {links.map((l) => {
            const active =
              pathname === l.href ||
              (l.href === "/markets" && pathname.startsWith("/markets/")) ||
              (l.href.startsWith("/legacy") && pathname.startsWith("/legacy"));
            return (
              <Link
                key={l.href}
                href={l.href}
                className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-all duration-300 ${
                  active
                    ? "bg-gradient-to-r from-violet-600/90 to-cyan-600/90 text-white shadow-md shadow-cyan-900/30 scale-[1.02]"
                    : "text-zinc-400 hover:text-white hover:bg-white/10"
                }`}
              >
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <ConnectButton />
        </div>
      </div>
    </header>
  );
}
