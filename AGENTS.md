# SuiPredict-AI — Project Guide for AI Assistants

> Autonomous AI prediction market on Sui + DeepBook V3 CLOB. MVP pivoted
> to **FIFA World Cup 2026** (June 11 – July 19, 2026). Mobile-first,
> gamified (streaks, leaderboards, friends), 14 autonomous agents that
> scrape the web for fixture data, run an Elo-based market maker, and
> resolve matches from Wikipedia.

## Repo layout

```
SuiPredict-AI/
├── packages/
│   ├── contracts/        Move 2024 — all on-chain modules
│   │   ├── sources/
│   │   │   ├── prediction_market.move   CLOB market lifecycle (1200 LoC; supports `create_market` + `create_market_with_pool` for per-market `BalanceManager` + `TreasuryCap<YES<DUSDC>>`)
│   │   │   ├── parlay.move              multi-leg parlay pool
│   │   │   ├── prize_pool.move          weekly prize escrow + ed25519-signed claims
│   │   │   ├── streak_system.move       daily streak + multipliers
│   │   │   ├── badge_nft.move           tier-based achievement NFTs
│   │   │   ├── user_profile.move        country/forecaster-kind registry
│   │   │   ├── vault.move               ProtocolVault<DBUSDC> (TVL)
│   │   │   ├── vlp.move                 VLP share token
│   │   │   ├── agent_policy.move        agent permissions, pause/revoke
│   │   │   ├── registry.move            market registry
│   │   │   └── types.move               shared structs / events
│   │   └── tests/                        130 unit tests (all pass)
│   └── sdk/              TypeScript SDK (PTB builders + read helpers)
│       └── src/
│           ├── prediction-market-client.ts   CLOB market PTBs + `ensureMarketCreated` helper (R-WC-1)
│           ├── parlay-client.ts              parlay PTBs
│           ├── prize-client.ts               prize pool PTBs
│           ├── streak-client.ts              streak PTBs
│           ├── badge-nft-client.ts           badge PTBs
│           ├── user-profile-client.ts        profile PTBs
│           ├── vault-client.ts               vault PTBs
│           ├── deepbook/                     DeepBook V3 wrappers
│           └── protocol-reads.ts             on-chain state readers
├── apps/
│   ├── agents/           Node 20 + better-sqlite3 — autonomous workers + REST
│   │   ├── src/agents/   14 workers (creator, maker, resolver, parlay, wc-*, …)
│   │   ├── src/markets/  SQLite store + REST routes (includes /wc/* endpoints)
│   │   └── src/gamification/  prize/streak/leaderboard state
│   └── web/              Next.js 15 + React 19 + dApp Kit
│       ├── app/
│       │   ├── markets/         CLOB market list + detail
│       │   ├── worldcup/        World Cup 2026 dashboard (groups, fixtures, live ticker)
│       │   │   └── group/[letter]   per-group fixture list
│       │   ├── friends/         follow Sui addresses, see their open positions
│       │   ├── parlay/          parlay builder
│       │   ├── vault/           VLP deposit/withdraw
│       │   ├── portfolio/       user positions
│       │   ├── leaderboard/     weekly top-N (with friends-only filter)
│       │   ├── dispute/[id]/    dispute flow
│       │   ├── admin/           admin panel
│       │   ├── agent-policy/    on-chain agent policy (operator: budget cap, pause/revoke, profile)
│       │   └── agents/          agent decision feed
│       ├── components/   DailyWcCard, FriendPositionsWidget, LivePulse, Celebration, EmptyState (previews + icons), AgentsDownBanner, …
│       └── public/
│           ├── sw.js              offline-shell service worker (R-UAT-FN-17 fix)
│           └── offline.html       static fallback served when SW catches a network error
└── docs/
    ├── architecture.md
    ├── worldcup-2026.md         WC-specific architecture + agent fleet
    ├── gamification.md
    ├── SOP-DEPLOYMENT.md
    ├── SOP-DEEPBOOK-TRADING.md
    ├── agent-prompts.md
    └── demo-script.md
```

## Build & test commands

