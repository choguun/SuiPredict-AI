# Judge E2E Demo Script (3 min)

## Setup

1. `pnpm install && pnpm build`
2. `cp .env.example .env` — fill in deployed contract addresses
3. `pnpm dev:agents` — starts indexer API on :3001, seeds demo markets
4. `pnpm dev:web` — http://localhost:3000

## Demo walkthrough

### 1. Home (20s)

- Active markets count, vault TVL, featured markets
- Narrative: DeepBook V3 CLOB + autonomous agents

### 2. Markets list (20s)

- Open **Markets** — categories, expiry, status, DeepBook pool info
- Open a market (e.g. "BTC above $100k by end of 2026")

### 3. Order book + trading (60s)

- Show bids/asks, spread, mid price (from DeepBook L2 book)
- Explain split: 1 DBUSDC -> 1 YES + 1 NO. Exit pre-resolution by selling YES and NO on the DeepBook CLOB (no on-chain merge). Post-resolution, redeem the winning side for (1 - 0.5% fee) DBUSDC.
- Implied NO price = 1 - YES
- Demo mode: agent-fed book from DeepBook SDK; live mode: on-chain limit order

### 4. Vault (40s)

- **Vault** — TVL, VLP deposit/withdraw DBUSDC
- Explain VLP share model and market-maker capital allocation

### 5. Agents (40s)

- **Agents** page — Creator / Maker / Resolver / Referral Keeper decision feed
- Creator shows market creation tx; Resolver shows LLM reasoning
- Point to transactions on Suiscan (if on-chain mode)

### 6. Portfolio (20s)

- **Portfolio** — YES/NO balances per market
- Redeem section for resolved markets

## Talking points

- Single `prediction_market.move` contract replaces clob + factory + settlement + outcome_tokens
- DeepBook V3 permissionless pool created atomically with market
- 1% mint fee + 0.5% redeem fee + referral rebates fund protocol revenue
- Referral Keeper sweeps trading fee rebates to treasury automatically
- Four agents: Creator, Market Maker, Resolver, Referral Keeper
- Polymarket complement (YES + NO ≈ $1 mid) in Move `mint_shares` + DeepBook order book. There is intentionally no on-chain pre-resolution `merge` — the web UI's "merge" button falls back to "sell YES + sell NO on the order book".

## Backup

- Demo markets in `apps/agents/data/markets.db` if chain unavailable
- Pre-recorded agent feed from `/decisions`
- Build is green: 0 errors across Move + SDK + agents
