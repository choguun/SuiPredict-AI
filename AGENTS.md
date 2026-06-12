# SuiPredict-AI — Project Guide for AI Assistants

> Autonomous AI prediction market on Sui + DeepBook V3 CLOB. MVP pivoted
> to **FIFA World Cup 2026** (June 11 – July 19, 2026). Mobile-first,
> gamified (streaks, leaderboards, friends), 13+ autonomous agents that
> scrape the web for fixture data, run an Elo-based market maker, and
> resolve matches from Wikipedia.

## Repo layout

```
SuiPredict-AI/
├── packages/
│   ├── contracts/        Move 2024 — all on-chain modules
│   │   ├── sources/
│   │   │   ├── prediction_market.move   CLOB market lifecycle (1200 LoC)
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
│   │   └── tests/                        122 unit tests (all pass)
│   └── sdk/              TypeScript SDK (PTB builders + read helpers)
├── apps/
│   ├── agents/           Node 20 + better-sqlite3 — autonomous workers + REST
│   │   ├── src/agents/   13 workers (creator, maker, resolver, parlay, wc-*, …)
│   │   ├── src/markets/  SQLite store + REST routes (includes /wc/* endpoints)
│   │   └── src/gamification/  prize/streak/leaderboard state
│   └── web/              Next.js 15 + React 19 + dApp Kit
│       ├── app/
│       │   ├── markets/         CLOB market list + detail
│       │   ├── worldcup/        World Cup 2026 dashboard (groups, fixtures, live ticker)
│       │   ├── friends/         follow Sui addresses, see their open positions
│       │   ├── parlay/          parlay builder
│       │   ├── leaderboard/     weekly top-N (with friends-only filter)
│       │   ├── portfolio/       user positions
│       │   ├── dispute/[id]/    dispute flow
│       │   ├── admin/           admin panel
│       │   ├── settings/        profile / agent policy
│       │   └── agents/          agent decision feed
│       └── components/   DailyWcCard, FriendPositionsWidget, LivePulse, Celebration, …
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
pnpm contracts:test       # 122 Move unit tests
pnpm dev:agents           # http://localhost:3001 — REST + WS
pnpm dev:web              # http://localhost:3000 — UI
```

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
- Defensive at build boundary: throws on `price <= 0n`, `quantity <= 0n`,
  `clientOrderId < 0n` or `> u64::MAX` (see `prediction-market-client.ts:1041`).

### Agents (`apps/agents/`)
- TypeScript workers in `src/agents/`. Each exports `runXxx(ctx): Promise<AgentResult>`.
- Schedule built in `src/index.ts:buildSchedule()`. Override any cadence
  with `AGENT_CRON_<NAME>=<cron-expr>` env.
- `world-cup-*` agents are the WC 2026 specialists; they coexist with
  the original generic LLM-driven agents.
- The WC fetcher (`world-cup-fetcher.ts`) has 12 groups / 48 teams /
  72 matches hardcoded from the Dec 5 2025 draw with 6h Wikipedia
  re-validation.
- SQLite mirror in `apps/agents/data/markets.db` is the source of
  truth for the web UI's REST endpoints.

### Web (`apps/web/`)
- Next.js 15 App Router. Tailwind, dark mode default, mobile-first.
- Server components for static data; client components for any state.
- `useFriends()` (in `lib/friends.ts`) is localStorage-backed — no
  server-side social graph.
- The `Celebration` component fires confetti when the user's streak
  crosses 3/7/14/30/100 days (uses `navigator.vibrate` on Android).

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
| `world-cup-creator` | */15 * * * * | `world-cup-creator.ts` | WC fixtures from Wikipedia → markets |
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
| Pool already exists for YES/DUSDC | First market already created | Falls back to `demo-*` market in SQLite |
| `pnpm build` fails on `tsx` | The `dist/` is stale | `rm -rf apps/agents/dist && pnpm build` |

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
