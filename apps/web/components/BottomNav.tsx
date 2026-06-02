"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const links = [
  { href: "/", label: "Home", icon: "🏠" },
  { href: "/markets", label: "Markets", icon: "📈" },
  { href: "/leaderboard", label: "Ranks", icon: "🏆" },
  { href: "/portfolio", label: "You", icon: "👤" },
  { href: "/vault", label: "Vault", icon: "🏦" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav className="fixed bottom-0 left-0 z-50 w-full border-t border-white/10 bg-[#050508]/95 px-4 py-2 backdrop-blur-xl md:hidden">
      <div className="flex items-center justify-around">
        {links.map((l) => {
          const active =
            pathname === l.href ||
            (l.href === "/markets" && pathname.startsWith("/markets/"));
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`flex flex-col items-center gap-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors ${
                active ? "text-emerald-400" : "text-zinc-500 hover:text-white"
              }`}
            >
              <span className="text-xl leading-none">{l.icon}</span>
              <span>{l.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
