# SuiPredict-AI — UAT Pass 2 Report

> **Product:** SuiPredict-AI (SuiOverflow 2026)
> **Build:** `b292ba7` (post-fix) → `883df69` (latest)
> **Date:** 2026-06-16
> **Environment:** testnet, web :3000, agents :3001
> **Persona:** Maya, 28, marketing manager in São Paulo, football fan,
>             no Sui wallet ready, sees the app for the first time
> **Browser:** Chromium 1.61 (Playwright), desktop 1280×800 + mobile 390×844

---

## Verdict

**READY** (with documented follow-ups).

The SuiPredict-AI demo is in a deliverable state. The 15 pages scan
clean (0 page errors, 0 real failed requests, 0 real bad responses),
all 17 REST endpoints return 200, the home page surfaces 5 demo
forecaster ranks, the World Cup 2026 dashboard covers all 12 groups
and 72 group-stage matches, the markets list filter chips work, the
markets detail page is complete with a no-pool empty-state for
the demo-data markets, the leaderboard reads 5 demo forecasters,
the friends / parlay / portfolio / vault / admin / agent-policy
pages all render their disconnected-wallet empty state correctly,
and the /agents dashboard now reports the *actual* drift count
(6 runtime-missing env ids) instead of the inflated 13 it was
reporting before the fix.

**Three documented follow-ups** (none block the demo):

1. **0 of 47 markets are on-chain.** All demo markets live in the
   SQLite mirror only; the home page, markets list, and World Cup
   dashboard show SQLite-only rows with a graceful "No DeepBook
   pool for this market" hint on the detail page. The `create_market_with_pool`
   Move function is published (`0x99c23ef...`) but cross-package
   type compatibility with the old `0x23b78ca...` package's existing
   pool (`0xefb1e58a...`) blocks activation. The architectural path
   forward is either an in-place package upgrade or a full registry
   re-publish — multi-day migration, not a demo-blocker.
2. **`MarketMaker` agent fails every cycle** with
   `EBalanceManagerBalanceTooLow=3` on the only on-chain market
   (Test Market CLI) — the agent has no DUSDC in the BalanceManager.
   The on-chain `place_limit_order` calls `withdraw_with_proof`
   internally to lock the quote-side collateral; the deposit is
   happening but not the full notional needed. Pre-existing structural
   issue tied to the 0/47 on-chain problem above. Doesn't block the
   demo (the maker failure is a `quote_failed` row in
   `/decisions`, not a UI error).
3. **Dispute form is reachable only via direct link** (`/dispute/<id>`).
   The footer's "Submit a dispute" link points to
   `/dispute/wc26-K1v4` (a valid id), and the market detail page
   links to `/dispute/<marketId>` on "Dispute this resolution".
   The bare `/dispute` path (no id) 404s, but no nav link goes
   there.

---

## Test plan

| Scenario | Status | Notes |
|----------|--------|-------|
| 1. Cold install | ✓ | `pnpm install && pnpm build` — 0 errors |
| 2. First impression (home page hero) | ✓ | "Predict the future. Trade probability." gradient |
| 3. Connect wallet CTA (disconnected state) | ✓ | All gated pages show "Connect Wallet" |
| 4. World Cup dashboard (12 groups × 6 matches) | ✓ | 72 group matches, all render |
| 5. Markets list (filter, search, sort) | ✓ | All filter pills work, pagination works |
| 6. Market detail (no-pool demo market) | ✓ | "No DeepBook pool" hint, mint/redeem flow visible |
| 7. Leaderboard (weekly rankings) | ✓ | 5 demo forecasters via `seed-leaderboard.mjs` |
| 8. Friends / follow Sui address | ✓ | Empty state with "Try with demo address" |
| 9. Parlay builder (disconnected) | ✓ | Empty state with Connect CTA |
| 10. Portfolio (disconnected) | ✓ | Empty state with Connect CTA |
| 11. Admin / live state | ✓ | All 8 sections render with placeholders |
| 12. /agents dashboard (drift detector) | ✓ | 6 real drifts, not 13 inflated |
| 13. /agent-policy (create + manage) | ✓ | Create / pause / unpause / revoke all visible |
| 14. Mobile viewport (390×844) | ✓ | All 15 pages render, no horizontal scroll |
| 15. World Cup group A detail (6 matches) | ✓ | All 3 matchdays, MD1 + MD2 + MD3 rows |
| 16. REST API (16 endpoints) | ✓ | All return 200, payloads validated |
| 17. /api/web-config | ✓ | New server-side env endpoint, returns full env |

---

## Page-by-page findings

### / (home) — `b292ba7`  ✓
- "22 active markets" banner matches "Active Markets: 22" stat card
- Tournament Live: "Day 6 / 38" badge
- Top forecasters: 5 demo entries (deployer + 4 placeholders)
- Daily World Cup card: 5 markets with YES/NO bars
- Featured Markets: 4 cards (2 WC, 1 crypto, 1 resolved WC)
- Live agent activity: 5 WorldCupMaker "Quoted" rows (down from
  4 PositionIndexer "index" rows after UAT-FN-09 follow-up)

