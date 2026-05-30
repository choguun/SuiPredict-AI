# DeepBook V3 Integration Plan — SuiPredict MVP

## Goal

Replace the custom CLOB with DeepBook V3, add minting/redemption fees, DeepBook referral
system, DEEP reserve for pool creation, and wire TS agents to the DeepBook SDK.

---

## Architecture Overview

```
Before (custom CLOB)                         After (DeepBook V3)
────────────────────────────                 ──────────────────────────────────
clob.move          ──────► DELETED           DeepBook Pool<YES, DBUSDC>  (real CLOB)
OrderBook<QuoteCoin>                        YES / NO = real Sui coins
YES/NO = Table entries                      split_collateral → mint YES+NO pair
place_bid/ask_order                        merge_collateral  → burn YES+NO pair
try_match_best (manual)                    market_factory    → creates pool via DeepBook
                                                                 mint_referral  → protocol referral
```

**Key changes:**
- `clob.move` deleted — replaced by DeepBook pool interaction
- YES/NO become `TreasuryCap`-backed Sui coins (one pair per market)
- `market_factory` creates DeepBook pools and the `PredictionMarket` object
- Minting/redemption fees routed to a `ProtocolFeeVault`
- TS agents call `@suipredict/sdk` which wraps `@mysten/deepbook-v3`

---

## Phase 1 — Move Contracts

### 1.1 Delete `clob.move`

Remove entirely. Its responsibilities are replaced by DeepBook.

**Delete:** `packages/contracts/sources/clob.move`
**Delete:** `packages/contracts/tests/market_tests.move` (replaced by new integration tests)

### 1.2 New file: `prediction_market.move`

The single market module. Handles coin creation, minting, trading via DeepBook pool,
fees, referral, and settlement.

**New file:** `packages/contracts/sources/prediction_market.move`

```move
module suipredict::prediction_market;

// --- Dependencies ---
use deepbook::pool::{Self, Pool};
use deepbook::registry::Registry;
use deepbook::balance_manager;
use deepbook::balance_manager::DeepBookPoolReferral;
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin, TreasuryCap};
use sui::clock::Clock;
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

// --- Fee constants (basis points) ---
// 100 bps = 1%, 50 bps = 0.5%
const MINT_FEE_BPS: u64 = 100;
const REDEEM_FEE_BPS: u64 = 50;
const BPS: u64 = 10_000;

// --- State ---

// One TreasuryCap pair per market (compiled-in coin types, see Type Problem below)
public struct YES<phantom Q> has drop {}
public struct NO<phantom Q> has drop {}

public struct PredictionMarket<phantom Q> has key {
    id: UID,
    yes_cap: TreasuryCap<YES<Q>>,
    no_cap: TreasuryCap<NO<Q>>,
    collateral: Balance<Q>,        // all DBUSDC backing positions
    resolved: bool,
    outcome: u8,                   // 1=YES, 2=NO
    expiry_ms: u64,
    referral_id: Option<ID>,        // DeepBook referral for this market's pool
    fee_balance: Balance<Q>,        // accumulated mint/redeem fees
    created_ms: u64,
}

public struct FeeVault has key {
    id: UID,
    admin: address,
    balance: Balance<DEEP>,
    allocated: u64,
}

// --- Events ---
public struct MarketCreated { market_id: ID, pool_id: ID, expiry_ms: u64, creator: address }
public struct MarketResolved { market_id: ID, outcome: u8, resolver: address }
public struct Redeemed { market_id: ID, user: address, amount: u64, fee: u64 }
public struct FeesWithdrawn { amount: u64 }

// --- Errors ---
const ENotCreator: u64 = 0;
const ENotExpired: u64 = 1;
const EAlreadyResolved: u64 = 2;
const EInvalidOutcome: u64 = 3;
const EZeroAmount: u64 = 4;
const EInsufficientFeeBalance: u64 = 5;
const ENotAdmin: u64 = 6;
const EMarketNotActive: u64 = 7;
```

### 1.3 The Coin Type Problem

