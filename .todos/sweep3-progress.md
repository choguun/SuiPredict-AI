# 30-Sweep E2E Audit — Round 3

## Status: ✅ Complete

## Round 3 Improvements (this session)

### Critical Features Added
1. **sitemap.xml** (`apps/web/app/sitemap.ts`) — Dynamic sitemap with all 69 URLs (10 static + 12 group pages + 47 market pages). Critical for SEO.
2. **robots.txt** (`apps/web/app/robots.ts`) — Disallows `/auth`, `/admin`, `/dispute/`, `/api/`. Points to sitemap.
3. **Dynamic app icon** (`apps/web/app/icon.tsx`) — Next.js ImageResponse-based 32x32 icon with "SP" wordmark.
4. **Apple touch icon** (`apps/web/app/apple-icon.tsx`) — 180x180 rounded icon for iOS home-screen.

### Critical Bugs Fixed
5. **Markets list "Sort by expiry" put resolved markets first** — Fixed by grouping active markets first, then resolved, withing each group sorted by expiry. A user landing on the markets list with no filter no longer sees 8 resolved matches at the top.

6. **Mint button was clickable on resolved markets** — A user could try to mint on a market whose outcome is already decided, wasting gas + cluttering the UI. Fixed by:
   - Pre-flight check that returns friendly error message
   - Visual `disabled` state on the button
   - Same for `placeOrder` (limit orders on resolved markets would never settle)

7. **Parlay history empty state was just "No parlays yet."** — Improved to a friendlier empty state with explainer and CTA to /markets.

### Other Improvements
8. **Markets list filter AI pill** (Round 2) — Fixed with `categoryMatches()` helper that does prefix matching for AI.

### Files Modified
**New files:**
- `apps/web/app/sitemap.ts` — Dynamic sitemap (69 URLs)
- `apps/web/app/robots.ts` — robots.txt
- `apps/web/app/icon.tsx` — 32x32 app icon
- `apps/web/app/apple-icon.tsx` — 180x180 Apple touch icon

**Modified files:**
- `apps/web/app/markets/page.tsx` — Sort by expiry groups active first
- `apps/web/app/markets/[id]/page.tsx` — Mint/placeOrder disabled on resolved markets
- `apps/web/components/ParlayHistory.tsx` — Friendlier empty state

## Final Verification

```bash
# 33 routes tested
200 /
200 /worldcup
200 /worldcup/group/A
200 /worldcup/group/L
200 /markets
200 /markets?category=worldcup
200 /markets?category=crypto
200 /markets?category=ai
200 /markets?category=defi
200 /markets?category=other
200 /markets?status=live
200 /markets?status=resolved
200 /markets?sort=alpha
200 /markets?sort=newest
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
200 /sitemap.xml       # ← new
200 /robots.txt       # ← new
200 /icon              # ← new
200 /apple-icon        # ← new

# 12 API endpoints
200 /health
200 /markets
200 /markets/wc26-K1v4
200 /markets/wc26-K1v4/book
200 /markets/wc26-K1v4/orders
200 /markets/wc26-K1v4/trades  # ← from Round 2
200 /decisions
200 /wc/groups
200 /wc/schedule
200 /wc/upcoming?windowMs=604800000
200 /leaderboard/week
200 /agents/manifest
```

## Build Status
✅ All 4 packages build cleanly
✅ All 33 routes return 200
✅ All 12 API endpoints return 200
✅ Sitemap includes 69 URLs
✅ Robots.txt properly disallows user-state routes