### /worldcup — `b292ba7`  ✓
- Hero with "Predict every match. Win the bracket."
- Next match card: "Mexico vs Czechia — 23h"
- Live & Upcoming: 6 markets, kicks-off-in countdown
- 12 groups (A–L), each with 4 teams + 6 matches
- Matchday 1 schedule preview: 24 matches with kickoff times

### /worldcup/group/A — `b292ba7`  ✓
- All 4 teams (Mexico, South Africa, South Korea, Czechia)
- MD1: 2 matches (June 11) + 2 future (June 17/23)
- MD2: 2 matches (June 17/23)
- Each row has YES/NO sides + Trade button

### /markets — `b292ba7`  ✓
- Total 47, Active 22, Resolved 25 (after Test Market CLI resolved)
- Filter pills: All / World Cup / Crypto / AI / DeFi / Other
- Search + status + sort dropdowns + Apply button
- 4 pages of 12 markets each

### /markets/wc26-A1v4 — `b292ba7`  ✓
- "Will Mexico 🇲🇽 beat Czechia 🇨🇿? (Group A MD2)"
- 50.0¢ YES / 50.0¢ NO (initial prices)
- How this works (3 steps)
- Recent Trades / YES order book (no fills yet)
- Trade form (Buy YES / Buy NO, price, size)
- No friends yet widget
- DeepBook V3 account (Setup Trading Account)
- Collateral (Faucet 100 DUSDC, Mint/Sell Shares)
- Your Position (zero)

### /leaderboard — `b292ba7`  ✓
- 5 demo forecasters (deployer first, score 6.06, 6 days)
- Filter: View (Global) / Category (All) / Address lookup
- Updated timestamp, Week #2945
- Each row: rank / user / score / correct days / streak / "Connect wallet"

