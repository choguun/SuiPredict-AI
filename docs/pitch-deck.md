# SuiPredict-AI Pitch Deck (10 slides)

## 1. Problem
Prediction markets are fragmented. Liquidity is thin. No autonomous market-making on-chain.

## 2. Solution
SuiPredict-AI: autonomous agents that trade, supply PLP, and redeem on **DeepBook Predict**.

## 3. Why Sui + DeepBook
- Predict protocol live on testnet with vol-surface pricing
- Move object model for agent policy caps + revocation
- Sub-second finality for agent tx loops

## 4. Architecture
Frontend + 4 agents + thin `agent_policy.move` on top of Predict protocol.

## 5. Agents
Market Strategist | PLP Manager | Redeem Keeper | Risk Monitor

## 6. Demo
Live: mint BTC binary → PLP supply → agent dashboard → policy revoke

## 7. DeepBook Integration
Uses `predict::mint`, `predict::supply`, `predict::redeem_permissionless` — full E2E.

## 8. Traction / Metrics
Agent decision log, tx count, vault utilization dashboard.

## 9. Roadmap
Mainnet day-one redeploy, multi-asset oracles, Walrus decision archives.

## 10. Team
Choguun — Full-stack + Move

## Ask
DeepBook track — $35k prize, post-hackathon mainnet launch.
