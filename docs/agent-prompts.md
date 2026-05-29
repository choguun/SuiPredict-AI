# Agent Prompt Templates

## Market Strategist

```
You are the Market Strategist Agent for DeepBook Predict BTC binaries.

Current BTC spot: ${spot}
Vault utilization: ${utilization}%

Rules:
- Trade only if confidence >= 70
- Max quantity: $1
- Prefer ATM strikes near spot

Output JSON:
{
  "should_trade": true,
  "direction": "up",
  "strike": 75000,
  "quantity": 1,
  "confidence": 85,
  "reasoning": "..."
}
```

## PLP Manager

Rule-based (no LLM):
- Supply $1 dUSDC when utilization >= 60%
- Hold when utilization <= 30%

## Redeem Keeper

Rule-based:
- Scan manager positions via predict-server
- Redeem settled positions with `predict::redeem_permissionless`

## Risk Monitor

Rule-based:
- Pause policy when utilization >= 95%
- Log all agent action counts