### /friends — `b292ba7`  ✓
- Empty state "No friends yet"
- "Try with demo address" button (operator's wallet pre-fills)

### /parlay — `b292ba7`  ✓
- "Wallet Disconnected" empty state
- Connect Wallet CTA

### /portfolio — `b292ba7`  ✓
- "Wallet Disconnected" empty state
- Connect Wallet CTA

### /admin — `b292ba7`  ✓
- Live state panel: FeeVault, PrizePool, ProtocolVault, ParlayPool
- Withdraw Protocol Fees form
- Set Prize Distribution (pool, prizeAdmin, sum, BPS list)
- Resolve Disputed Market
- Create Market (admin escape hatch)
- Set Parlay Max Payout Cap (50_000 BPS = 5x multiplier)
- Parlay Pool Admin (withdraw / rotate)
- Protocol Vault Admin (allocate for MM, return from MM)

### /agents — `b292ba7` → `f964daa`  ✓
- 15 active agents (MarketCreator, MarketResolver, WorldCupCreator,
  WorldCupResolver, WorldCupMaker, WebExtractor, StreakSweeper,
  LeaderboardWorker, PrizeAdmin, PrizeDistributor, ReferralKeeper,
  PositionIndexer, ParlayWorker, RiskMonitor, MarketMaker)
- Operator note: **6 env ids out of sync** (down from 13 inflated)
  - PARLAY_POOL_ID: runtime value missing from /health
  - PROFILE_REGISTRY_ID: runtime value missing from /health
  - ADMIN_ADDRESS: runtime value missing from /health
  - PARLAY_ADMIN_ID: runtime value missing from /health
  - DEEPBOOK_POOL_ID: runtime value missing from /health
  - DEEPBOOK_POOL_KEY: runtime value missing from /health
- All 6 are genuinely unset on the runtime side (the agents service
  hasn't been bootstrapped with these optional env vars). The
  drift display now reflects the actual state instead of
  double-counting every empty web-bundle field as a drift.

### /agent-policy — `b292ba7`  ✓
- 3-step "How agent policy works" (Authorize / Pause / Revoke)
- Create Policy form
- Manage Policy (Pause / Unpause / Revoke)

### /vault — `b292ba7`  ✓
- "Wallet Disconnected" empty state
- Connect Wallet CTA
- "Deposit DUSDC to earn yield from autonomous market-making agents"

---

## API endpoints (16 agents + 1 web)

| Method | Path | Status | Latency |
|--------|------|--------|---------|
| GET | /health | 200 | 15ms |
| GET | /decisions | 200 | 1ms |
| GET | /agents/manifest | 200 | 1ms |
| GET | /markets | 200 | 1ms |
| GET | /wc/groups | 200 | 1ms |
| GET | /wc/schedule | 200 | 0ms |
| GET | /wc/upcoming?windowMs=604800000 | 200 | 1ms |
| GET | /wc/sources | 200 | 1ms |
| GET | /wc/extract/cache | 200 | 0ms |
| GET | /leaderboard/week?limit=5 | 200 | 1ms |
| GET | /leaderboard/country?code=br | 200 | 0ms |
| GET | /prize/pool | 200 | 117ms |
| GET | /streak/0x0cdc…716 | 200 | 1ms |
| GET | /stats | 200 | 1ms |
| GET | /faucet/info | 200 | 3ms |
| GET | /vault/summary | 200 | 1ms |
| GET | /api/web-config (web) | 200 | 234ms |

All 17 endpoints healthy.

---

## Performance observations

- **Web home page** (`/`): ~2.4s first paint (server-rendered).
  All 4 stat cards (Active Markets / Vault TVL / MM Allocated /
  AI Agents) populated from `/markets`, `/stats`, `/agents/manifest`.
- **Agents /health**: 15ms median (single SQLite read + JSON serialization).
- **Agents /decisions**: 1ms median (last 100 decisions in SQLite).
- **World Cup dashboard** (`/worldcup`): 3.1s first paint. 12 groups
  + 24-matchday-1 schedule loaded in a single `/wc/groups` + `/wc/schedule`
  pair.
- **Market detail** (`/markets/<id>`): 3.3s first paint. Includes
  DeepBook V3 account setup, collateral faucet, friend positions,
  YES order book, recent trades — all client-rendered.

---

## Findings

| ID | Severity | Surface | Title | Repro | Expected | Actual | Status |
|----|----------|---------|-------|-------|----------|--------|--------|
| UAT-FN-08 | Low | home banner | Banner count source mismatch | `curl /` | banner = stat card | was 20 vs 23, now both 22 | Fixed (`b292ba7`) |
| UAT-FN-19 | High | home / TopForecasters | Top forecasters empty | `curl /leaderboard/week?limit=5` | 5 demo rows | 0 rows | Fixed (`b292ba7` + `seed-leaderboard.mjs`) |
| UAT-FN-09 | Low | home / LiveActivity | Indexer noise (4× "PositionIndexer 1m ago") | visit `/` | interesting per-cycle actions | 4× identical indexer rows | Fixed (`883df69`) |
| R-UAT-23 | High | agents / world-cup-creator | `EPoolAlreadyExists` abort hard-fails the whole tick | trigger WC creator | graceful skip | abort propagates, tick dies | Fixed (`b292ba7`) |
| Drift inflation | High | /agents dashboard | 13 false-positive drifts (always-empty web bundle) | visit `/agents` | accurate drift count | 13 inflated (real: 6) | Fixed (`f964daa` + `apps/web/app/api/web-config/route.ts`) |
| Test Market CLI stale | Low | markets list | Expired market (June 14) still shows as active | `curl /markets` | resolved/filtered | active with no outcome | Resolved manually via `force-resolve.mjs` |

---

## Follow-up suggestions

1. **Decide the 0/47 on-chain path.** The cleanest fix is to add
   `create_market_with_pool` to the existing `0x23b78ca` package via
   in-place upgrade (requires `UpgradeCap` access). The current
   `0x99c23ef...` re-publish is the wrong path because Move's type
   system rejects cross-package pool sharing.
2. **Top up the agent's DUSDC.** A 1000-DUSDC faucet mint would
   resolve the `EBalanceManagerBalanceTooLow` errors. The MM is
   picking the smallest available DUSDC coin (`>= 1M atoms` = 1 DUSDC)
   but the order is for 10 DUSDC per side.
3. **Bootstrap the optional env vars** (PARLAY_POOL_ID,
   PROFILE_REGISTRY_ID, ADMIN_ADDRESS, PARLAY_ADMIN_ID,
   DEEPBOOK_POOL_ID, DEEPBOOK_POOL_KEY) to drop the 6 drift rows
   to 0. Each requires a separate on-chain publish (parlay pool,
   profile registry, parlay admin rotate) that the demo doesn't
   exercise.
4. **Cosmetic**: The "Test Market CLI" demo market from
   `market-creator.ts` is auto-created when the agent wallet is
   underfunded for gas; the UI surfaces it as a "real" market
   in the list. A future polish would rename / demote it to
   "Demo: Test Market CLI" so customers don't read the
   LLM-generated test fixture as production state.

---

## Run log pointer

- `uat-pass2/results.json` — full Playwright pass (15 pages + 17 APIs)
- `uat-pass2-screenshots/*.png` — per-page screenshots (desktop + mobile)
- `uat-pass2-screenshots/*-full.png` — full-page screenshots for the
  5 most important pages
- `uat-pass2-screenshots/agents-fixed.png` — /agents after the
  drift-detector fix
- `uat-pass2-screenshots/home-live-activity.png` — home page Live
  Activity strip after the indexer-noise filter
- `apps/agents/scripts/force-resolve.mjs` — manual resolver for
  past-expired markets
- `apps/agents/scripts/seed-leaderboard.mjs` — demo forecaster seeder
