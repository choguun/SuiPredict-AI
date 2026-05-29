"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@mysten/dapp-kit-react/ui";

const links = [
  { href: "/", label: "Home" },
  { href: "/trade", label: "Trade" },
  { href: "/vault", label: "Vault" },
  { href: "/agents", label: "Agents" },
  { href: "/leaderboard", label: "Leaderboard" },
  { href: "/settings", label: "Settings" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-50">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        <Link href="/" className="font-semibold text-cyan-400">
          SuiPredict<span className="text-zinc-400">.AI</span>
        </Link>
        <nav className="hidden md:flex gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 text-sm transition ${
                pathname === l.href
                  ? "bg-cyan-500/20 text-cyan-300"
                  : "text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <ConnectButton />
      </div>
    </header>
  );
}
