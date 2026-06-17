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
- **R-WC-1.2 follow-up (CoinRegistry circuit-breaker):** the
  Sui system `CoinRegistry` allows only one
  `Currency<YES<DUSDC>>` per package, so the on-chain `create_market`
  aborts with `ECurrencyAlreadyExists` after the first market. The
  agent now trips a persistent circuit-breaker (file:
  `apps/agents/data/wc-creator-circuit-breaker.json`) on the
  first occurrence and short-circuits subsequent ticks
  (no PTB calls, no gas spend). The `/agents` page renders a
  banner with the trip time + first-error market + a one-click
  `Reset breaker` action. The breaker auto-resets if a market is
  ever successfully created (e.g. after a contract upgrade to
  per-market coin types). See
  `docs/SOP-DEPLOYMENT.md#coinregistry-limit` for the full
  operational story.
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
| `wc-creator` creates 1 market then `ECurrencyAlreadyExists` for every subsequent market | Sui CoinRegistry allows only one `Currency<YES<DUSDC>>` per package | R-WC-1.2 fix: the agent trips a circuit-breaker (`apps/agents/data/wc-creator-circuit-breaker.json`) and short-circuits subsequent ticks. The `/agents` page renders a banner with the trip details + a one-click reset. Long-term fix: upgrade the contract to per-market coin types (`YES<DUSDC, MarketId>`). See `docs/SOP-DEPLOYMENT.md#coinregistry-limit`. |
| `/wc/circuit-breaker` returns `{coinRegistryFull: true, resetAt: null}` after a contract upgrade | The breaker is sticky; the agent doesn't auto-reset until a market is successfully created | R-WC-1.2 fix: POST `{action: "reset"}` to `/wc/circuit-breaker` (or click `Reset breaker` on `/agents`). The wc-creator will retry on the next tick; if the contract still aborts the breaker re-trips. |
| `wc-creator` aborts `CommandArgumentError { arg_idx: 1, kind: TypeMismatch }` on every `create_market` tick | Stale `WC_FALLBACK_POOL_ID` from a previous publish whose `YES<Q>` generic lives in a different package | R-WC-1.6 fix: set `WC_FALLBACK_POOL_ID=__DISABLED__` to skip the fallback entirely. The wc-creator pays 500 DEEP for the first market's pool-creation fee; subsequent markets reuse the pool via `create_market_with_pool`. Railway's CLI rejects empty env values, so `__DISABLED__` is the operator-friendly opt-out (honoured in both the agent's local call site and the SDK's `ensureMarketCreated`). |
| MarketMaker aborts `EBalanceManagerBalanceTooLow` (code 3 in `balance_manager::withdraw_with_proof`) for every bid even though the BM has DUSDC | Agent wallet has 11 zero-balance DUSDC coin objects but no actual DUSDC balance; the maker's per-tick self-mint path is silently failing in the catch block | R-WC-1.7 fix: run `apps/agents/scripts/topup-bm-dusdc.ts` to mint 10k USDC → deposit to the BM directly. The maker resumes quoting on the next tick. Long-term: the `agent_policy::authorize_spend` budget must be high enough to cover the per-tick cost (raise `AGENT_MAX_BUDGET_USDC`). |
| MarketMaker aborts `CommandArgumentError { arg_idx: 0, TypeMismatch }` in command 1 of the order PTB | The SQLite mirror holds non-worldcup markets whose `deepbook_pool_id` was registered against a previous `prediction_market` package whose `YES<Q>` type lives in a different Move package | R-WC-1.7 fix: the maker now does a pool-type pre-flight before submitting the PTB — it queries the on-chain type via `sui_getObject` and skips markets whose `YES` coin type doesn't match the current `MARKET_PACKAGE_ID`'s `prediction_market::YES<Q>`. The skip decision surfaces the pool's full type + the expected prefix in the `/decisions` feed. |
| AgentPolicy silently stops authorising after `spent == max_budget` | The `agent_policy` Move module has no `rotate_budget` — only `create_policy`. The `authorize_spend` abort with `EBudgetExceeded` (code 5) is non-recoverable until `policy.expires_at`. | Run `apps/agents/scripts/create-fresh-policy.ts` to issue a new `AgentPolicy` with a fresh budget + 90-day expiry. The new policy id is written to `apps/agents/data/agent-policy-id.txt` for operator copy-paste into `AGENT_POLICY_ID` + `NEXT_PUBLIC_AGENT_POLICY_ID` on Railway + Vercel. |
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
| **R-WC-1.1** | **Fix** | **6 post-R-WC-1 gaps: `openConnectModal` exports wired to all 3 call sites; `sw.js` SW_VERSION=1.0.0 (was `__SW_VERSION__`); first-error surfaced in `recordResult` reasoning; `@ducanh2912/next-pwa` dead dep removed; `findExistingYesPool` paginates + decodes SDK-wrapper gRPC shape + defaults to `PREDICT_MARKET_PACKAGE_ID`** | **`apps/web/{app/parlay,app/portfolio,app/vault}/page.tsx`, `apps/web/public/sw.js`, `apps/agents/src/agents/world-cup-creator.ts`, `packages/sdk/src/prediction-market-client.ts`** |
| **R-WC-1.2** | **Fix** | **CoinRegistry limit handled: `world-cup-creator` trips a circuit-breaker on first `ECurrencyAlreadyExists` and short-circuits subsequent ticks (no gas spend on 44 identical MoveAborts). Hardcoded the real self-hosted testnet pool id `0xddd7cbe…` (not `0xefb1e58a…` — that one was from the old market package and would cause a Move-level type mismatch). Per-market inter-PTB delay (5s default) to clear the Sui public-RPC rate-limit window. UI: unified `MarketStatusBadge` on home/markets/markets-[id]/worldcup, `CoinRegistryLimitBanner` with localStorage dismiss, `/wc/circuit-breaker` REST endpoint + `/agents` reset button. `bootstrap-wc-markets.mjs` short-circuits on the first `ECurrencyAlreadyExists`. Docs: `docs/SOP-DEPLOYMENT.md#coinregistry-limit` full recovery checklist.** | **`apps/agents/src/agents/wc-creator-circuit-breaker.ts`, `apps/agents/src/agents/world-cup-creator.ts`, `apps/agents/src/index.ts`, `apps/agents/scripts/bootstrap-wc-markets.mjs`, `apps/web/components/{MarketStatusBadge,CoinRegistryLimitBanner}.tsx`, `apps/web/app/{page,markets/page,markets/[id]/page,worldcup/page,agents/page}.tsx`, `docs/SOP-DEPLOYMENT.md`, `README.md`, `AGENTS.md`** |
| **R-WC-1.6** | **Fix** | **`WC_FALLBACK_POOL_ID=__DISABLED__` sentinel: skip the orphan-pool fallback entirely (the SDK was re-reading `process.env` directly, so the wc-creator's local guard wasn't enough). The agent and the SDK both honour the sentinel and pay 500 DEEP for the first market's pool-creation fee instead. Operator-friendly opt-out for Railway's CLI which rejects empty env values. Companion helpers: `apps/agents/scripts/create-fresh-policy.ts` (issue a fresh `AgentPolicy` with a fresh budget — the module has no `rotate_budget`) and `apps/agents/scripts/topup-bm-dusdc.ts` (mint 10k USDC → deposit to BM directly when the maker's per-tick self-mint silently fails).** | **`apps/agents/src/agents/world-cup-creator.ts`, `packages/sdk/src/prediction-market-client.ts`, `apps/agents/scripts/create-fresh-policy.ts`, `apps/agents/scripts/topup-bm-dusdc.ts`, `docs/SOP-DEPLOYMENT.md`, `README.md`, `AGENTS.md`** |
| **R-WC-1.7** | **Fix** | **Two stale-state classes of errors on multi-package deployments. (1) The gRPC client's `SimulationError` rendering formats the `MoveAbort` as `MoveAbort in 1st command, abort code: 1, in '<pkg>::registry::register_pool'` — without the literal `EPoolAlreadyExists` abort name. The SDK's `ensureMarketCreated` filter only matched the JSON-RPC rendering shape, so the wc-creator's catch block silently re-threw on every gRPC call and the create_market_with_pool recovery path was never reached. (2) The MarketMaker's `place_limit_order` aborts with `CommandArgumentError { arg_idx: 0, TypeMismatch }` when the SQLite mirror carries pool ids from older `prediction_market` publishes (different `YES<Q>` package). The maker now does a pool-type pre-flight (queries the on-chain type via `sui_getObject`, skips markets whose `YES` coin type doesn't match the current `MARKET_PACKAGE_ID`'s `prediction_market::YES<Q>`). Companion diagnostic scripts: `apps/agents/scripts/test-create-market.ts` + `apps/agents/scripts/diag-mm-setup.ts` (the Railway log line truncates at the apostrophe, so these scripts surface the uncut gRPC SimulationError for debugging).** | **`apps/agents/src/agents/market-maker.ts`, `packages/sdk/src/prediction-market-client.ts`, `apps/agents/scripts/test-create-market.ts`, `apps/agents/scripts/diag-mm-setup.ts`, `docs/SOP-DEPLOYMENT.md`, `README.md`, `AGENTS.md`** |

## Multi-package deployment reality (post-R-WC-1.7)

The original `AGENTS.md` / `README.md` claim that `MARKET_PACKAGE_ID`
and `AGENT_POLICY_PACKAGE_ID` are aliases of the same Move package
**is no longer true for the current on-chain state**. Partial
republishes have left the deployment pointing at five different
package ids across shared objects:

| Object | Env var | On-chain type's package |
|---|---|---|
| `AGENT_POLICY_ID` (now `0xb624f2fc…`) | `AGENT_POLICY_ID` / `NEXT_PUBLIC_AGENT_POLICY_ID` | `0xb1777f16…` (only `agent_policy` module deployed) |
| `MARKET_REGISTRY_ID`, `VAULT_OBJECT_ID`, `NEXT_PUBLIC_PROFILE_REGISTRY_ID` | per-id envs | `0x23b78cab…` (`registry::MarketRegistry`, `vault::ProtocolVault`, `user_profile::ProfileRegistry`) |
| `FEE_VAULT_ID` | `FEE_VAULT_ID` | `0x822d7123…` (`prediction_market::FeeVault`) |
| `AGENT_MANAGER_ID` | `AGENT_MANAGER_ID` | `0xf5ea2b37…` (`predict_manager::PredictManager`) |
| `DEEPBOOK_REGISTRY_ID` | `DEEPBOOK_REGISTRY_ID` | `0xc93ae84…` (Sui system DeepBook V3 — `registry::Registry`) |
| `WC_FALLBACK_POOL_ID` (orphan pool) | `WC_FALLBACK_POOL_ID` | `0xed3e3613…` (`prediction_market::YES<DUSDC>`) |

**Implications for the wc-creator + mm:**

- `MARKET_PACKAGE_ID=0xed3e3613…` aligns `buildCreateMarketTx` /
  `create_market_with_pool` with the orphan pool's `YES<Q>` type.
  This is the canonical alignment; the wc-creator's first tick
  after deploy now successfully creates a WC market via
  `create_market_with_pool` against the orphan pool, then trips
  the R-WC-1.2 CoinRegistry circuit-breaker.
- `AGENT_POLICY_PACKAGE_ID=0xb1777f16…` remains separate because
  the existing `AgentPolicy` was created against this package.
  The MM's `authorize_spend` Move call uses `process.env.AGENT_POLICY_PACKAGE_ID`
  directly (not the SDK's `PKG()` resolver), so the two-package
  split works without conflict.
- `agent_policy.move` has no `rotate_budget` — once the policy's
  `spent` hits `max_budget`, you must create a new policy
  (use `apps/agents/scripts/create-fresh-policy.ts`). Raise
  `AGENT_MAX_BUDGET_USDC` to a 6-figure value before going to
  production to avoid per-day resets.

**Long-term resolution:** publish a fresh, single Move package
where `prediction_market`, `agent_policy`, `vault`, `registry`,
`user_profile`, etc. all live at one address with matching shared
objects. The R-WC-1 / R-WC-1.6 / R-WC-1.7 fixes above are the
**stop-gap** for the current deployment.

## Operator scripts (post-R-WC-1.6)

| Script | When to run |
|---|---|
| `apps/agents/scripts/create-fresh-policy.ts` | After `authorize_spend` starts aborting with `EBudgetExceeded` (code 5). Issues a new `AgentPolicy` with `$100k` budget + 90-day expiry. Output: prints new policy id + writes to `apps/agents/data/agent-policy-id.txt` for operator copy-paste. |
| `apps/agents/scripts/topup-bm-dusdc.ts` | After MarketMaker's `quote_failed` pattern repeats with `EBalanceManagerBalanceTooLow` (code 3). Mints 10k USDC → deposit to BM directly. The maker resumes on next tick. |
| `apps/agents/scripts/test-create-market.ts` | When the wc-creator's `create_market` aborts at Sui gRPC simulation time. Runs the SDK call locally and prints the uncut `SimulationError` (Railway logs truncate at the apostrophe in the error string). |
| `apps/agents/scripts/diag-mm-setup.ts` | When the MarketMaker's setup PTB (deposit + authorize_spend) aborts. Same as above for the maker's path — uncut gRPC error. |

All four scripts honour the standard env load order
(`set -a; source ../../.env; set +a`) and run via
`cd apps/agents && npx tsx scripts/<name>.ts`.

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
