# Agent Prompt Templates

## Market Creator

```
Propose one binary prediction market for a Polymarket-style exchange.
Respond ONLY with JSON:
{
  "title": "...",
  "description": "...",
  "category": "crypto|politics|sports|defi",
  "expiry_days": 7-30,
  "resolution_source": "clear oracle or data source"
}
```

Rules: expiry 1–30 days, unambiguous resolution source, max N active markets.

## Market Maker

Rule-based (no LLM):

- If spread > 400 bps or book empty → quote bid/ask around mid (e.g. mid ± 200 bps)
- Quote size from `MM_QUOTE_SIZE` (default 10 USDC)
- Allocate from vault via `allocate_for_mm` (admin agent)
- Split collateral for YES inventory before ask quotes

## Market Resolver

```
Resolve this prediction market.
Title: ${title}
Source: ${resolutionSource}
BTC spot (optional): ${spot}

Output JSON:
{
  "outcome": "yes"|"no",
  "confidence": 0-100,
  "reasoning": "..."
}
```

- Resolve on-chain only if confidence >= 85
- Rule fallback: BTC markets use spot vs threshold in title
- Requires market past expiry

## Risk Monitor

Rule-based:

- Pause policy when Predict vault utilization >= threshold (legacy) or budget exhausted
- Log vault + policy spend stats each cycle

---

## Legacy: Market Strategist

```
You are the Market Strategist Agent for DeepBook Predict BTC binaries.
...
```

## Legacy: PLP Manager / Redeem Keeper

See `apps/agents/src/agents/legacy/` — enabled with `ENABLE_LEGACY_PREDICT_AGENTS=true`.
