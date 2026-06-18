# R-WC-3.3 — SDK fix + end-to-end integration status

**Date:** 2026-06-18
**Status:** SDK + agents + web integration fully wired for v2's `YES<Q, M>` + `parlay<M>` generics. The wc-creator's `create_market` calls against the v2 fresh-publish package (`0x2ea40c796…`) are still aborting with `VMVerificationOrDeserializationError in command 0` — needs deeper Move-side diagnosis.

---

## What was fixed in this session

### SDK builder API: every PTB builder now accepts an optional `m` parameter

Added to every prediction-market builder:
- `buildCreateMarketTx({ ..., m })`
- `buildCreateMarketWithPoolTx({ ..., m })`
- `buildMintSharesTx(marketId, vaultId, coin, amount, m)`
- `buildMintSharesBatchTx({ ..., m })`
- `buildPlaceOrderTx({ ..., m })`
- `buildPlaceMarketOrderTx({ ..., m })`
- `buildResolveMarketTx(marketId, outcome, m)`
- `buildRedeemTx(marketId, vaultId, coin, m)`
- `buildRedeemWithStreakTx(marketId, vaultId, coin, streakId, m)`
- `buildRedeemNoTx(marketId, vaultId, coin, m)`
- `buildDisputeMarketTx(marketId, evidence, m)`
- `buildResolveDisputeTx(marketId, outcome, m)`
- `buildCancelOrderTx({ ..., m })`
- `buildCancelOrdersTx({ ..., m })`
- `buildSetupReferralTx(marketId, poolId, multiplier, m)`
- `buildClaimReferralRewardsTx(poolId, referralId, m)`

When `m` is provided, the SDK appends it as the second type argument (`M`) so the BCS serializer emits `typeArguments: [DUSDC_TYPE, M]` matching the v2 contract's `func<Q, M>(...)` signatures.

### Bug fix: `withMarketType` was a no-op against the Sui SDK 2.x

The previous implementation called `tx.getData()` and mutated the returned object's `typeArguments` array. But the Sui SDK's `getData()` returns a **clone** — the `TransactionDataBuilder` was never updated, so the BCS serializer emitted the unmodified `[DUSDC_TYPE]` and the v2 contract's `create_market<Q, M>` rejected the PTB with `VMVerificationOrDeserializationError`.

Fixed by routing callers through the new `m` parameter, which flows directly into the builder's `typeArguments`. The old `withMarketType` is now a deprecation stub that logs a warning at runtime.

### Caller updates

All SDK callers now pass `m` at builder time:
- `apps/agents/src/agents/market-creator.ts` — `buildCreateMarketTx`, `buildSetupReferralTx`, `buildMintSharesTx`
- `apps/agents/src/agents/market-resolver.ts` — `buildResolveMarketTx`
- `apps/agents/src/agents/world-cup-creator.ts` — `ensureMarketCreated`, `buildSetupReferralTx`, `buildMintSharesTx`
- `apps/agents/src/agents/world-cup-resolver.ts` — `buildResolveMarketTx` (both call sites)
- `apps/agents/src/agents/world-cup-maker.ts` — `buildPlaceOrderTx`
- `apps/web/app/markets/[id]/page.tsx` — `buildMintSharesTx`, `buildPlaceOrderTx`, `buildRedeemTx`, `buildRedeemWithStreakTx`, `buildRedeemNoTx`
- `apps/web/app/dispute/[marketId]/page.tsx` — `buildDisputeMarketTx`
- `apps/web/app/portfolio/page.tsx` — `buildRedeemTx`, `buildRedeemWithStreakTx`, `buildRedeemNoTx`

### Operational changes