Move generics require compile-time types. Each market needs its own `YES`/`NO` coin pair.
For the MVP with a fixed set of markets, pre-compile a `Market1YES`, `Market1NO`,
`Market2YES`, `Market2NO` etc. in separate modules, or use a single generic
`YES<MARKET_ID>` phantom type.

**Decision for MVP:** Use a single market coin type pair — deploy one `prediction_market`
module with `YES`/`NO` types compiled in. Scale to multiple markets by deploying
separate package instances or using a counter-based factory pattern (Phase 2).

### 1.4 `init` — creates FeeVault + Registry

```move
fun init(ctx: &mut TxContext) {
    let vault = FeeVault {
        id: object::new(ctx),
        admin: ctx.sender(),
        balance: balance::zero(),
        allocated: 0,
    };
    transfer::share_object(vault);

    let registry = deepbook::registry::create_registry(ctx);
    transfer::share_object(registry);
}
```

### 1.5 `create_market` — one PTB step

```move
public fun create_market<Q>(
    registry: &mut Registry,
    question: vector<u8>,
    expiry_ms: u64,
    deep_fee: Coin<DEEP>,
    tick_size: u64,
    lot_size: u64,
    min_size: u64,
    ctx: &mut TxContext,
): (ID, ID) {  // (market_id, pool_id)
    // 1. Create DeepBook pool
    let pool_id = pool::create_permissionless_pool<YES<Q>, Q>(
        registry, tick_size, lot_size, min_size, deep_fee, ctx,
    );

    // 2. Create market object with YES/NO TreasuryCaps
    let (yes_cap, no_cap, yes_metadata, no_metadata) = {
        let w1 = witness::create<Q>();
        let (c1, c2) = coin::create_pair<Q, YES<Q>, NO<Q>>(w1, ctx);
        (c1, c2)
    };

    let market = PredictionMarket<Q> {
        id: object::new(ctx),
        yes_cap,
        no_cap,
        collateral: balance::zero(),
        resolved: false,
        outcome: 0,
        expiry_ms,
        referral_id: option::none(),
        fee_balance: balance::zero(),
        created_ms: ctx.epoch_timestamp_ms(),
    };
    let market_id = object::id(&market);

    event::emit(MarketCreated { market_id, pool_id, expiry_ms, creator: ctx.sender() });
    transfer::share_object(market);
    (market_id, pool_id)
}
```

Note: The exact DeepBook `create_permissionless_pool` API must be verified against
`@mysten/deepbook-v3` — the current SDK uses `DeepBookClient.pool.create()`
which wraps the Move calls internally.

### 1.6 `mint_shares` — with 1% fee

```move
public fun mint_shares<Q>(
    market: &mut PredictionMarket<Q>,
    quote_in: Coin<Q>,
    ctx: &mut TxContext,
): (Coin<YES<Q>>, Coin<NO<Q>>) {
    assert!(!market.resolved, EMarketNotActive);
    let total = coin::value(&quote_in);
    assert!(total > 0, EZeroAmount);

    let fee = (total * MINT_FEE_BPS) / BPS;  // 1%
    let net = total - fee;

    let mut bal = quote_in.into_balance();
    market.fee_balance.join(bal.split(fee));
    market.collateral.join(bal);

    let yes = coin::mint(&mut market.yes_cap, net, ctx);
    let no  = coin::mint(&mut market.no_cap,  net, ctx);
    (yes, no)
}
```

### 1.7 `redeem` — with 0.5% fee

```move
public fun redeem<Q>(
    market: &mut PredictionMarket<Q>,
    winning_token: Coin<YES<Q>>,  // caller passes the winning side
    ctx: &mut TxContext,
): Coin<Q> {
    assert!(market.resolved, EMarketNotActive);
    let gross = coin::value(&winning_token);
    assert!(gross > 0, EZeroAmount);

    let fee = (gross * REDEEM_FEE_BPS) / BPS;  // 0.5%
    let net = gross - fee;

    coin::burn(&mut market.yes_cap, winning_token);
    market.fee_balance.join(market.collateral.split(fee));
    let out = balance::split(&mut market.collateral, net);

    event::emit(Redeemed {
        market_id: object::id(market),
        user: ctx.sender(),
        amount: net,
        fee,
    });
    coin::from_balance(out, ctx)
}
```

