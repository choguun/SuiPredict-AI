# Agent Policy Contract

On-chain policy objects for autonomous DeepBook Predict agents.

## Module: `agent_policy`

- `create_policy(agent, max_budget, expires_at)` — creates a **shared** policy with spend cap
- `authorize_spend(policy, amount, clock)` — agent logs spend before trading
- `log_action(policy, action, clock)` — agent audit log without spend
- `revoke(policy)` — owner revokes agent access
- `pause` / `unpause` — circuit breaker

## v2 Change: Shared Object

Policies are shared on create so the agent wallet can call `authorize_spend` / `pause` in autonomous PTBs without the owner co-signing. The owner retains revoke/unpause rights.

## Testnet Package (v2 — shared object)

`0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8` (upgraded in-place, version 2)

Upgrade tx: `JCmZu5jccF7rmUph1xWDLmHGpZdmmnb4KyHgyrAU4xq5`

## Build & Test

```bash
pnpm contracts:build
pnpm contracts:test
```

## Publish

```bash
cd packages/contracts && sui client publish --gas-budget 200000000
```

Update `AGENT_POLICY_PACKAGE_ID` in `.env` with the new package ID.
