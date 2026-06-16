/**
 * Site footer.
 *
 * R6X audit fix: pre-R6X the app
 * had no footer anywhere — a user
 * scrolling to the bottom of any
 * page (especially the long
 * /markets list, the home page,
 * or the leaderboard) reached a
 * blank edge. For a production
 * product a footer is a basic
 * expectation: navigation to
 * non-primary routes (the docs
 * repo, the GitHub source, the
 * Twitter/Discord), the product
 * name + version, the license,
 * and the network indicator.
 *
 * The footer is mobile-first
 * (stack on phones, 3 columns on
 * md+), uses the same dark-glass
 * aesthetic as the rest of the
 * app, and is keyboard-navigable
 * (every link is a real <a> with
 * an accessible name).
 */
import Link from "next/link";

const NAV_GROUPS: Array<{
  title: string;
  links: Array<{ label: string; href: string; external?: boolean }>;
}> = [
  {
    title: "Markets",
    links: [
      { label: "All markets", href: "/markets" },
      { label: "World Cup 2026", href: "/worldcup" },
      { label: "Leaderboard", href: "/leaderboard" },
      { label: "Portfolio", href: "/portfolio" },
    ],
  },
  {
    title: "Play",
    links: [
      { label: "Daily prediction", href: "/" },
      { label: "Parlay builder", href: "/parlay" },
      { label: "Provide liquidity", href: "/vault" },
    ],
  },
  {
    title: "Build",
    links: [
      // UAT-FN-06 fix: the on-chain agent policy
      // page is what this link points at; the
      // pre-fix "Settings" label mismatched the
      // page content.
      { label: "Agent policy", href: "/agent-policy" },
      { label: "Submit a dispute", href: "/dispute/wc26-K1v4" },
    ],
  },
];

const SOCIAL_LINKS: Array<{ label: string; href: string; icon: string }> = [
  {
    label: "GitHub repository",
    href: "https://github.com/0xchuunshui/suipredict-ai",
    icon: "github",
  },
  {
    label: "Read the docs",
    href: "https://github.com/0xchuunshui/suipredict-ai/blob/main/docs/architecture.md",
    icon: "book",
  },
  {
    label: "View on SuiVision",
    href: `https://${process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet"}.suivision.xyz/`,
    icon: "eye",
  },
];

function SocialIcon({ name }: { name: string }) {
  if (name === "github") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 .3a12 12 0 00-3.79 23.4c.6.1.82-.26.82-.58v-2.16c-3.34.72-4.04-1.42-4.04-1.42-.55-1.38-1.34-1.75-1.34-1.75-1.09-.74.08-.73.08-.73 1.21.08 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 .1-.78.42-1.31.76-1.61-2.66-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.13-.3-.54-1.52.12-3.18 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 016 0c2.29-1.55 3.3-1.23 3.3-1.23.66 1.66.25 2.88.12 3.18.77.84 1.24 1.91 1.24 3.22 0 4.61-2.81 5.62-5.48 5.92.43.37.81 1.1.81 2.22v3.29c0 .32.21.69.83.58A12 12 0 0012 .3" />
      </svg>
    );
  }
  if (name === "book") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function Footer() {
  // Surface the live SUI network from the env. The pre-R6X
  // build had no network indicator anywhere on the site — a
  // user could trade on testnet and never know they weren't
  // on mainnet. The footer is a low-noise place to surface
  // it; the env is also exposed on the /admin page header.
  const network = process.env.NEXT_PUBLIC_SUI_NETWORK ?? "testnet";
  const year = new Date().getFullYear();
  return (
    <footer
      role="contentinfo"
      className="mt-12 border-t border-white/5 bg-[#050508]/80 backdrop-blur-xl"
    >
      <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <div className="grid gap-8 md:grid-cols-4">
          {/* Brand column */}
          <div className="md:col-span-1">
            <Link href="/" className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-violet-600 to-cyan-600 text-sm font-extrabold text-white shadow-lg shadow-cyan-900/30"
              >
                ⚽
              </span>
              <span className="text-base font-extrabold tracking-tight text-white">
                SuiPredict AI
              </span>
            </Link>
            <p className="mt-3 text-xs leading-relaxed text-zinc-500">
              The next-generation prediction market. Trade YES/NO on
              every FIFA World Cup 2026 match — backed by Sui DeepBook
              V3 and 14 autonomous agents.
            </p>
            <div className="mt-4 flex items-center gap-2">
              {SOCIAL_LINKS.map((s) => (
                <a
                  key={s.label}
                  href={s.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={s.label}
                  className="rounded-md border border-white/10 bg-white/[0.03] p-2 text-zinc-400 transition hover:bg-white/10 hover:text-white"
                >
                  <SocialIcon name={s.icon} />
                </a>
              ))}
            </div>
          </div>

          {/* Nav groups */}
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <h3 className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                {group.title}
              </h3>
              <ul className="mt-3 space-y-2">
                {group.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-xs text-zinc-300 transition hover:text-emerald-300"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {/* Bottom row: legal + network */}
        <div className="mt-8 flex flex-col items-start justify-between gap-3 border-t border-white/5 pt-6 text-[10px] text-zinc-500 sm:flex-row sm:items-center">
          <p>
            © {year} SuiPredict AI. Built on{" "}
            <a
              href="https://sui.io"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-400 hover:text-emerald-300"
            >
              Sui
            </a>{" "}
            · Powered by DeepBook V3 · MIT License
          </p>
          <div className="flex items-center gap-2">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse"
              aria-hidden="true"
            />
            <span>
              Live on{" "}
              <span className="font-mono font-semibold text-emerald-300">
                {network}
              </span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