```bash
pnpm install
pnpm build                # Build all (Move + SDK + agents + web). 0 errors expected.
pnpm contracts:build      # sui move build only
pnpm contracts:test       # 130 Move unit tests
pnpm dev:agents           # http://localhost:3001 — REST + WS
pnpm dev:web              # http://localhost:3000 — UI
pnpm test                 # Agent unit tests (38/38 pass) — runs tsx --test
pnpm --filter @suipredict/sdk test  # SDK unit tests (28/28 pass)
```

`pnpm dev` (and `pnpm dev:web`, `pnpm dev:agents`) run a `predev`
hook that auto-runs `scripts/dev-kill-zombies.sh` to clear
stale `next-server` / `tsx watch` processes squatting on ports
3000-3010. The previous UAT run was blocked by 5 zombie
processes holding 9.1 GB RSS; the predev hook is the fix (see
`UAT-REPORT-FIXES.md` FN-01).

Manual cleanup: `pnpm dev:clean`, `pnpm dev:web:clean`,
`pnpm dev:agents:clean`, `pnpm uat:clean`.

## Key conventions

### Move contracts (`packages/contracts/`)
- Move 2024 edition. Uses `phantom` types for `<YES, NO, QUOTE>` markets.
- One `Move.toml` per package; the canonical published package is
  `AGENT_POLICY_PACKAGE_ID` (and aliases `PREDICT_PACKAGE_ID` /
  `MARKET_PACKAGE_ID`).
- Tests live in `tests/` next to `sources/`. 122/122 pass.
- Every state-mutating public function takes a capability (admin /
  streak admin / etc.) and asserts on the clock when relevant.

### SDK (`packages/sdk/`)
- TypeScript barrel in `src/index.ts` — import from `@suipredict/sdk`.
- PTB builders follow `build<Action>Tx({ ... })` convention.
- Read helpers: `listMarkets()`, `getMarket(id)`, `getMarketOrderBook(id)`, etc.
- **R-WC-1 helper:** `ensureMarketCreated(client, signer, deepbookRegistry, params)`
  tries `create_market` first, falls back to `create_market_with_pool`
  on `EPoolAlreadyExists`. Returns
  `{ marketId, poolId, balanceManagerId, source: "create_market" | "create_market_with_pool" }`.
  Used by `world-cup-creator` to mint a per-WC-match on-chain
  `PredictionMarket` (per-market `BalanceManager` +
  `TreasuryCap<YES<DUSDC>>`, shared DeepBook pool) instead of
  falling back to a SQLite-only ghost row. Companion helper
  `findExistingYesPool(client, deepbookRegistryId, marketPackageId?, quoteType?)`
  walks the DeepBook registry's dynamic fields to find an
  existing `Pool<YES<DUSDC>, DUSDC>`. Both have unit tests in
  `tests/ensure-market-created.test.ts` (5 tests).
- Defensive at build boundary: throws on `price <= 0n`, `quantity <= 0n`,
  `clientOrderId < 0n` or `> u64::MAX` (see `prediction-market-client.ts:1041`).

### Agents (`apps/agents/`)
- TypeScript workers in `src/agents/`. Each exports `runXxx(ctx): Promise<AgentResult>`.
- Schedule built in `src/index.ts:buildSchedule()`. Override any cadence
  with `AGENT_CRON_<NAME>=<cron-expr>` env (e.g.
  `AGENT_CRON_WC_CREATOR=*/1 * * * *` for faster iteration).
- `world-cup-*` agents are the WC 2026 specialists; they coexist with
  the original generic LLM-driven agents.
- The WC fetcher (`world-cup-fetcher.ts`) has 12 groups / 48 teams /
  72 matches hardcoded from the Dec 5 2025 draw with 6h Wikipedia
  re-validation.
- SQLite mirror in `apps/agents/data/markets.db` is the source of
  truth for the web UI's REST endpoints.
- **R-WC-1 refactor (2026-06-17):** the `world-cup-creator` no longer
  catches `EPoolAlreadyExists` and writes a SQLite-only "demo" row.
  It now (a) queries the DeepBook registry to see if a pool
  already exists, (b) checks the agent wallet's SUI + DEEP balance
  against the planned `todo.length` markets (single `noop` with a
  clear "fund with X SUI + Y DEEP" message on underfunded wallets),
  and (c) calls `ensureMarketCreated` for every match. Every WC
  match now gets a real on-chain `PredictionMarket` or surfaces
  a real on-chain failure (no more 46-of-47 ghost markets).
