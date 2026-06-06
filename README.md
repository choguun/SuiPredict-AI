# SuiPredict-AI

**Autonomous prediction markets on Sui** — DeepBook V3 CLOB for trading, Move contracts for vault/prizes/streaks/parlays, and a fleet of LLM-driven agents that runs the exchange end-to-end. Built for Sui Overflow 2026 (DeepBook track).

[![Sui Overflow 2026](https://img.shields.io/badge/Hackathon-Sui%20Overflow%202026-blue)](https://overflow.sui.io)

## What it does

1. **Market Creator** agent proposes a market → deploys a `PredictionMarket`, opens a DeepBook V3 YES/DBUSDC pool, and wires the referral in a single PTB
2. **Market Maker** agent quotes bid/ask on the order book, funded by a shared `ProtocolVault` so LPs earn trading fees
3. Users **split** DBUSDC into YES + NO tokens, **trade YES** on the CLOB, **redeem** winners after resolution
4. **Market Resolver** agent determines outcomes via LLM (with BTC oracle fallback)
5. **Parlay Worker** builds multi-leg parlays with a 5× payout cap and a risk-aware market selection
6. **Prize Distributor** + **Streak Sweeper** + **Leaderboard Worker** run a weekly prediction game: streaks give multipliers, top-N forecasters split the `PrizePool`
7. **Referral Keeper** sweeps DeepBook trading-fee rebates to the protocol treasury
8. **Risk Monitor** pauses creator/maker actions if MM exposure exceeds the configured utilization cap

## Repository layout

```
.
├── packages/
│   ├── contracts/   Move 2024 — all on-chain modules
│   │   └── sources/
│   │       ├── agent_policy.move     agent permissions, pause/revoke
│   │       ├── badge_nft.move        tier-based achievement NFTs
│   │       ├── parlay.move           multi-leg parlay pool + claims
│   │       ├── prediction_market.move CLOB market lifecycle (1200 LoC)
│   │       ├── prize_pool.move       weekly prize distribution
│   │       ├── registry.move         market registry
│   │       ├── streak_system.move    daily streak + multipliers
│   │       ├── user_profile.move     country/forecaster-kind registry
│   │       ├── vault.move            ProtocolVault<DBUSDC> (TVL)
│   │       ├── vlp.move              VLP share token
│   │       └── types.move            shared structs / events
│   └── sdk/         TypeScript SDK (PTB builders + read helpers)
│       └── src/
│           ├── prediction-market-client.ts   CLOB market PTBs
│           ├── parlay-client.ts              parlay PTBs
│           ├── prize-client.ts               prize pool PTBs
│           ├── streak-client.ts              streak PTBs
│           ├── badge-nft-client.ts           badge PTBs
│           ├── user-profile-client.ts        profile PTBs
│           ├── vault-client.ts               vault PTBs
│           ├── deepbook/                     DeepBook V3 wrappers
│           └── protocol-reads.ts             on-chain state readers
└── apps/
    ├── agents/      Node 20 + better-sqlite3 — autonomous workers + REST
    │   └── src/
    │       ├── agents/    11 workers (creator, maker, resolver, parlay, …)
    │       ├── markets/   SQLite store + REST routes
    │       ├── gamification/  prize/streak/leaderboard state
    │       └── index.ts   HTTP server (default :3001)
    └── web/         Next.js 15 + React 19 + dApp Kit
        └── app/
            ├── markets/         CLOB markets list + detail
            ├── parlay/          parlay builder
            ├── vault/           VLP deposit/withdraw
            ├── portfolio/       user positions
            ├── leaderboard/     weekly top-N
            ├── dispute/[id]/    dispute flow
            ├── admin/           admin panel
            ├── settings/        profile / agent policy
            └── agents/          agent decision feed
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      Frontend (Next.js 15)                    │
│   /markets  /parlay  /vault  /portfolio  /admin  /agents      │
└──────────┬─────────────────────┬─────────────────┬────────────┘
           │ gRPC + REST         │ zkLogin         │
           ▼                     ▼                 ▼
┌──────────────────────────────────────────────────────────────┐
│                    Agents Service (:3001)                     │
│  Creator  │ Maker  │ Resolver  │ Parlay  │ RiskMonitor  …    │
│  StreakSweeper │ PrizeDistributor │ PrizeAdmin │ Leaderboard │
│  ReferralKeeper │ PositionIndexer                              │
│                  SQLite (markets.db, decisions.db)             │
└──────────┬─────────────────────┬─────────────────┬────────────┘
           │ gRPC (Mysten)       │ REST (Sui)     │
           ▼                     ▼                 ▼
┌──────────────────────────────────────────────────────────────┐
│                       Move Contracts (Sui)                   │
│  prediction_market  vault  vlp  parlay  prize_pool             │
│  streak_system  user_profile  badge_nft  agent_policy          │
│  DeepBook V3 (external, testnet `0xdee9`)                      │
└──────────────────────────────────────────────────────────────┘
```

### Agent fleet

| Agent | Cadence | Role |
|-------|---------|------|
| `market-creator` | 5 min | Propose market → create + DeepBook pool + referral |
| `market-maker` | 5 min | Bid/ask quotes on each market's DeepBook pool |
| `market-resolver` | 5 min | LLM oracle + BTC fallback → resolve expired markets |
| `parlay-worker` | 5 min | Build + submit multi-leg parlays within budget |
| `risk-monitor` | 5 min | Pause creators/makers when exposure > `RISK_PAUSE_UTILIZATION` |
| `referral-keeper` | 5 min | Sweep DeepBook referral rebates to treasury |
| `streak-sweeper` | 1 h | Mirror on-chain streak events into SQLite |
| `prize-distributor` | weekly | Sanity-check + sign claim payloads for top-N |
| `prize-admin` | weekly | `settle_week` + `rotate_week` on the `PrizePool` |
| `leaderboard-worker` | weekly | Archive prior week's daily scores |
| `position-indexer` | 5 min | Tail Sui events into positions / markets tables |

## Quick start

### Prerequisites

- Node.js 20+, [pnpm](https://pnpm.io) 9.x, [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install) (`sui` on `PATH`)
- Testnet SUI (faucet) + DBUSDC (Mysten Labs testnet `dusdc` package)

### Install

```bash
git clone https://github.com/choguun/SuiPredict-AI.git
cd SuiPredict-AI
pnpm install
cp .env.example .env
pnpm build           # builds contracts (Move), sdk, agents, web in dep order
```

### Demo mode (no deploy)

The agents service ships with demo markets so the indexer returns data without any on-chain state. The web `/markets` page renders the demo book.

```bash
pnpm dev:agents      # http://localhost:3001  — /markets, /decisions, /stats
pnpm dev:web         # http://localhost:3000  — UI
```

If `AGENT_POLICY_PACKAGE_ID` and the shared-object IDs are blank, the workers run in **dry-run** mode: they log every decision to `/decisions` but never sign or submit a transaction. This is the recommended mode for UI development.

### On-chain mode (testnet)

See **[docs/SOP-DEPLOYMENT.md](docs/SOP-DEPLOYMENT.md)** for the full procedure (publish → bootstrap → bootstrap-parlay → verify-config → launch). The short version:

```bash
# 1. Publish the Move package (one-time, costs ~5 SUI of gas)
cd packages/contracts
sui client publish --gas-budget 500_000_000 --json \
  | jq -r '.objectChanges[] | select(.type=="published").packageId' \
    > ../../.AGENT_POLICY_PACKAGE_ID
echo "AGENT_POLICY_PACKAGE_ID=$(cat ../../.AGENT_POLICY_PACKAGE_ID)" >> ../../.env

# 2. Bootstrap the shared objects (FeeVault, PrizePool, StreakRegistry, …)
cd ../..
pnpm --filter @suipredict/agents bootstrap
pnpm --filter @suipredict/agents bootstrap-parlay

# 3. Verify everything is on-chain
pnpm --filter @suipredict/agents verify-config

# 4. Run the agents service
pnpm dev:agents
```

The full SOP covers mainnet preparation, gas budgeting, agent key custody, secrets handling, and rollback.

## Frontend routes

| Route | Description |
|-------|-------------|
| `/` | Home — featured markets, vault TVL, agent feed |
| `/markets` | CLOB market list (category, status, expiry) |
| `/markets/[id]` | Order book, YES/NO tabs, split/merge, redeem |
| `/parlay` | Multi-leg parlay builder (5× payout cap) |
| `/vault` | Deposit/withdraw DBUSDC ↔ VLP |
| `/portfolio` | YES/NO balances per market |
| `/leaderboard` | Weekly top-N forecasters |
| `/dispute/[marketId]` | Submit dispute evidence for a market |
| `/settings` | User profile + agent policy management |
| `/admin` | Operator panel (FeeVault withdraw, distribution, resolution) |
| `/agents` | Live decision feed for all 11 workers |
| `/auth` | Enoki zkLogin OAuth callback |

## Agent REST API (`:3001`)

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Liveness + last-tick timestamp per agent |
| `GET /markets` | All markets from SQLite |
| `GET /markets/:id` | Market metadata + DeepBook pool info |
| `GET /markets/:id/book` | L2 bids/asks, spread, mid price |
| `GET /markets/:id/trades` | Recent trades |
| `GET /decisions` | Decision log (last N, paginated) |
| `GET /stats` | Per-agent action counts + success rate |
| `GET /parlay/user/:addr` | User's parlay history |
| `GET /parlay/:id` | Single-parlay detail with legs |
| `GET /leaderboard/weekly` | Archived weekly top-N |
| `GET /streak/:addr` | User's streak info |
| `GET /prize/pool` | On-chain `PrizePool` snapshot |
| `GET /prize/signature` | Sign a weekly claim payload (prize-admin only) |

The full route map is in `apps/agents/src/markets/routes.ts` and `apps/agents/src/gamification/routes.ts`.

## Environment variables

See **[.env.example](.env.example)** for the full list. Key groups:

| Group | Required for | Notes |
|-------|--------------|-------|
| `SUI_NETWORK` / `SUI_RPC_URL` / `SUI_GRPC_URL` | everything | Defaults to public Mysten endpoints |
| `AGENT_POLICY_PACKAGE_ID` | on-chain mode | From `sui client publish` |
| `FEE_VAULT_ID`, `STREAK_*_ID`, `PRIZE_*_ID`, `PARLAY_POOL_ID` | on-chain mode | Written by `bootstrap` / `bootstrap-parlay` |
| `DUSDC_PACKAGE_ID` / `DUSDC_TREASURY_CAP_ID` | on-chain mode | For self-hosted DUSDC. Defaults to Mysten Labs testnet DUSDC. |
| `DEEPBOOK_PACKAGE_ID` / `DEEPBOOK_REGISTRY_ID` | on-chain mode | Testnet defaults baked in (`0xdee9` / `0xe0ce`) |
| `AGENT_PRIVATE_KEY` | on-chain mode | Base58 ed25519 secret — server-side only |
| `PRIZE_ADMIN_PRIVATE_KEY` | prize distribution | Base64 ed25519; signs weekly claim payloads |
| `OPENAI_API_KEY` | LLM agents | market-creator / market-resolver; blank → deterministic mock |
| `PORT` | agents service | Defaults to 3001 |
| `LOG_LEVEL` | agents service | `debug` / `info` / `warn` / `error` |
| `RISK_PAUSE_UTILIZATION` | risk monitor | Pause threshold (0-1, default 0.80) |
| `RESOLVER_CONFIDENCE` | market-resolver | LLM confidence gate (0-100, default 85) |

## Development

```bash
pnpm build                # Build all packages (Move + SDK + agents + web)
pnpm dev                  # Turbo dev (web + agents, parallel)
pnpm dev:web              # Frontend only
pnpm dev:agents           # Agents service only
pnpm contracts:build      # Move compile only (no publish)
pnpm contracts:test       # Move unit tests
pnpm --filter @suipredict/agents smoke-test  # End-to-end: mint → place order
```

### Build outputs

| Package | Output |
|---------|--------|
| `contracts` | Move bytecode (no on-disk artifact; deploys via `sui client publish`) |
| `sdk` | `packages/sdk/dist/` (TypeScript → JS) |
| `agents` | `apps/agents/dist/` (run via `node dist/index.js`) |
| `web` | `apps/web/.next/` (Next.js standalone) |

## Deployment

See **[docs/SOP-DEPLOYMENT.md](docs/SOP-DEPLOYMENT.md)** for the full procedure — fresh install, redeploy, key rotation, rollback, and mainnet hardening. Highlights:

- **`pnpm build`** must pass clean (`0 errors`) before any deploy
- Publish via `sui client publish --json` and capture the package ID with `jq`
- `bootstrap` is **idempotent** — re-runs are safe; use `resume-bootstrap --only <step>` to recover from partial runs
- `verify-config` re-reads every shared-object ID on-chain and exits non-zero on any mismatch
- Web deploys to Vercel (see `apps/web/vercel.json`); agents to any Node 20 host with persistent disk for the SQLite DBs
- `AGENT_PRIVATE_KEY` and `PRIZE_ADMIN_PRIVATE_KEY` are the two secrets that grant on-chain write authority — never commit, never log, rotate via `rotate-prize-pubkey.ts` / `rotate-prize-admin-address.ts`

## Hackathon submission

- **Track:** DeepBook (Specialized)
- **Demo script:** [docs/demo-script.md](docs/demo-script.md)
- **Architecture:** [docs/architecture.md](docs/architecture.md)
- **DeepBook trading SOP:** [docs/SOP-DEEPBOOK-TRADING.md](docs/SOP-DEEPBOOK-TRADING.md)
- **Deployment SOP:** [docs/SOP-DEPLOYMENT.md](docs/SOP-DEPLOYMENT.md)
- **Agent prompts:** [docs/agent-prompts.md](docs/agent-prompts.md)

**Judge narrative:** A multi-market prediction exchange on Sui. DeepBook V3 is the CLOB backend; eleven autonomous agents handle the full lifecycle (creation, market-making, resolution, parlays, streaks, prizes, referrals, risk). A single Move package composes the market, vault, parlay, and prize-pool modules so a deployer can spin up the full exchange with one PTB.

## License

Apache 2.0 — see [LICENSE](LICENSE).
