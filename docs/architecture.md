# Architecture

## Layers

| Layer | Technology | Purpose |
|-------|------------|---------|
| Protocol | DeepBook Predict (testnet) | Binary markets, PLP vault, oracles |
| Policy | `agent_policy.move` | Agent budget caps, revocation, audit log |
| Agents | TypeScript + `@suipredict/sdk` | Autonomous trading, LP, redemption |
| Frontend | Next.js + dApp Kit | User trading, vault, agent dashboard |
| Indexer | predict-server | Market data, positions, vault stats |

## Data Flow

1. **User trade:** Wallet → deposit dUSDC → `predict::mint` via frontend PTB
2. **PLP supply:** PLP Manager agent → `predict::supply` when utilization > 60%
3. **Strategist:** Reads oracle spot + vault → LLM/rules → `predict::mint` with policy authorize
4. **Keeper:** Scans settled oracles → `predict::redeem_permissionless`
5. **Risk:** Monitors utilization → `agent_policy::pause` if critical

## Security Model

- Agents hold Ed25519 keypairs (env var, never in frontend)
- `AgentPolicy` object caps spend and emits `AgentActionEvent`
- Owner can `revoke()` at any time (demo in Settings page)

## References

- [DeepBook Predict Contract Info](https://docs.sui.io/onchain-finance/deepbook-predict/contract-information)
- Branch: `predict-testnet-4-16`