- **Circuit-breaker reset**: `POST /wc/circuit-breaker {"action":"reset"}` — the JSON file persisted in `/data` had `coinRegistryFull: true` from the v1 deployment.
- **Legacy pool fallback disabled**: `WC_FALLBACK_POOL_ID=__DISABLED__` — the v1 pool `0xddd7cbe5…` was created with `Pool<YES<DUSDC>>` (no `M` generic) and would BCS-mismatch against the v2 `Pool<YES<DUSDC, M>>` type. Disabling the fallback forces the wc-creator to call `create_market` (which creates a fresh v2 pool bound to this market's specific `M`).

### Deploys

- `31c2…` → `b624…` (env revert only, image `2742ef2a…`)
- `ed075b91` → image `c4afe1ee…` (full SDK rebuild + deploy from source via `railway redeploy --from-source`)
- Subsequent redeploys for env changes reuse the same image (Railway cache).

---

## What's still failing

The wc-creator's `create_market` PTBs against v2 abort with `VMVerificationOrDeserializationError in command 0`:

```
[wc-creator] A3v4 failed: Transaction resolution failed: VMVerificationOrDeserializationError in command 0
[scheduler] WorldCupCreator → create_wc: WC: created 0 on-chain markets, 4 failed. Window: 25 matches in 7d, cap 4. Path: create_market (firs…
```

This is a generic BCS error. The type arguments are confirmed correct (verified locally with `tx.getData()`: `["0x…::dusdc::DUSDC", "0x6527…3650"]`). Possible remaining causes:

1. **`Pool<YES<Q, M>, Q>` type mismatch on the first `create_permissionless_pool` call** — DeepBook's `create_permissionless_pool<YES<Q, M>, Q>` might fail if it checks the registry for an existing pool with the same `YES<Q>` base type regardless of `M`.
2. **`deepbook_registry` argument** — the SDK passes `tx.object(DEEPBOOK_REGISTRY_ID)` but the v2 contract's `create_market<Q, M>` calls `pool::create_permissionless_pool` which may need additional constraints.
3. **DeepBook's own v1 vs v2 type encoding** — the SDK's `DEEPBOOK_PACKAGE_ID = 0xc93ae84…` is the self-hosted DeepBook. The v2 contract was built against `deps/deepbookv3-self-hosted/packages/deepbook` which may not match the on-chain version byte-for-byte (this is the same problem that blocked the v1.5 upgrade earlier in this session).
4. **`BalanceManager` initialization on v2** — the v2 `create_market` calls `balance_manager::new_with_custom_owner` which may have an api mismatch.

### Recommended next step

Run a real `sui client call` against the v2 package to surface the specific Move abort code (rather than the generic BCS error). With `sui client call --package 0x2ea40c796… --module prediction_market --function create_market --type-args 0xe9a73a6f…::dusdc::DUSDC 0x6527…3650 --args 0xc 0xe14eba90… … --gas-budget 500000000`, the Sui CLI will return the exact Move abort or BCS error message.

---

## What's working today (despite the wc-creator failure)

- **v2 bytecode live on testnet** at `0x2ea40c796…` (package id), `0xc6d1c2a8…` (UpgradeCap).
- **Agents service running v2** — `/health` returns `package_id: 0x2ea40c796…`. The drift warning about the on-chain AgentPolicy is non-blocking for the SQLite-backed API endpoints.
- **WC fetcher + maker + resolver all running on schedule** — they all just observe that the underlying markets aren't on-chain and skip gracefully.
- **Web UI serving seeded markets** — `GET /markets` returns 47 demo markets with titles, categories, descriptions, all from the SQLite mirror.
- **Parlay / leaderboard / friends / portfolio pages** all SQLite-backed, fully functional.

The demo flow:
1. User opens `suipredict-web.vercel.app/worldcup` → sees the WC 2026 dashboard with all 72 matches (SQLite).
2. User clicks a match → `/markets/[id]` page renders the SQLite-seeded market, the predicted yes/no prices, the order book (synthetic).
3. User connects wallet → mint/order PTBs build with `[DUSDC_TYPE, M]` type args and submit to the v2 package.
4. The actual on-chain settlement requires the wc-creator to succeed at `create_market` first, which is the current blocker.

---

## Files in this commit

- `packages/sdk/src/prediction-market-client.ts` — added `m` param to 16 builders; rewrote `withMarketType` as deprecation stub; updated `ensureMarketCreated` to pass `m` to inner builders.
- `apps/agents/src/agents/market-creator.ts` — pass `m` at builder time.
- `apps/agents/src/agents/market-resolver.ts` — pass `m` at builder time.
- `apps/agents/src/agents/world-cup-creator.ts` — pass `m` at builder time.
- `apps/agents/src/agents/world-cup-resolver.ts` — pass `m` at builder time (both call sites).
- `apps/agents/src/agents/world-cup-maker.ts` — pass `m` at builder time.
- `apps/web/app/markets/[id]/page.tsx` — pass `m` at builder time.
- `apps/web/app/dispute/[marketId]/page.tsx` — pass `m` at builder time.
- `apps/web/app/portfolio/page.tsx` — pass `m` at builder time.

Commit: `5a98b92 fix(sdk+agents+web): thread per-market M type at builder time, not via broken withMarketType`.