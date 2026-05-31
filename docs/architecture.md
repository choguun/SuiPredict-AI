# Architecture

## DeepBook V3 stack

SuiPredict uses DeepBook V3 as the CLOB backend for all prediction market trading.

| Layer | Technology | Purpose |
|-------|------------|---------|
| Move | `prediction_market`, `vault`, `registry`, `vlp`, `types` | Market lifecycle, VLP vault, registry, types |
| DeepBook V3 | External package (`0xdee9`) | YES/DBUSDC order book, mint/redeem fees, referral rewards |
| SDK | `@suipredict/sdk` | PTB builders, DeepBook client, market store client |
| Indexer | `apps/agents` SQLite + REST | `/markets`, `/markets/:id/book`, `/portfolio/:addr` |
| Agents | Creator -> Maker -> Resolver -> ReferralKeeper | Autonomous market lifecycle |

## Prediction market data flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                           Market Creator Agent                             │
│  Proposes market → calls buildCreateMarketTx → execute                    │
│  prediction_market::create_market + createPermissionlessPool            │
│  + setup_referral (links pool → referral ID → treasury)                  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ tx: market_id + pool_id created on-chain
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          DeepBook V3 Pool                                │
│  YES/DBUSDC permissionless pool (tick: 0.001, lot: 1 YES, min: 1 YES)   │
│  Mint fee: 1%  |  Redeem fee: 0.5%  |  Referral rewards accumulated       │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         ▼                                           ▼
┌────────────────────────┐               ┌────────────────────────┐
│   Market Maker Agent    │               │     User / Trader       │
│  buildPlaceYesLimit    │               │  split(1 DBUSDC)        │
│  OrderTx → bid/ask     │               │  → 1 YES + 1 NO        │
│                        │               │  place_limit_order(YES)│
└────────────────────────┘               └────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       Market Resolver Agent                               │
│  LLM oracle (confidence >= 85) or BTC spot price fallback                 │
│  → buildResolveMarketTx → execute                                        │
│  prediction_market::resolve_market                                        │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                        Referral Keeper Agent                              │
│  Polls all markets with referral_id set                                  │
│  → buildClaimReferralRewardsTx → sweep to REFERRAL_TREASURY_ADDRESS     │
└──────────────────────────────────────────────────────────────────────────┘
```

## Contract details

### prediction_market.move (replaces clob + factory + settlement + outcome_tokens)

| Function | Description |
|---------|-------------|
| `create_market` | Creates `PredictionMarket<Q>` + DeepBook permissionless pool in one tx |
| `split` | 1 DBUSDC -> 1 YES + 1 NO (stored in user balance) |
| `merge` | 1 YES + 1 NO -> 1 DBUSDC |
| `place_limit_order` | Delegates to DeepBook `placeLimitOrder` |
| `mint_referral` | Links market pool -> `DeepBookPoolReferral` |
| `claim_referral_rewards` | Sweeps accumulated DBUSDC/DEEP/YES dust to treasury |
| `resolve_market` | Sets outcome, enables `redeem` for winners |
| `redeem` | Claims resolved YES tokens (if yes) or NO tokens (if no) |
| `withdraw_fees` | Protocol fee withdrawal (admin-only, via `vault.admin`) |
| `public_transfer` | Used for YES/NO coins and protocol coin flows |

### DeepBook V3 integration

- **Pool creation:** `createPermissionlessPool(tickSize, lotSize, minSize, creationFee)` — one pool per market
- **Trading:** `placeLimitOrder` / `cancelLimitOrder` / `placeBulkOrders` via SDK wrappers
- **Referral:** `mintReferral` + `claimPoolReferralRewards` — rewards sweep to `REFERRAL_TREASURY_ADDRESS`
- **Mint/Redeem fees:** 1% mint fee + 0.5% redeem fee accumulate in `FeeVault<DBUSDC>`

### vault.move (unchanged)

`ProtocolVault<CoinType>` manages VLP shares. Market Maker agent draws capital via `allocate_for_mm`.

### registry.move (unchanged)

Global `MarketRegistry` shared object. `register_market` is admin-only.

## Security notes

- Agent keys in `AGENT_PRIVATE_KEY` only (server-side, never exposed to frontend)
- `FeeVault` admin is the deployer publisher; `withdraw_fees` requires `vault.admin == ctx.sender()`
- Referral rewards swept to `REFERRAL_TREASURY_ADDRESS` — not to agent wallet
- Market Maker uses per-market `poolKey` from SQLite store — one agent can serve multiple markets

## References

- [DeepBook V3 SDK](https://docs.sui.io/standards/deepbookv3-sdk)
- [DeepBook V3 contracts](https://github.com/MystenLabs/deepbook-v3)
