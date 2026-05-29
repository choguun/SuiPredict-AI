# Agent Policy Contract

On-chain capability objects for autonomous DeepBook Predict agents.

## Module: `agent_policy`

- `create_policy(agent, max_budget, expires_at)` — owner creates policy with spend cap
- `authorize_spend(policy, amount, clock)` — agent logs spend before trading
- `log_action(policy, action, clock)` — agent audit log without spend
- `revoke(policy)` — owner revokes agent access
- `pause` / `unpause` — circuit breaker

## Testnet Package

`0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8`

## Build

```bash
pnpm contracts:build
```

## Publish

```bash
cd packages/contracts && sui client publish --gas-budget 200000000
```
