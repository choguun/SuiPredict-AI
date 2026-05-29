# Judge E2E Demo Script (3 min + optional legacy)

## Setup

1. `pnpm install && pnpm --filter @suipredict/sdk build`
2. `pnpm dev:agents` — seeds demo markets + indexer API on :3001
3. `pnpm dev:web` — http://localhost:3000
4. Optional on-chain: publish Move package, set `MARKET_REGISTRY_ID`, `VAULT_OBJECT_ID`, wallet DBUSDC + SUI

## Primary: Polymarket CLOB (3 min)

### 1. Home (20s)

- Active markets count, vault TVL, featured markets
- Narrative: vault → agents → CLOB → resolve

### 2. Markets list (20s)

- Open **Markets** — categories, expiry, status
- Open a market (e.g. BTC $100k)

### 3. Order book (60s)

- Show bids/asks, spread, implied NO = 1 − YES
- Explain split: 1 DBUSDC → 1 YES + 1 NO
- Demo mode: agent-fed book; live mode: place limit order on-chain

### 4. Vault VLP (40s)

- **Vault** — TVL, MM allocation, deposit/withdraw VLP (DBUSDC)

### 5. Agents (40s)

- **Agents** — Creator / Maker / Resolver decision feed
- Point to quote or create_market tx on Suiscan (if on-chain)

### 6. Portfolio (20s)

- **Portfolio** — YES/NO balances per market

## Optional: Legacy Predict (30s)

- **Legacy ▾** → `/legacy/predict/trade` — mint BTC binary with dUSDC
- `/legacy/predict/vault` — PLP supply/withdraw

## Talking points

- Polymarket-style complement (YES + NO = $1) in Move `outcome_tokens`
- On-chain CLOB avoids 500 DEEP per DeepBook pool for hackathon MVP
- Three autonomous agents + user vault for MM capital
- Legacy Predict shows DeepBook protocol breadth

## Backup

- Demo markets in `apps/agents/data/markets.db` if chain unavailable
- Pre-recorded agent feed from `/decisions`
