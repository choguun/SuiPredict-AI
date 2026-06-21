# R-WC-3.8 — wc-maker auto-mints YES to back asks

## Problem

The wc-maker (`apps/agents/src/agents/world-cup-maker.ts`) only placed
YES bids on-chain. The UI derives the NO order book from the YES
complement (`yes bid @ P == no offer @ (1-P)`), so a one-sided YES
book produced an empty NO book — defeating the "two-sided" display
goal from R-WC-3.7.

R-WC-3.7 follow-up made the maker skip the ask leg when its BM
lacked YES base, but this is exactly the default state at boot: the
maker has DUSDC (quote) but zero YES (base). Skipping the ask meant
the NO book stayed empty for every tick.

## Fix

Add a 2-PTB mint flow at the start of the maker's per-market loop,
**before** the existing DUSDC deposit (the deposit consumes the
whole `dusdcId`, so the mint must run while wallet DUSDC is still
available):

```
1. listAllCoins → getBalanceManagerBalance(yesCoinType) → preYes
2. if preYes < quoteSize:
   a. PTB 1: buildMintSharesTx(marketId, vaultId, dusdcId, mintAmount, ...)
      → mint_shares<Q> transfers Coin<YES<Q>> to ctx.sender() (the maker)
   b. listAllCoins(yesCoinType) → find freshly minted YES coin
   c. PTB 2: balance_manager::deposit<YES<Q>>(balanceManagerId, yesCoin.objectId)
3. ... existing flow: depTx, authTx, placeTx (bid), askPlaceTx ...
```

`hasYesBase` is re-read at step 5 (after the deposit), so the same
tick that mints also places the ask. Subsequent ticks skip the mint
(balance persists in the BM) and just re-quote.

## Mint amount math

`mint_shares<Q>` takes DUSDC atoms and produces `net = amount - 1% fee`
YES atoms. To get at least `quoteSize` YES:

```
mintAmount = quoteSize * 101 / 100 + 1   // 6-decimal base units
```

The `+ 1` is a ceiling for `quoteSize` values not divisible by 99
(e.g. `quoteSize = 1_000_000` → 1_010_101 DUSDC atoms → 1_000_000 YES
atoms after the 1% fee split). For the default `quoteSize = 5_000_000`:
mint 5_050_001 DUSDC atoms = 5_000_000 YES atoms.

## Why a 2-PTB flow

`mint_shares<Q>` (`prediction_market.move:742`) ends with:

```move
transfer::public_transfer(yes, ctx.sender());
transfer::public_transfer(no, ctx.sender());
```

The function's return type is `()` — Move treats the transfers as
side effects, so the SDK's `tx.moveCall` returns an empty result
array. There's no way to chain a follow-up `balance_manager::deposit<YES>`
in the same PTB. The `listAllCoins` lookup in between discovers
the freshly minted coin by its balance.

## Why BEFORE the DUSDC deposit

`depTx` (line 439) consumes the entire `dusdcId` as the BM's
`Coin<DUSDC>` input. After it executes, the wallet has 0 DUSDC, and
the mint step can't fund itself. The mint must run while wallet
DUSDC is still available.

## Failure modes (all non-fatal)

| Failure | Cause | Recovery |
|---------|-------|----------|
| `mint_shares` aborts | Insufficient DUSDC for the mint amount | Logged, mint skipped this tick, retry next tick |
| `balance_manager::deposit<YES>` aborts | Stale gas coin, BM not shared | Logged, ask skipped this tick, retry next tick |
| `listAllCoins` returns no YES coin | Mint succeeded but coin not yet indexed | Logged, ask skipped this tick, retry next tick |

A mint failure is non-fatal — the maker proceeds with a bid-only
book. The next tick (every 2 min) re-attempts the mint if the BM
balance is still low.

## Deployment

- Commit: `7d084a1` (main)
- Railway deploy: `3b5cf73e-c5c1-45c0-9e7e-bfe17be1c294` (R-WC-3.8)
- Build: `pnpm run build` in `apps/agents/` — clean (`tsc`, exit 0)
- Status: 5 consecutive ticks of "8 markets quoted, 0 skipped"

## Verification

Live wc-maker logs after topup + deploy:
- `[wc-maker:diag] A1v2 minting 5050001 YES atoms (no inventory)…`
- `[wc-maker:diag] A1v2 YES deposit OK`
- `[wc-maker:diag] B1v2 minting 5050001 YES atoms (no inventory)…`
- `[wc-maker:diag] B1v2 YES deposit OK`
- `[scheduler] WorldCupMaker → quote: WC: 8 markets quoted, 0 skipped`

The maker now quotes YES bids AND YES asks on every market, every
2 minutes. The UI's NO order book (derived from the YES complement)
should now show real depth on `https://suipredict-web.vercel.app/markets/wc26-A1v2`.

## Related

- R-WC-3.5: price scale mismatch (1e6 tick vs 1e9 quote)
- R-WC-3.6: order book disappearing on 4s polling
- R-WC-3.7: two-sided order book via on-chain ask placement
- R-WC-3.7 follow-up: skip ask when no YES inventory
- R-WC-3.8 (this): auto-mint YES so the ask is no longer skipped
