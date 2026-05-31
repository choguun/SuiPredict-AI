"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectModal } from "@/components/ConnectModal";

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
    <header className="sticky top-0 z-50 border-b border-white/10 bg-[#07090d]/90 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="shrink-0 text-lg font-bold tracking-tight text-white sm:text-xl">
          SuiPredict<span className="text-emerald-400">.AI</span>
        </Link>
        <nav className="hidden min-w-0 gap-1 rounded-lg border border-white/10 bg-white/[0.04] p-1 md:flex">
          {links.map((l) => {
            const active =
              pathname === l.href ||
              (l.href === "/markets" && pathname.startsWith("/markets/")) ||
              (l.href.startsWith("/legacy") && pathname.startsWith("/legacy"));
            return (
              <Link
                key={l.href}
                href={l.href}
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
        </nav>
        <div className="flex items-center gap-2">
          <ConnectModal />
        </div>
      </div>
    </header>
  );
}