### 1.8 `resolve_market` — no fee

```move
public fun resolve_market<Q>(
    market: &mut PredictionMarket<Q>,
    outcome: u8,        // 1 = YES won, 2 = NO won
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == market.creator, ENotCreator);
    assert!(!market.resolved, EAlreadyResolved);
    assert!(clock.timestamp_ms() >= market.expiry_ms, ENotExpired);
    assert!(outcome == 1 || outcome == 2, EInvalidOutcome);
    market.resolved = true;
    market.outcome = outcome;
    event::emit(MarketResolved {
        market_id: object::id(market),
        outcome,
        resolver: ctx.sender(),
    });
}
```

### 1.9 `withdraw_fees` — admin claims accumulated fees

```move
public fun withdraw_fees<Q>(
    vault: &mut FeeVault,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    assert!(ctx.sender() == vault.admin, ENotAdmin);
    assert!(amount > 0, EZeroAmount);
    assert!(vault.balance.value() >= amount, EInsufficientFeeBalance);
    balance::split(&mut vault.balance, amount).into_coin(ctx)
}
```

### 1.10 DeepBook Referral — `mint_referral` + `claim_referral_rewards`

```move
// After pool creation, call mint_referral on the pool
public fun setup_referral<Q>(
    pool: &mut Pool<YES<Q>, Q>,
    multiplier: u64,  // e.g. 500_000_000 = 0.5x
    ctx: &mut TxContext,
): ID {
    let referral_id = pool::mint_referral<YES<Q>, Q>(pool, multiplier, ctx);
    referral_id  // share the DeepBookPoolReferral object separately
}

// Claim accumulated referral rewards (DEEP + base + quote)
public fun claim_referral_rewards<Q>(
    pool: &mut Pool<YES<Q>, Q>,
    referral: &DeepBookPoolReferral,
    ctx: &mut TxContext,
): (Coin<YES<Q>>, Coin<Q>, Coin<DEEP>) {
    pool::claim_pool_referral_rewards<YES<Q>, Q>(pool, referral, ctx)
}
```

---

## Phase 2 — SDK Layer

### 2.1 `packages/sdk/src/deepbook/client.ts` — already exists

The existing client already has all DeepBook primitives:
- `createPredictionDeepBookClient()` — sets up DeepBookClient with pool/coin config
- `buildDeepBookPlaceLimitOrderTx()` — wraps `placeLimitOrder`
- `buildDeepBookDepositTx()` / `buildDeepBookWithdrawTx()` — BalanceManager ops
- `getOrderBookDepth()` / `getMidPrice()` — reads on-chain orderbook
- `buildDeepBookCreateBalanceManagerTx()` — creates user BalanceManager

**No structural changes needed.** Just ensure the constants (pool IDs, coin types,
DEEP type) are wired from env vars.

### 2.2 `packages/sdk/src/markets/factory-client.ts` — replace custom calls

Replace `buildPlaceBidOrderTx`, `buildPlaceAskOrderTx`, `buildCancelOrderTx`
with DeepBook SDK calls. Add mint/redeem/resolve/fee-withdraw builders.

Key new functions to add:

