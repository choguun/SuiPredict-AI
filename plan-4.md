# SuiPredict Remaining Work — Plan 4

**Date:** May 31, 2026
**Status:** Build passes, 3/3 tests pass. Core DeepBook V3 integration complete.

---

## What Was Built (Plan 1–3)

| Module | Lines | Status |
|--------|-------|--------|
| `prediction_market.move` | 809 | Done — DeepBook V3 CLOB, YES/NO minting, trading, resolution |
| `registry.move` | 66 | Done — admin-managed market registry |
| `vault.move` | 158 | Done — DBUSDC vault, VLP mint/burn for LP |
| `vlp.move` | 21 | Done — VLP coin (vault LP shares) |
| `types.move` | 85 | Done — shared types, constants |
| `agent_policy.move` | 173 | Done — agent spend authorization |

---

## What's Left to Build

### 1. Streak System (`streak_system.move`) — HIGH PRIORITY

Tracks user participation across daily prediction rounds.

```move
public struct UserStreak has key {
    id: UID,
    owner: address,
    current_streak: u64,          // consecutive days participated
    longest_streak: u64,          // all-time record
    last_participation_day: u64,  // day index (epoch_ms / 86400000)
    total_participated: u64,      // total rounds participated
    total_correct: u64,           // total winning rounds
    multiplier_tier: u8,          // 0=none, 1=3-day, 2=7-day, 3=14-day, 4=30-day
}
```

**Multiplier tiers:**
- 3+ consecutive days: 1.1x winnings multiplier
- 7+ days: 1.3x
- 14+ days: 1.5x
- 30+ days: 2.0x

**Key functions:**
- `create_streak(ctx)` — user self-registers their streak object
- `record_participation(streak, prediction_correct: bool, day_index, ctx)` — called after market resolution
- `get_multiplier(streak): u64` — returns multiplier in basis points (e.g. 12000 = 1.2x)
- `streak_info(streak)` — view: returns all fields

**Streak logic:**
- Day index = `clock.timestamp_ms() / 86400000`
- Participation recorded if user submitted predictions that round
- Streak continues if next round `day_index == last_participation_day + 1`
- Streak resets to 0 if a round is missed
- `multiplier_tier` recalculated on each `record_participation`

**Events:**
- `StreakUpdated { user, new_streak, longest_streak, multiplier_tier }`
- `StreakBroken { user, final_streak }`
- `MilestoneReached { user, milestone_type, tier }`

---

### 2. Badge NFT System (`badge_nft.move`) — MEDIUM PRIORITY

Mint streak milestone badges as NFTs (Sui Kiosk).

```move
public struct StreakBadge has key, store {
    id: UID,
    owner: address,
    badge_type: u8,        // 1=3-day, 2=7-day, 3=14-day, 4=30-day, 5=100-day
    milestone: u64,       // e.g. 7
    earned_at_ms: u64,
}
```

**Key functions:**
- `mint_badge(streak: &UserStreak, ctx: &mut TxContext)` — called by user or factory; mints badge if current streak hits a new milestone
- `badges_earned(streak: &UserStreak): vector<u8>` — returns list of badge types earned
- `can_claim_badge(streak: &UserStreak, badge_type: u8): bool` — checks if badge not yet claimed

**Badge types:**
| Type | Name | Requirement |
|------|------|-------------|
| 1 | Bronze Predictor | 3-day streak |
| 2 | Silver Predictor | 7-day streak |
| 3 | Gold Predictor | 14-day streak |
| 4 | Platinum Predictor | 30-day streak |
| 5 | Diamond Predictor | 100-day streak |

**Notes:**
- Badges are `store` (not `key`) — transferred via Kiosk or direct transfer
- Alternatively use `suia::nft` pattern if Switchboard/Kiosk is too complex for MVP
- Simpler alternative: just store badge flags in `UserStreak` without actual NFT minting

---

### 3. Leaderboard (`leaderboard.move`) — MEDIUM PRIORITY

Weekly leaderboard tracking correct predictions.

```move
public struct WeeklyLeaderboard has key {
    id: UID,
    week_index: u64,       // floor(epoch_ms / (7 * 86400000))
    entries: Table<address, u64>,  // address -> score
    top_10: vector<(address, u64)>,  // cached top 10
}
```

