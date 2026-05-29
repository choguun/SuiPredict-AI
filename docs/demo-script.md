# Judge E2E Demo Script (2–3 min)

## Setup

1. Start agents: `pnpm dev:agents`
2. Start frontend: `pnpm dev:web`
3. Ensure wallet has testnet SUI + dUSDC

## Demo Flow

### 1. Home — Live Market Data (15s)

- Open `http://localhost:3000`
- Show predict-server status, vault value, BTC spot, active oracle

### 2. User Trade (30s)

- Go to **Trade**
- Connect wallet
- Click **Create** PredictManager
- Select active BTC oracle, UP direction, $1 quantity
- **Mint Position** → show tx on Suiscan
- After oracle settles, **Redeem** from Open Positions table

### 3. PLP Vault (20s)

- Go to **Vault**
- Show utilization + PLP supply metrics
- Supply $1 dUSDC to PLP → show tx
- Optionally **Withdraw PLP**

### 4. Agent Activity (30s)

- Go to **Agents**
- Show four agent cards + live decision feed
- Point to MarketStrategist mint / RedeemKeeper redeem tx hashes

### 5. Leaderboard (15s)

- Show indexed mint/redeem volume from predict-server

### 6. Policy Revocation (30s)

- Go to **Settings**
- Create policy with agent address + $50 budget → copy **Policy Object ID**
- Set `AGENT_POLICY_ID` in agents `.env`
- **Revoke** policy → explain agent txs will fail

## Talking Points

- Integrates **existing** DeepBook Predict (not custom markets)
- Four autonomous agents with on-chain policy objects
- E2E: deposit → mint → PLP supply → settle → redeem
- DeepBook idea bank: PLP vault (#2), Redeem Keeper (#8), gamified UI (#6)

## Backup

If live agent fails, show pre-recorded `/agents` feed or SQLite `apps/agents/data/decisions.db`.