```typescript
// Build mint_shares transaction
export function buildMintSharesTx(params: {
  marketId: string;
  dbusdcCoinId: string;
  amount: bigint;
}): Transaction

// Build redeem transaction
export function buildRedeemTx(params: {
  marketId: string;
  winningCoinId: string;  // YES or NO coin
}): Transaction

// Build resolve transaction
export function buildResolveTx(params: {
  marketId: string;
  outcome: 1 | 2;  // 1=YES, 2=NO
}): Transaction

// Build DeepBook limit order (YES side only for MVP)
export function buildDeepBookLimitOrderTx(params: {
  poolKey: string;
  balanceManagerId: string;
  isBid: boolean;
  price: number;      // price in USD (e.g. 0.65)
  quantity: number;   // number of YES tokens
  payWithDeep?: boolean;
  clientOrderId?: number;
}): Transaction

// Build withdraw from BalanceManager after trade settles
export function buildDeepBookWithdrawSettledTx(params: {
  poolKey: string;
  balanceManagerId: string;
}): Transaction

// Build claim referral rewards
export function buildClaimReferralTx(params: {
  poolId: string;
  referralId: string;
}): Transaction
```

### 2.3 `packages/sdk/src/markets/store.ts` — extend market schema

Add fields the new system needs:

```typescript
interface Market {
  // ...existing fields...
  pool_key?: string;        // DeepBook pool key (e.g. "PREDICT_YES_DBUSDC")
  balance_manager_id?: string;
  referral_id?: string;
  yes_coin_type?: string;
  no_coin_type?: string;
}
```

---

## Phase 3 — TypeScript Agents

### 3.1 `market-maker.ts` — rewrite to use DeepBook SDK

**Current:** calls `buildPlaceLimitOrderTx` (custom CLOB) and `buildAllocateForMmTx` (vault)

**New flow:**
1. Fetch market config (pool_key, balance_manager_id)
2. Get mid price from DeepBook: `getMidPrice(dbClient, poolKey)`
3. Calculate bid/ask spread
4. Deposit DBUSDC into BalanceManager: `buildDeepBookDepositTx`
5. Place limit order: `buildDeepBookPlaceLimitOrderTx`
6. If YES wins (or on demand): withdraw settled amounts

```typescript
import {
  createPredictionDeepBookClient,
  buildDeepBookPlaceLimitOrderTx,
  buildDeepBookDepositTx,
  buildDeepBookWithdrawSettledTx,
  getMidPrice,
  PREDICT_DEEPBOOK_POOL_KEY,
} from "@suipredict/sdk/src/deepbook/client.js";
import { DBUSDC_TYPE } from "@suipredict/sdk/src/deepbook/constants.js";

export async function runMarketMaker(ctx: AgentContext): Promise<AgentResult> {
  const client = createClient();
  const dbClient = createPredictionDeepBookClient({
    client,
    address: agentAddr,
    balanceManagerId: BALANCE_MANAGER_ID,
    market: {
      poolId: DEEPBOOK_POOL_ID,
      baseCoinType: YES_COIN_TYPE,
    },
  });

  // Check mid price
  const midPrice = await getMidPrice(dbClient, PREDICT_DEEPBOOK_POOL_KEY);
  const midBps = Math.round(midPrice * 10_000);
  const bidBps = Math.max(100, midBps - 200);
  const askBps = Math.min(9900, midBps + 200);

  // Deposit DBUSDC → BalanceManager
  const depositTx = buildDeepBookDepositTx(dbClient, DBUSDC_TYPE, depositAmount);
  await executeTransaction(client, depositTx, signer);

  // Place bid (buy YES cheap)
  const bidTx = buildDeepBookPlaceLimitOrderTx(dbClient, {
    poolKey: PREDICT_DEEPBOOK_POOL_KEY,
    isBid: true,
    price: bidBps / 10_000,
    quantity: QUOTE_SIZE,
    payWithDeep: true,
  });
  await executeTransaction(client, bidTx, signer);

  // Place ask (sell YES at premium)
  const askTx = buildDeepBookPlaceLimitOrderTx(dbClient, {
    poolKey: PREDICT_DEEPBOOK_POOL_KEY,
    isBid: false,
    price: askBps / 10_000,
    quantity: QUOTE_SIZE,
    payWithDeep: true,
  });
  await executeTransaction(client, askTx, signer);

  return recordResult("MarketMaker", {
    action: "place_deepbook_quotes",
    reasoning: `DeepBook quotes ${bidBps/100}¢/${askBps/100}¢`,
    confidence: 85,
  });
}
```

