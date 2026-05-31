# SuiPredict-AI

**Prediction markets on Sui via DeepBook V3** — create markets, trade YES/NO tokens on a DeepBook CLOB, resolve outcomes with an LLM oracle, and sweep referral rewards automatically. Built for Sui Overflow 2026 (DeepBook track).

[![Sui Overflow 2026](https://img.shields.io/badge/Hackathon-Sui%20Overflow%202026-blue)](https://overflow.sui.io)

## What we built

SuiPredict-AI is a **multi-market prediction exchange** where:

1. **Market Creator** agent deploys a new prediction market — creates a `PredictionMarket` + DeepBook V3 pool + YES/NO coin types in one transaction
2. **Market Maker** agent quotes bid/ask on the DeepBook order book, funded by a vault
3. Users **split** DBUSDC into YES + NO tokens, **trade YES** on the DeepBook CLOB, then **redeem** winners after resolution
4. **Market Resolver** agent determines outcomes via LLM (with BTC price oracle fallback)
5. **Referral Keeper** agent sweeps accumulated DeepBook trading fee rebates to the protocol treasury

**Polymarket complement:** `split(1 DBUSDC) -> 1 YES + 1 NO` and `merge(1 YES + 1 NO) -> 1 DBUSDC`. The UI shows implied NO price as `1 - YES`.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                    │
│    /markets  /vault  /portfolio  /agents                     │
└──────────┬────────────────┬──────────────┬─────────────────┘
           │                │              │
           ▼                ▼              ▼
┌──────────────────────────────────────────────────────────────┐
│                      Agents Service (:3001)                   │
│   MarketCreator │ MarketMaker │ MarketResolver │ ReferralKeeper│
│                  SQLite indexer                              │
└──────────┬────────────────┬──────────────────┬────────────────┘
           │                │                  │
           ▼                ▼                  ▼
┌──────────────────────────────────────────────────────────────┐
│                      Move Contracts (testnet)                 │
│  prediction_market.move   vault.move   registry.move   vlp.move │
│  DeepBook V3 (external)  ──────────────────────────────────  │
│  Pool: YES/DBUSDC  │  Mint fee: 1%  │  Redeem fee: 0.5%     │
└──────────────────────────────────────────────────────────────┘
```

### Contract stack

| File | Purpose |
|------|---------|
| `prediction_market.move` | Market lifecycle, split/merge, DeepBook pool creation, mint/redeem fees, referral system, DEEP reserve |
| `vault.move` | Protocol vault (VLP), deposit/withdraw, market-maker capital allocation |
| `registry.move` | Global market registry (admin-only) |
| `vlp.move` | VLP liquidity token (vault share) |
| `types.move` | Market struct, helpers |

### Agents

| Agent | Role |
|-------|------|
| **MarketCreator** | Creates markets with DeepBook V3 pool + referral setup |
| **MarketMaker** | Places bid/ask limit orders on DeepBook, reads pool key per-market |
| **MarketResolver** | LLM oracle + BTC price fallback to resolve markets |
| **ReferralKeeper** | Sweeps DeepBook trading fee rebates to treasury |

## Quick start

### Prerequisites

- Node.js 20+, [pnpm](https://pnpm.io), [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install)
- Testnet **SUI** (faucet); **DBUSDC** via DeepBook testnet faucet

### Install

```bash
git clone https://github.com/choguun/SuiPredict-AI.git
cd SuiPredict-AI
pnpm install
cp .env.example .env
pnpm build
```

### Demo mode (no on-chain deploy)

The agents service seeds demo markets and serves the indexer API without a wallet:

```bash
pnpm dev:agents   # http://localhost:3001 — /markets, /decisions, etc.
pnpm dev:web       # http://localhost:3000 — Markets, Vault, Portfolio
```

Open **Markets** -> pick a demo market -> view live order book (agent-fed quotes).

### On-chain mode (testnet)

Fill in `.env` (see [.env.example](.env.example) for all variables):

```bash
# Required:
PREDICT_MARKET_PACKAGE_ID=   # deployed prediction_market.move package
FEE_VAULT_ID=                # FeeVault object ID from deployment
REFERRAL_TREASURY_ADDRESS=  # your treasury wallet
AGENT_PRIVATE_KEY=           # agent hot wallet (suiprivkey or hex)
OPENAI_API_KEY=              # LLM for MarketResolver

# DeepBook V3 (testnet):
DEEPBOOK_PACKAGE_ID=0xdee9
DEEPBOOK_REGISTRY_ID=0xe0ce

pnpm dev:agents
```

### Deploy Move contracts (testnet)

```bash
cd packages/contracts
sui client publish --gas-budget 500000000
```

After publish, set `PREDICT_MARKET_PACKAGE_ID` in `.env`.

## Frontend routes

| Route | Description |
|-------|-------------|
| `/` | Hero, featured markets, vault TVL |
| `/markets` | Market list (category, expiry, status) |
| `/markets/[id]` | Order book, YES/NO tabs, split/merge, redeem |
| `/vault` | Deposit/withdraw DBUSDC <-> VLP |
| `/portfolio` | YES/NO balances per market |
| `/agents` | Decision feed for all agents |

## Indexer & agent API (`:3001`)

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Service status |
| `GET /markets` | All markets (from SQLite) |
| `GET /markets/:id` | Market metadata, expiry, outcome, DeepBook pool info |
| `GET /markets/:id/book` | L2 bids/asks, spread, mid price |
| `GET /decisions` | Agent decision log |
| `GET /stats` | Agent action counts |

## Project structure

```
apps/
  web/                 Next.js frontend
  agents/              Autonomous agents + markets indexer API
    src/agents/
      market-creator.ts   creates markets + DeepBook pools + referrals
      market-maker.ts     DeepBook bid/ask liquidity (per-market pool)
      market-resolver.ts  LLM oracle + BTC fallback
      referral-keeper.ts   sweeps DeepBook referral rewards to treasury
    src/markets/
      store.ts            SQLite market store (id, pool_key, referral_id, ...)
packages/
  contracts/
    sources/
      prediction_market.move   DeepBook V3 integrated market (replaces CLOB)
      vault.move              VLP vault
      registry.move           Market registry
      types.move              Market struct
  sdk/
    src/
      prediction-market-client.ts  PTB builders (create, mint, redeem, resolve, referral)
      deepbook/                    DeepBook V3 client (order book, place orders)
      markets/                     Market types + store client
docs/
  architecture.md     Sequence diagrams, contract interactions
  demo-script.md      Judge walkthrough
  agent-prompts.md    Agent prompt engineering
```

## Environment variables

Full list in [.env.example](.env.example). Key variables:

| Variable | Description |
|----------|-------------|
| `PREDICT_MARKET_PACKAGE_ID` | Deployed `prediction_market.move` package |
| `FEE_VAULT_ID` | FeeVault object ID |
| `REFERRAL_TREASURY_ADDRESS` | Protocol treasury for referral rewards |
| `AGENT_PRIVATE_KEY` | Agent wallet (server-side only) |
| `DEEPBOOK_PACKAGE_ID` | DeepBook V3 package (default: `0xdee9`) |
| `DEEPBOOK_REGISTRY_ID` | DeepBook Registry (default: `0xe0ce`) |
| `OPENAI_API_KEY` | LLM for MarketResolver |
| `MM_SPREAD_THRESHOLD_BPS` | Market maker spread threshold (default `400`) |
| `MAX_ACTIVE_MARKETS` | Creator cap (default `5`) |

## Development

```bash
pnpm build              # Build all packages (Move + SDK + agents + web)
pnpm dev                # Turbo dev (web + agents)
pnpm contracts:build    # Move compile only
pnpm contracts:test     # Move unit tests
```

**Build status:** 0 errors across Move, SDK, and agents packages.

## Hackathon submission

- **Track:** DeepBook (Specialized)
- **Demo script:** [docs/demo-script.md](docs/demo-script.md)
- **Architecture:** [docs/architecture.md](docs/architecture.md)
- **Agent prompts:** [docs/agent-prompts.md](docs/agent-prompts.md)

**Judge narrative:** Polymarket-style prediction market on Sui using DeepBook V3 as the CLOB backend. A single `prediction_market.move` contract handles market creation, YES/NO split/merge, DeepBook pool creation with referral tracking, and mint/redeem with fee harvesting. Four autonomous agents manage the full lifecycle: Creator deploys markets, Market Maker quotes the order book, Resolver determines outcomes, and Referral Keeper sweeps trading fee rebates to treasury.

## License

Apache 2.0 — see [LICENSE](LICENSE).