- **`MAX_ACTIVE_WC_MARKETS` default 4** (down from 20) to fit the
  agent wallet's 2.7 SUI + 11.5 DEEP balance. Operators with more
  gas can raise via env.

### Web (`apps/web/`)
- Next.js 15 App Router. Tailwind, dark mode default, mobile-first.
- Server components for static data; client components for any state.
- `useFriends()` (in `lib/friends.ts`) is localStorage-backed — no
  server-side social graph.
- The `Celebration` component fires confetti when the user's streak
  crosses 3/7/14/30/100 days (uses `navigator.vibrate` on Android).
- **R-UAT-FN-13:** `EmptyState` takes `previews: string[]` + `icon`
  prop variants (`wallet` / `parlay` / `vault` / `trade` / `document`)
  so every wallet-gated page renders a distinct "What you'll see
  here" preview list with a per-surface icon (no more 5
  copy-pasted "Wallet Disconnected" templates).
- **R-UAT-FN-07:** `AgentsDownBanner` (`components/AgentsDownBanner.tsx`)
  is a single shared component that any page can render when the
  agents service is unreachable, with a clickable link to
  `/health`. Replaces the previous behaviour where most pages
  returned a 21-byte `Internal Server Error` body.
- **R-UAT-FN-17:** `public/sw.js` is a hand-rolled offline-shell
  service worker (registered from `components/providers-inner.tsx`).
  It only handles `navigate` requests (tries network first, falls
  back to a pre-cached `/offline.html` on network failure) and
  never caches API responses. The legacy `@ducanh2912/next-pwa`
  wrapper was removed in the R48 audit (it served 24h-stale
  HTML via a `NetworkFirst` cache) and the unregister effect
  is now in `providers-inner.tsx` for the migration path.
- **R-UAT-FN-03:** the trade form on a resolved market is replaced
  by a "Market settled" panel with the winner pill, a redeem
  CTA, and links to `/portfolio` + `/markets`. The pre-fix
  behaviour was a "Buy YES" button that submitted on-chain
  PTBs targeting a no-longer-trading market.

## Environment variables

See `.env.example` for the full list. The most critical:

| Var | Required | Purpose |
|-----|----------|---------|
| `SUI_NETWORK` | yes | `testnet` / `mainnet` / `devnet` |
| `AGENT_POLICY_PACKAGE_ID` | on-chain mode | From `sui client publish` |
| `DUSDC_PACKAGE_ID` / `DUSDC_TREASURY_CAP_ID` | on-chain mode | Self-hosted DUSDC |
| `DEEPBOOK_PACKAGE_ID` / `DEEPBOOK_REGISTRY_ID` | on-chain mode | Testnet defaults baked in |
| `AGENT_PRIVATE_KEY` | on-chain mode | Server-side only — never commit |
| `OPENAI_API_KEY` | LLM agents | Optional; blank → deterministic mock |
| `WC_MM_QUOTE_SIZE` | WC maker | 5_000_000 = 5 YES shares per side |
| `MAX_ACTIVE_WC_MARKETS` | WC creator | Cap on simultaneous WC markets |

## Autonomous agents (full fleet)

| Agent | Cadence | File | Role |
|-------|---------|------|------|
| `market-creator` | 0 0 * * * | `market-creator.ts` | LLM proposes market → on-chain `create_market` |
| `market-maker` | */1 * * * * | `market-maker.ts` | Generic spread quoting on DeepBook |
| `market-resolver` | 58 23 * * * | `market-resolver.ts` | LLM + BTC oracle → resolve expired |
| `world-cup-creator` | */15 * * * * | `world-cup-creator.ts` | WC fixtures from Wikipedia → mints per-match on-chain `PredictionMarket` (shared pool, per-market `BalanceManager` + `TreasuryCap<YES<DUSDC>>`); wallet-funding gate pre-checks SUI + DEEP |
| `world-cup-resolver` | */5 * * * * | `world-cup-resolver.ts` | WC scores from Wikipedia → resolve |
| `world-cup-maker` | */2 * * * * | `world-cup-maker.ts` | Elo-based mid + time-decay spread |
| `parlay-worker` | */1 * * * * | `parlay-worker.ts` | Multi-leg parlays within budget |
| `risk-monitor` | */5 * * * * | `risk-monitor.ts` | Pause makers on exposure > cap |
| `referral-keeper` | */15 * * * * | `referral-keeper.ts` | Sweep DeepBook rebates |
| `streak-sweeper` | 2 0 * * * | `streak-sweeper.ts` | Mirror streak events → SQLite |
| `prize-distributor` | 15 0 * * 1 | `prize-distributor.ts` | Sign weekly claim payloads |
| `prize-admin` | 10 0 * * 1 | `prize-admin.ts` | `settle_week` + `rotate_week` |
| `leaderboard-worker` | 5 0 * * 1 | `leaderboard-worker.ts` | Archive weekly scores |
| `position-indexer` | */1 * * * * | `position-indexer.ts` | Tail Sui events → SQLite |