### 3.2 `market-creator.ts` — add pool creation + DEEP fee handling

**Current:** calls `buildCreateMarketTx` + `buildCreateOrderBookTx`

**New flow:**
1. Acquire 500 DEEP for pool creation fee (must be in agent's BalanceManager)
2. Call `pool.create()` via DeepBook SDK (or PTB with `create_permissionless_pool`)
3. Create market object
4. Call `mint_referral` on the pool
5. Store pool_id + referral_id in local market config

```typescript
import { DEEPBOOK_REGISTRY_ID, DEEPBOOK_PACKAGE_ID, POOL_CREATION_FEE_DEEP } from "@suipredict/sdk/src/deepbook/constants.js";

// Step 1: Ensure agent has DEEP for pool creation fee
// Step 2: Create pool via PTB
const createPoolTx = new Transaction();
createPoolTx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::pool::create_permissionless_pool`,
  typeArguments: [YES_COIN_TYPE, DBUSDC_TYPE],
  arguments: [
    tx.object(DEEPBOOK_REGISTRY_ID),
    tx.pure.u64(1_000),      // tick_size: 0.001 USDC
    tx.pure.u64(1_000_000), // lot_size: 1 YES minimum
    tx.pure.u64(1_000_000), // min_size
    tx.object(DEEP_COIN_OBJECT),  // 500 DEEP fee
  ],
});

// Step 3: Mint referral on the pool
// (must be in same tx or after pool creation)
const referralTx = new Transaction();
referralTx.moveCall({
  target: `${DEEPBOOK_PACKAGE_ID}::pool::mint_referral`,
  typeArguments: [YES_COIN_TYPE, DBUSDC_TYPE],
  arguments: [tx.object(poolId), tx.pure.u64(500_000_000)], // 0.5x
});

// Step 4: Create market
const marketTx = buildCreateMarketTx({ ... });
```

### 3.3 `market-resolver.ts` — minimal change

The resolve flow stays similar, just using the new contract API:

```typescript
// New: buildResolveMarketTx points to prediction_market::resolve
const resolveTx = buildResolveMarketTx(market.id, outcome);
```

No DeepBook involvement in resolution.

### 3.4 `risk-monitor.ts` — add DeepBook balance monitoring

Track BalanceManager health:
- DBUSDC balance in BalanceManager
- Open order exposure
- DEEP balance for fee payment
- Claimed referral rewards (DEEP accumulated)

---

## Phase 4 — Configuration & Constants

### 4.1 `packages/sdk/src/deepbook/constants.ts`

```typescript
export const DEEPBOOK_PACKAGE_ID =
  process.env.DEEPBOOK_PACKAGE_ID ?? "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";

export const DEEPBOOK_REGISTRY_ID =
  process.env.DEEPBOOK_REGISTRY_ID ?? "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";

export const DEEP_TYPE =
  process.env.DEEP_TYPE ?? "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";

export const DBUSDC_TYPE =
  process.env.DBUSDC_TYPE ?? "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

export const POOL_CREATION_FEE_DEEP = 500_000_000n;  // 500 DEEP

// MVP: single market YES/NO coin types (deploy once per market)
export const PREDICT_YES_COIN_TYPE = process.env.PREDICT_YES_COIN_TYPE ?? "...";
export const PREDICT_NO_COIN_TYPE  = process.env.PREDICT_NO_COIN_TYPE  ?? "...";

