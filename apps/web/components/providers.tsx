"use client";

// R30 sweep fix: previously this used `dynamic(... { ssr: false })`
// which silently disabled SSR for the entire app — every page
// (home, markets, worldcup, friends, parlay, vault, leaderboard,
// admin, settings, agents, dispute) shipped an empty `<body>` to
// the browser and only rendered after hydration. That killed SEO
// (no text content for crawlers), tanked First Contentful Paint
// (the user stared at a blank dark page for ~500-1500ms on cold
// load), and broke Ctrl+F server-rendered HTML previews.
//
// The `dynamic(... { ssr: false })` was originally needed because
// `@mysten/dapp-kit-core`'s `getWallets()` reads
// `document.registerWallet` during module init, which throws a
// `ReferenceError: document is not defined` on the server. The
// library catches that internally and emits a "Skipping wallet
// initializer" warning — non-fatal. Removing the dynamic wrapper
// restores SSR; the warning is preserved as a no-op in dev logs.
//
// Direct import: ProvidersInner is already `"use client"`, so
// Next.js server-renders its output to HTML and hydrates on the
// client. Wallet initialisation only fires in `useEffect`-equivalent
// runtime paths.
export { ProvidersInner as Providers } from "./providers-inner";