## Things to know when editing

1. **Audit history:** the codebase has 50+ rounds of audit fixes (R40+
   comments). Don't undo these — they're load-bearing.
2. **Both `MARKET_PACKAGE_ID` and `AGENT_POLICY_PACKAGE_ID` point to
   the same package** (one Move package with multiple module
   namespaces). `bootstrapEnv()` reconciles them.
3. **WC markets get seeded by `wc-demo-seed.ts` at boot** so the home
   page is alive in API-only mode (no wallet). The seed is idempotent.
4. **Self-hosted DeepBook is already deployed** (testnet
   `0xdee9…`) — use the `DEEPBOOK_PACKAGE_ID` / `DEEPBOOK_REGISTRY_ID`
   env vars to point to it. The system also supports the
   `deepbook-admin` shortcuts baked into `constants.ts` for
   permissioned `create_pool_admin` flows.
5. **No `bigint` arithmetic with `Number`** — the SDK enforces
   `bigint` for all amounts. See `clampNumberString` in
   `apps/web/lib/forms.ts` for the UI helpers.

## Common pitfalls

| Symptom | Cause | Fix |
|---------|-------|-----|
| `EInvalidPoolType` on referral setup | `pool_id` JSON shape drift | `world-cup-creator.ts:166` normalizes string vs `{id}` wrapper |
| `EExpiryInPast` abort | LLM returned `expiry_days: 0` | `market-creator.ts:171` validates `[1, 30]` |
| Move build warnings about `unused_use` | Pre-existing, can be ignored | `sui move build --silence-warnings` |
| Pool already exists for YES/DUSDC | First market already created | R-WC-1 fix: `ensureMarketCreated` automatically reuses the existing pool via `create_market_with_pool` (no DEEP fee). Every WC match now gets a real on-chain `PredictionMarket`. |
| `world-cup-creator` returns `NEEDS FUNDING: ...` | Agent wallet is underfunded (no SUI for gas, or no DEEP for the first market's pool-creation fee) | Fund the agent address: Sui faucet (https://faucet.sui.io/?network=testnet) for SUI, self-hosted DUSDC/DEEP faucet (POST /faucet/deep) for DEEP |
| `wc-creator` creates 0 markets on a fresh deploy | `existing` count includes pre-R-WC-1 SQLite-only demo rows | The R-WC-1 fix only counts `onchain_market_id IS NOT NULL` markets; the first tick after deploy can backfill up to `MAX_ACTIVE_WC_MARKETS` (default 4) on-chain markets |
| `pnpm build` fails on `tsx` | The `dist/` is stale | `rm -rf apps/agents/dist && pnpm build` |
| Port 3000/3001 already in use on `pnpm dev` | Zombie `next-server` / `tsx watch` from a prior session | `pnpm uat:clean` (or `pnpm dev:clean`) runs `scripts/dev-kill-zombies.sh`. The `predev` hook auto-cleans on every `pnpm dev`. |
| Offline reload shows `chrome-error://chromewebdata/` | No service worker registered | R-UAT-FN-17 fix: `public/sw.js` is registered on first mount; offline navigation now serves `/offline.html` with a "Retry" button. |
| Web `pnpm dev` shows "3 Issues" badge in bottom-left | React hydration warning (nested `<a>` inside `<a>`) | R-UAT-FN-05 fix: market cards are now a single `<Link>` with the SuiVision icon absolutely-positioned + `stopPropagation` to avoid double-firing |

## UAT findings (resolved 2026-06-17)

The previous UAT pass found 19 issues across the web/agents/SDK
stack. The fixes are summarised in `UAT-REPORT-FIXES.md`. The
production-critical ones:

| ID | Sev | Fix | Files |
|----|-----|-----|-------|
| FN-01 | Blocker | `predev` hook auto-runs `scripts/dev-kill-zombies.sh` on every `pnpm dev` | `package.json` |
| FN-02 | High | `/agents` drift panel renders structured env-var table with per-row "Copy" + "Copy all .env lines" for operator remediation | `apps/web/app/agents/page.tsx` |
| FN-03 | High | Resolved markets show "Market settled" banner with winner + redeem CTAs (no more live trade form on settled markets) | `apps/web/app/markets/[id]/page.tsx` |
| FN-04 | High | Visiting a resolved market no longer crashes the dev server's React Client Manifest (SuivisionLink client/server boundary fixed) | `apps/web/components/SuivisionLink.tsx` |
| FN-05 | Med | Market cards are a single `<Link>` (no nested `<a>` hydration warnings) | `apps/web/app/markets/page.tsx` |
| FN-06 | Med | `/settings` 307-redirects to `/agent-policy`; nav shows "Agent Policy" | `apps/web/next.config.ts` |
| FN-07 | Med | Shared `AgentsDownBanner` on every page that talks to the agents service | `components/AgentsDownBanner.tsx` |
| FN-08 | Low | Home banner has a literal space between "72 group-stage matches" and "X active markets" (no `ml-2`-only gap) | `apps/web/app/page.tsx` |
| FN-09 | Low | Home banner says "72 group-stage matches" (was "104 matches") | `apps/web/app/page.tsx` |
| FN-10 | Low | "Live agent activity" feed filters out `PAUSE FAILED` / `QUOTE FAILED` on-chain errors | `components/RecentActivity.tsx` |
| FN-11 | Low | Resolved market badge says "Winner: NO" (was "NO won" — double-negative) | `apps/web/app/{page,markets/page}.tsx` |
| FN-12 | Low | Trade form size input has `max=1000000` + `aria-invalid` toggles | `apps/web/app/markets/[id]/page.tsx` |
| FN-13 | Low | `EmptyState` takes `previews + icon` props; portfolio/parlay/vault each have distinct "What you'll see here" lists | `components/EmptyState.tsx` |
| FN-14 | Low | Geist fonts use `display: 'swap'` + `preload: true`; LCP-improved | `apps/web/app/{layout,globals.css}` |
| FN-15 | Low | `/agents` drift panel is amber (not rose) + collapsed by default; copy-pastable env values | `apps/web/app/agents/page.tsx` |
| FN-16 | Low | "Continue with Google" + "Powered by Enoki zkLogin" on separate lines | `components/ConnectModal.tsx` |
| FN-17 | Low | Hand-rolled `public/sw.js` offline-shell service worker; offline navigation serves `/offline.html` | `public/sw.js`, `components/providers-inner.tsx` |
| FN-18 | Low | Market filter pills have `prefetch={true}` + `aria-current` + `data-testid` for instant nav | `apps/web/app/markets/page.tsx` |
| FN-19 | Low | Top Forecasters widget fetches `/leaderboard/week?limit=5` (was static empty state) | `components/TopForecasters.tsx` |
| **R-WC-1** | **Refactor** | **`world-cup-creator` always mints per-match on-chain `PredictionMarket` (no SQLite-only ghost rows); wallet-funding gate pre-checks SUI + DEEP** | **`apps/agents/src/agents/world-cup-creator.ts`, `packages/sdk/src/prediction-market-client.ts`** |

## Hackathon submission

- **Track:** DeepBook (Specialized) + Agentic Web
- **Pitch:** A multi-market prediction exchange on Sui. DeepBook V3 is
  the CLOB backend; 14 autonomous agents handle the full lifecycle
  (creation, market-making, resolution, parlays, streaks, prizes,
  referrals, risk). The World Cup 2026 is the flagship vertical:
  48 teams, 72 group matches, all driven by Wikipedia scraping + Elo
  pricing + multi-source resolution — no humans in the loop.
- **Demo path:** `docs/demo-script.md` (3 min walk-through).
- **Architecture:** `docs/architecture.md` + `docs/worldcup-2026.md`.
- **SOPs:** `docs/SOP-DEPLOYMENT.md`, `docs/SOP-DEEPBOOK-TRADING.md`.