**Key functions:**
- `update_score(leaderboard, user, score, ctx)` — called by backend after resolution
- `get_top(leaderboard, n)` — returns top N entries
- `get_user_rank(leaderboard, user): u64` — 1-indexed rank
- `reset_weekly(leaderboard, ctx)` — creates new week (called by backend cron)

**Alternative:** Use off-chain leaderboard (Redis + Sui Indexer events) instead of on-chain, to avoid per-update gas costs.

---

### 4. Prize Pool Distribution (`prize_pool.move`) — MEDIUM PRIORITY

Escrow and distribute weekly prizes to top performers.

```move
public struct PrizePool has key {
    id: UID,
    admin: address,
    balance: Balance<QuoteCoin>,  // e.g. DBUSDC
    weekly_prize: u64,
    distributed: bool,
}
```

**Key functions:**
- `fund_pool(pool, coin, ctx)` — admin adds prize funds
- `claim_prize(pool, user_streak, rank, ctx)` — user claims based on leaderboard rank
- `distribute(pool, top_users: vector<address>, ctx)` — admin batch-distributes (alternative to individual claims)

---

### 5. Agent Integration — HIGH PRIORITY

The `agent_policy.move` (173 lines) exists but needs end-to-end wiring:

**`agent_policy_tests.move`** — Write actual integration tests:
- Create market via `create_market`
- Mint shares via `mint_shares`
- Place order via `place_order` on DeepBook pool
- Verify fills via `withdraw_settled`
- Resolve market, redeem winning position

**Agent workflow PTB construction:**
```typescript
// 1. Fetch market's BalanceManager ID
const bmId = await getBalanceManagerId(marketId);

// 2. User funds their BM
const fundBmTx = new TransactionBlock();
fundBmTx.moveCall({
    target: `${PKG}::prediction_market::deposit_for_trading`,
    arguments: [
        tx.object(marketId),
        tx.object(bmId),
        tx.object(userYesCoin),
        tx.object(userQuoteCoin),
        tx.object(userDeepCoin),
    ]
});

// 3. Place order
const orderTx = new TransactionBlock();
orderTx.moveCall({
    target: `${PKG}::prediction_market::place_order`,
    arguments: [
        tx.object(marketId),
        tx.object(poolId),
        tx.object(bmId),
        tx.pure.u64(clientOrderId++),
        tx.pure.u64(price),        // e.g. 500_000_000 = 0.50 Q
        tx.pure.u64(quantity),
        tx.pure.bool(isBid),
        tx.pure.u8(ORDER_TYPE_POST_ONLY),
        tx.object(clockObj),
    ]
});
```

---

### 6. Backend / Oracle Integration — HIGH PRIORITY

**Market Resolution Cron Job:**
- Monitor `clock.timestamp_ms()` per market's `expiry_ms`
- At expiry, fetch resolution from Pyth/Supra oracle
- Build PTB: `resolve_market(market, outcome, clock, ctx)` + `record_participation(streak, ...)` for all participants

**Sui Indexer integration:**
- Subscribe to `OrderPlacedEvent`, `OrderCancelledEvent`, `MarketResolvedEvent`
- Index orderbook state for frontend order book display
- Track per-user positions for leaderboard scoring

---

### 7. Frontend Integration — HIGH PRIORITY

**Priority pages:**
1. Markets list — show all active markets with YES/NO prices from DeepBook pool
2. Market detail — order book display, place/cancel order, mint/redeem shares
3. Profile — user streaks, badges, position history

**Key SDK calls needed:**
- `sui.client.queryTransactionBlocks` — fetch user's market interactions
- `sui.client.getObject` — fetch PredictionMarket state
- DeepBook SDK / custom pool queries — order book depth

---

## Dependency Order

```
1. streak_system.move        — gamification core, no deps
2. badge_nft.move            — depends on streak_system
3. leaderboard.move          — depends on streak_system events
4. prize_pool.move           — depends on leaderboard
5. agent integration tests   — depends on all of above
6. backend cron jobs         — depends on on-chain events
7. frontend                 — depends on backend + contracts
```

---

## Resolved in Previous Plans

- DeepBook V3 pool creation with DEEP fee
- BalanceManager integration
- YES/NO minting with collateral backing
- Order placement / cancellation / settlement
- Referral system (DeepBook)
- Build/test passing (0 errors)
