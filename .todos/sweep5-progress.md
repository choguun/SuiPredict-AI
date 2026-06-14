# 5-Sweep E2E Audit — Round 5 (Production-Grade Pass)

## Status: ✅ Complete (32/32 routes + APIs pass)

## Critical Fixes

### 1. SSR restored app-wide (HUGE)
- **Root cause:** `apps/web/components/providers.tsx` wrapped the entire app (Nav + main + children + BottomNav) in `dynamic(() => import("./providers-inner"), { ssr: false })`. This killed SSR for every page — body was an empty `<div>` plus RSC flight payload. Zero content visible to crawlers, terrible FCP.
- **Fix:** Removed the `dynamic` wrapper; re-exported `ProvidersInner` directly. The `"use client"` directive still marks it as a client component, so Next.js SSRs its output and hydrates on the client. The `@mysten/dapp-kit-core` "Skipping wallet initializer" warning is non-fatal and stays in dev logs.
- **Result:** All 11 main routes now SSR with `<h1>` content. Curl/grep now sees real text where it previously saw only the title tag.

### 2. Desktop nav coverage
- **Bug:** Desktop nav was missing `/friends`, `/settings`, `/agents`, `/admin` — a desktop user had no clickable path to those routes (only reachable via mobile bottom nav's "More" sheet or by typing URLs).
- **Fix:** Added Friends to the primary desktop nav and a "More" dropdown for Settings/Agents/Admin. Outside-click + Escape to close, full ARIA semantics, links close on click.

### 3. Per-market SSR metadata
- **Bug:** `/markets/[id]` (client page) couldn't export metadata, so every market inherited the generic "World Cup 2026" root title. SERPs showed the same title for every market.
- **Fix:** Added `apps/web/app/markets/[id]/layout.tsx` (server component) with `generateMetadata` that fetches the market title from agents REST and emits a unique `<title>` + OG tags per market. Now `<title>Will Portugal 🇵🇹 beat Colombia 🇨🇴? (Group K MD2) · SuiPredict AI</title>`.

### 4. Per-page SSR metadata for client-only routes
- **Bug:** `/friends`, `/parlay`, `/agents`, `/vault`, `/portfolio`, `/admin`, `/settings` were all `"use client"` pages with no server-side metadata. Every tab showed the same generic title.
- **Fix:** Added a `layout.tsx` (server component) per route that exports static `Metadata`. All 7 routes now have unique titles: "Friends · SuiPredict AI", "Parlay Builder · SuiPredict AI", etc. Admin also gets `robots: { index: false }`.

### 5. Mobile home page CTA
- **Bug:** Mobile users saw "GM, Trader 🔥" greeting with no primary CTA. The desktop hero with "Start Trading Now" was hidden on mobile.
- **Fix:** Added a compact "Trade →" button next to the mobile greeting that links to `/markets`.

### 6. Wallet-disconnected states get H1
- **Bug:** `/vault` and `/portfolio` only rendered the page h1 *after* wallet connect. When disconnected, only an `<h3>Wallet Disconnected</h3>` showed — no `<h1>` for crawlers / screen readers.
- **Fix:** Both pages now render the real page title (`Liquidity Vault`, `Your Portfolio`) with a brief description above the wallet-disconnect empty state.

### 7. Parlay "no pool" state friendlier
- **Bug:** When `NEXT_PUBLIC_PARLAY_POOL_ID` was unset, the parlay page showed a developer-facing error message ("run the parlay bootstrap (task #19)").
- **Fix:** Replaced with a user-friendly "Parlays are coming soon" message with a CTA to browse markets instead.

## Files Modified

**New files:**
- `apps/web/app/markets/[id]/layout.tsx` — per-market SSR metadata
- `apps/web/app/friends/layout.tsx` — Friends metadata
- `apps/web/app/parlay/layout.tsx` — Parlay Builder metadata
- `apps/web/app/agents/layout.tsx` — AI Agents metadata
- `apps/web/app/vault/layout.tsx` — Liquidity Vault metadata
- `apps/web/app/portfolio/layout.tsx` — Portfolio metadata
- `apps/web/app/admin/layout.tsx` — Admin metadata (+ noindex)
- `apps/web/app/settings/layout.tsx` — Settings metadata

**Modified files:**
- `apps/web/components/providers.tsx` — removed `dynamic({ ssr: false })` wrapper that killed SSR
- `apps/web/components/nav.tsx` — added Friends link + More dropdown (Settings/Agents/Admin)
- `apps/web/app/page.tsx` — added mobile CTA next to "GM, Trader" greeting
- `apps/web/app/vault/page.tsx` — wallet-disconnected state now renders real h1 + description
- `apps/web/app/portfolio/page.tsx` — same fix
- `apps/web/app/parlay/page.tsx` — friendlier "no pool" copy, added Link import

## Final Verification

```
=== Routes (32 total) ===
  /                                   200 ✓
  /worldcup                           200 ✓
  /markets                            200 ✓
  /markets/wc26-K1v4                  200 ✓
  /markets/demo-btc-100k              200 ✓
  /friends                            200 ✓
  /parlay                             200 ✓
  /vault                              200 ✓
  /portfolio                          200 ✓
  /leaderboard                        200 ✓
  /admin                              200 ✓
  /settings                           200 ✓
  /agents                             200 ✓
  /auth                               200 ✓
  /dispute/wc26-K1v4                  200 ✓
  /worldcup/group/A                   200 ✓
  /worldcup/group/L                   200 ✓
  /sitemap.xml                        200 ✓
  /robots.txt                         200 ✓
  + 13 API endpoints all 200 ✓

=== SSR h1 count (was 0 before fix, now 1 on every main route) ===
  /                              h1=1
  /worldcup                      h1=1
  /markets                       h1=1
  /friends                       h1=1
  /parlay                        h1=1
  /vault                         h1=1
  /portfolio                     h1=1
  /leaderboard                   h1=1
  /admin                         h1=1
  /settings                      h1=1
  /agents                        h1=1

=== Per-page titles (all unique now) ===
  /                  → SuiPredict AI · World Cup 2026 Prediction Markets on Sui
  /markets           → Markets · SuiPredict AI
  /worldcup          → World Cup 2026 Dashboard · SuiPredict AI
  /markets/wc26-K1v4 → Will Portugal 🇵🇹 beat Colombia 🇨🇴? (Group K MD2) · SuiPredict AI
  /leaderboard       → Leaderboard · SuiPredict AI
  /friends           → Friends · SuiPredict AI
  /parlay            → Parlay Builder · SuiPredict AI
  /agents            → AI Agents · SuiPredict AI
  /vault             → Liquidity Vault · SuiPredict AI
  /portfolio         → Portfolio · SuiPredict AI
  /admin             → Admin · SuiPredict AI
  /settings          → Settings · SuiPredict AI

=== Build ===
✅ All 4 packages build cleanly (Move + SDK + agents + web)
✅ 32/32 routes return 200
✅ All market filters work (?category, ?status, ?sort, ?q, ?page)
✅ SSR fully restored — every route emits visible HTML body content
```
