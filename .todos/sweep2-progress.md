# 30-Sweep E2E Audit — Round 2

## Status: ✅ Complete

## Round 2 Improvements (this session)

### Critical Bugs Fixed
1. **`/markets/<id>/trades` returned 404 with empty body** — Fixed by adding `/trades` route to agents market routes, and a `getMarketTrades()` helper in the SDK.

2. **Markets list "AI" filter pill was broken** — Was filtering on `category === "ai"`, but the indexer writes `category: "ai_news"`. Fixed with a `categoryMatches()` helper that does prefix matching for AI.

3. **Markets list empty state for filters was generic** — Now shows specific filter combinations in the empty state message.

4. **Description in metadata said "14 autonomous AI agents"** but actual is 15 — Updated.

5. **`/wc/upcoming` filter bug** (Round 1) — Fixed in Round 1.

### New Features
6. **`RecentTrades` panel on market detail page** — Shows recent trades for the market with bid/ask, price, quantity, and relative time. Visibility-aware polling pauses when tab hidden.

7. **"Winner" pill on resolved markets** — Prominent badge showing the winning side on:
   - Home page featured markets
   - Markets list cards
   - Market detail header

8. **Loading skeletons** for:
   - `/markets` — Filter pills, search, card grid
   - `/worldcup` — Hero, live ticker, 12 groups
   - `/worldcup/group/[letter]` — Teams grid, matchday sections
   - `/leaderboard` — Filter form, table rows
   - `/friends` — Hero, add form, empty state

9. **Relative time on market detail** — "Kicks in 3d · in 3 days" format on WC market cards

### Files Modified
**Web:**
- `apps/web/app/layout.tsx` — Updated agent count to 15
- `apps/web/app/page.tsx` — Winner pill for resolved featured markets
- `apps/web/app/markets/page.tsx` — Winner pill, category filter fix, AI/DeFi/Other filter handling
- `apps/web/app/markets/[id]/page.tsx` — RecentTrades, Winner pill, kickoff relative time
- `apps/web/app/markets/loading.tsx` (NEW) — Loading skeleton
- `apps/web/app/worldcup/loading.tsx` (NEW) — Loading skeleton
- `apps/web/app/worldcup/group/[letter]/loading.tsx` (NEW) — Loading skeleton
- `apps/web/app/leaderboard/loading.tsx` (NEW) — Loading skeleton
- `apps/web/app/friends/loading.tsx` (NEW) — Loading skeleton
- `apps/web/components/RecentTrades.tsx` (NEW) — Recent trades panel

**SDK:**
- `packages/sdk/src/markets/indexer-client.ts` — Added `getMarketTrades()` function with proper validation

**Agents:**
- `apps/agents/src/markets/routes.ts` — Added `/markets/<id>/trades` route handler

## Final Verification

```bash
# 26 routes tested
200 /
200 /worldcup
200 /worldcup/group/A
200 /worldcup/group/L
200 /markets
200 /markets?category=worldcup
200 /markets?category=crypto
200 /markets?category=ai    # ← now works (was empty before)
200 /markets?status=live
200 /markets?status=resolved
200 /markets?sort=alpha
200 /markets?q=BTC
200 /markets/wc26-K1v4
200 /markets/wc26-F1v3
200 /markets/wc26-A1v3
200 /markets/demo-btc-100k
200 /friends
200 /parlay
200 /vault
200 /portfolio
200 /leaderboard
200 /admin
200 /settings
200 /agents
200 /auth
200 /dispute/wc26-K1v4
404 /notapage                # ← expected

# 13 API endpoints
200 /health
200 /markets
200 /markets/wc26-K1v4
200 /markets/wc26-K1v4/book
200 /markets/wc26-K1v4/orders
200 /markets/wc26-K1v4/trades  # ← new endpoint
200 /decisions
200 /wc/groups
200 /wc/schedule
200 /wc/upcoming?windowMs=604800000
200 /leaderboard/week
200 /agents/manifest
200 /portfolio/0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716
```

## Build Status
✅ All 4 packages build cleanly
✅ All 24+ routes return 200 (or 404 for /notapage)
✅ All 13 API endpoints return 200 with correct data