export const REFERRAL_MULTIPLIER = 500_000_000n;  // 0.5x
```

---

## Phase 5 — Build & Test

### 5.1 Contract build

```bash
cd packages/contracts
sui move build
```

Expected: zero errors. The new `prediction_market.move` compiles against
`deepbook` package (installed as a dependency in `Move.toml`).

### 5.2 SDK build

```bash
cd packages/sdk
npm run build
```

Expected: zero TypeScript errors.

### 5.3 Agent type check

```bash
cd apps/agents
npx tsc --noEmit
```

Expected: zero errors.

---

## Files to Change

| File | Action | Change |
|------|--------|--------|
| `packages/contracts/sources/clob.move` | DELETE | Replaced by DeepBook |
| `packages/contracts/tests/market_tests.move` | REPLACE | New DeepBook integration tests |
| `packages/contracts/sources/prediction_market.move` | CREATE | Core market module (fees, mint, redeem, resolve, referral) |
| `packages/contracts/sources/market_factory.move` | DELETE | Superseded by prediction_market |
| `packages/contracts/sources/outcome_tokens.move` | DELETE | Superseded (YES/NO are real coins) |
| `packages/contracts/sources/settlement.move` | DELETE | Logic moved into prediction_market |
| `packages/contracts/sources/types.move` | KEEP/ADAPT | Keep Order/UserPosition types if still needed |
| `packages/contracts/sources/registry.move` | KEEP | MarketRegistry still useful |
| `packages/contracts/sources/vault.move` | KEEP/ADAPT | VLP vault kept; FeeVault added in prediction_market |
| `packages/contracts/Move.toml` | MODIFY | Add DeepBook V3 dependency |
| `packages/sdk/src/markets/factory-client.ts` | MODIFY | Add DeepBook mint/redeem/referral builders |
| `packages/sdk/src/deepbook/constants.ts` | MODIFY | Add YES/NO coin types, referral multiplier |
| `packages/sdk/src/deepbook/client.ts` | MINOR | Ensure all exported helpers are present |
| `apps/agents/src/agents/market-maker.ts` | REWRITE | Use DeepBook SDK |
| `apps/agents/src/agents/market-creator.ts` | REWRITE | Add pool creation + DEEP fee |
| `apps/agents/src/agents/market-resolver.ts` | MINOR | Use new contract API |
| `apps/agents/src/agents/risk-monitor.ts` | NEW | Track BalanceManager + referral rewards |

---

## Open Questions

1. **Coin type per market**: Move requires compile-time types. For MVP with 1 market,
   hardcode YES/NO coin types. For N markets, the factory pattern requires either
   (a) pre-deploying N coin module pairs, or (b) using a deploy-time type parameter.
   **Decision needed before Phase 1 coding.**

2. **DeepBook `create_permissionless_pool` signature**: Confirm exact Move API from
   `@mysten/deepbook-v3` package — the SDK wraps this internally. Need to inspect
   the actual Move bytecode or test to know the exact type parameters and whether
   it returns the pool ID or requires a separate lookup.

3. **500 DEEP acquisition**: The market-creator agent needs 500 DEEP to create a pool.
   Is this held in a protocol-owned BalanceManager, or funded via VLP deposits?
   **Recommendation**: VLP depositors fund the DEEP reserve; agent withdraws as needed.

4. **YES coin price on DeepBook**: The DeepBook pool accepts `price` as a raw integer
   scaled by `tick_size`. Need to confirm the price scaling (e.g., price=700_000
   with tick_size=1_000 means $0.70). The SDK's `buildDeepBookPlaceLimitOrderTx`
   already handles this — verify it passes the correct price format.

---

## Implementation Order

```
Week 1 — Contracts
  [ ] Update Move.toml with DeepBook dependency
  [ ] Write prediction_market.move (mint/redeem/resolve/fees/referral)
  [ ] Write new integration tests
  [ ] sui move build → 0 errors
  [ ] sui move test → all pass

Week 1 — SDK
  [ ] Add new factory-client functions (mint/redeem/resolve/referral)
  [ ] Update constants with YES/NO coin types
  [ ] npm run build → 0 errors

Week 1-2 — Agents
  [ ] Rewrite market-maker.ts (DeepBook SDK)
  [ ] Rewrite market-creator.ts (pool creation + referral)
  [ ] Add risk-monitor.ts
  [ ] npx tsc --noEmit → 0 errors

Week 2 — Integration & Demo
  [ ] End-to-end test: create market → mint → trade on DeepBook → resolve → redeem
  [ ] Verify fees accumulate in FeeVault
  [ ] Verify referral rewards can be claimed
```
