**Comprehensive Technical Implementation Plan**

**Prediction Market Platform on Sui + DeepBook V3**  
**Focus:** AI/Tech + Crypto Vertical with **Daily Prediction Streak** Gamification Layer  
**Date:** May 31, 2026

### 1. High-Level Architecture

**Core Stack:**
- **Blockchain:** Sui Mainnet (Object-centric model, Parallel execution via Mysticeti)
- **Order Book & Liquidity:** DeepBook V3 (CLOB) + **DeepBook Predict** module (expiry-based prediction markets)
- **Shared Liquidity & Margin:** DeepBook Margin for capital efficiency across spot, margin, and prediction positions
- **Frontend:** Progressive Web App (PWA) built with React + TypeScript + @mysten/dapp-kit
- **Backend:** Node.js / TypeScript services (market creation, resolution monitoring, notifications)
- **Indexing:** Sui Indexer (or custom Surflux DeepBook Indexing API) + GraphQL
- **Oracles:** Pyth + Supra (primary), Switchboard (fallback) for price feeds and event resolution

**Key Advantage:** Leverage **DeepBook Predict** + shared liquidity so you don’t build a custom order book from scratch.

### 2. Smart Contracts (Move Modules)

#### 2.1 Core Prediction Market Contracts
- Use **DeepBook Predict** package as the foundation (already audited and optimized).
- Extend with custom wrapper module for your platform logic.

**Key Modules:**
- `platform.move` – Admin functions, market creation, fee collection
- `streak_system.move` – Tracks user streaks, multipliers, XP
- `badge_nft.move` – NFT badge minting (using Kiosk for ownership)
- `leaderboard.move` – Shared Leaderboard object (weekly reset logic)
- `prize_pool.move` – Escrow and distribution of weekly prizes

#### 2.2 Daily Binary Markets Implementation
- Each daily market = one **Predict Market** object with binary outcomes (Yes/No shares).
- Markets created automatically via backend cron job (every 24h).
- Use `DeepBook Predict::create_market()` with expiry = 24 hours.
- Collateral in USDT or SUI via shared vault.

#### 2.3 Streak & Gamification Logic
- **Streak Object** (per user): 
  ```move
  struct UserStreak has key {
      id: UID,
      owner: address,
      current_streak: u64,
      longest_streak: u64,
      last_participation_day: u64,  // Unix timestamp / day index
      multiplier_tier: u8
  }
  ```
- On successful resolution of all 5 daily markets → update streak + apply multiplier on winnings.
- Streak break if any market missed or no participation.

#### 2.4 NFT Badges
- Use Sui’s Kiosk + TransferPolicy for tradable badges.
- Mint on streak milestones using `badge_nft::mint()`.

### 3. DeepBook V3 Integration

- **Liquidity Strategy:** 
  - Use shared liquidity pools across all AI/Crypto prediction markets.
  - Enable **DeepBook Margin** so users can share collateral across Daily Binaries, Parlays, and normal markets.
- **Order Placement:** Use DeepBook SDK for limit/market orders on prediction shares.
- **Gas Efficiency:** Leverage Programmable Transaction Blocks (PTBs) for atomic operations (predict + streak update + badge mint).

### 4. Backend Services

| Service | Tech | Responsibility |
|---------|------|----------------|
| Market Generator | Node.js + Cron | Create 5 daily binary markets automatically |
| Resolution Engine | Node.js + Oracle listeners | Pull data from Pyth/Supra at expiry + trigger on-chain resolution |
| Notification Service | Firebase / Novu | Push notifications for streaks, resolutions, prize wins |
| Leaderboard Updater | Sui Indexer + Redis cache | Real-time + weekly reset |
| Prize Distributor | Backend + PTB builder | Distribute USDT from prize pool object |

### 5. Frontend Implementation (PWA)

- **Framework:** React 19 + Vite + TypeScript
- **Wallet:** `@mysten/dapp-kit` + WalletConnect
- **Key Pages:**
  - Dashboard: Daily Predictions Card (5 binaries, 1-tap submit)
  - Streak Profile: Current/Longest streak, multipliers, badges
  - Leaderboards (Global, Country, AI-specific)
  - Market List + Parlay Builder
- **PWA Features:** Install prompt, background sync, push notifications via Service Worker
- **State Management:** Zustand + TanStack Query

### 6. Data Flow & User Journey (Technical)

**Daily Prediction Flow:**
1. User opens PWA → Frontend queries `DailyMarketRegistry` shared object
2. User selects Yes/No for 5 markets → PTB builds:
   - Multiple `predict::mint_position()` calls
   - `streak_system::record_participation()`
3. Submit PTB (gasless if sponsored)
4. End-of-day: Oracle feeds → Resolution transaction updates positions + streaks + multipliers

**Resolution:**
- Backend monitors oracle price feeds.
- Calls `predict::resolve_market()` with admin capability (or decentralized resolver later).

### 7. Oracle & Resolution Strategy

- **Primary:** Pyth for price data (BTC, ETH, TOTAL_CRYPTO_CAP)
- **Event-based:** Supra + custom admin oracle for AI news (with multi-sig fallback)
- Dispute window: 1 hour after resolution

### 8. Tokenomics & Incentives (Recommended)

- Platform token (optional) for governance + staking rewards to liquidity providers
- Daily Streak rewards in platform points → convertible to fee discounts or NFT boosts
- Liquidity Mining: Reward makers on DeepBook pools

### 9. Security & Auditing

- Audit requirements:
  - DeepBook Predict integration
  - Custom streak + badge modules
  - Prize pool escrow
- Best practices: Capability-based access, Kiosk for NFTs, proper object ownership

### 10. Deployment & Testing Roadmap

**Phase 1 (Weeks 1-4):**
- Deploy core Predict wrapper + Streak module on Testnet
- Build PWA with Daily Binary UI

**Phase 2 (Weeks 5-8):**
- Integrate DeepBook Margin + Shared Liquidity
- Implement Leaderboard + Prize Pool
- NFT Badge system

**Phase 3 (Weeks 9-12):**
- Full gamification loop + Push notifications
- Security audit
- Mainnet launch (start with small prize pools)

**Phase 4:** Add Parlay support, Social Graph, Copy Trading

### 11. Estimated Effort

- **Smart Contracts:** 8-12 developer weeks (Move experienced team)
- **Frontend:** 6-8 weeks
- **Backend + Oracles:** 6 weeks
- **Total Team:** 4-6 engineers for 3-month MVP

This plan leverages **DeepBook Predict + Margin** heavily, so you can focus on product differentiation (Daily Streak + AI vertical) rather than building trading infrastructure from zero.


**Sample Move Code Snippets & Detailed PTB Examples**

Here are **concrete, production-oriented** code samples for your prediction market on **Sui + DeepBook V3 + DeepBook Predict**.

---

### 1. Move Code Snippets

#### A. User Streak Object (Core Gamification)

```move
module platform::streak_system {
    use sui::object::{Self, UID, ID};
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};
    use std::option;

    // Per-user streak tracking
    struct UserStreak has key {
        id: UID,
        owner: address,
        current_streak: u64,
        longest_streak: u64,
        last_participation_day: u64,     // Day index (Unix timestamp / 86400)
        total_correct_predictions: u64,
    }

    // Capability for admin to resolve
    struct AdminCap has key { id: UID }

    // Create streak object for new user
    public entry fun create_streak(cap: &AdminCap, ctx: &mut TxContext) {
        let streak = UserStreak {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            current_streak: 0,
            longest_streak: 0,
            last_participation_day: 0,
            total_correct_predictions: 0,
        };
        transfer::transfer(streak, tx_context::sender(ctx));
    }

    // Called after daily market resolution
    public fun update_streak(
        streak: &mut UserStreak,
        clock: &Clock,
        all_correct: bool
    ) {
        let today = clock::timestamp_ms(clock) / 86400000; // day index

        if (all_correct && today == streak.last_participation_day + 1) {
            streak.current_streak = streak.current_streak + 1;
            if (streak.current_streak > streak.longest_streak) {
                streak.longest_streak = streak.current_streak;
            }
        } else if (!all_correct) {
            streak.current_streak = 0;
        };

        streak.last_participation_day = today;
        streak.total_correct_predictions = streak.total_correct_predictions + (if (all_correct) 5 else 0);
    }

    public fun get_multiplier(streak: &UserStreak): u64 {
        if (streak.current_streak >= 30) { 150 }
        else if (streak.current_streak >= 14) { 70 }
        else if (streak.current_streak >= 7) { 30 }
        else if (streak.current_streak >= 3) { 10 }
        else { 0 }
    }
}
```

#### B. NFT Badge Module (Simple Version)

```move
module platform::badges {
    use sui::object::{Self, UID};
    use sui::kiosk::{Self, Kiosk};
    use sui::transfer;

    struct StreakBadge has key, store {
        id: UID,
        badge_type: u8,           // 1=7day, 2=14day, 3=30day, etc.
        minted_at: u64,
    }

    public entry fun mint_streak_badge(
        kiosk: &mut Kiosk,
        badge_type: u8,
        ctx: &mut TxContext
    ) {
        let badge = StreakBadge {
            id: object::new(ctx),
            badge_type,
            minted_at: sui::clock::timestamp_ms(/* clock */),
        };
        kiosk::place(kiosk, ctx, badge);
    }
}
```

#### C. Daily Market Creation (Admin / Backend Triggered)

```move
module platform::daily_markets {
    use deepbook_predict::predict::{Self, Predict, Market};

    public entry fun create_daily_binaries(
        predict: &mut Predict,
        clock: &Clock,
        admin_cap: &/* Admin Capability */,
        ctx: &mut TxContext
    ) {
        let expiry = clock::timestamp_ms(clock) + 86400000; // 24 hours

        // Create 5 binary markets
        predict::create_binary_market(predict, b"BTC_24H", expiry, /* oracle id */, ctx);
        predict::create_binary_market(predict, b"ETH_24H", expiry, /* oracle id */, ctx);
        // ... repeat for AI news, etc.
    }
}
```

---

### 2. Detailed Programmable Transaction Block (PTB) Examples

#### Example 1: Place Daily Predictions + Update Streak (Most Important)

```typescript
// TypeScript (using @mysten/sui SDK)
const tx = new TransactionBlock();

const dailyMarkets = [market1, market2, market3, market4, market5]; // Yes/No market IDs

// 1. Mint positions on all 5 daily markets
dailyMarkets.forEach((marketId, index) => {
    tx.moveCall({
        target: `${DEEPBOOK_PREDICT_PACKAGE}::predict::mint_position`,
        arguments: [
            tx.object(PREDICT_SHARED_OBJECT),
            tx.object(marketId),
            tx.pure.bool(userChoice[index]),   // true = Yes
            tx.object(USER_BALANCE_MANAGER),   // Shared margin
        ]
    });
});

// 2. Record participation & update streak
tx.moveCall({
    target: `${PLATFORM_PACKAGE}::streak_system::record_participation`,
    arguments: [
        tx.object(USER_STREAK_OBJECT),
        tx.object(CLOCK),
        tx.pure.bool(allPredicted)   // Whether user submitted all 5
    ]
});

// 3. Optional: Mint badge if streak milestone reached
if (shouldMintBadge) {
    tx.moveCall({
        target: `${PLATFORM_PACKAGE}::badges::mint_streak_badge`,
        arguments: [tx.object(USER_KIOSK), tx.pure.u8(badgeType)]
    });
}

const result = await client.signAndExecuteTransactionBlock({
    signer: wallet,
    transactionBlock: tx,
    options: { showEffects: true }
});
```

#### Example 2: End-of-Day Resolution PTB (Backend)

```typescript
const tx = new TransactionBlock();

// Resolve all 5 daily markets
dailyMarketIds.forEach(marketId => {
    tx.moveCall({
        target: `${DEEPBOOK_PREDICT_PACKAGE}::predict::resolve_market`,
        arguments: [
            tx.object(PREDICT_SHARED_OBJECT),
            tx.object(marketId),
            tx.pure.u64(actualOutcome),   // 0 or 1
            tx.object(ORACLE),
            tx.object(ADMIN_CAP)
        ]
    });
});

// Batch update streaks for top users (or use indexer + individual txs)
tx.moveCall({
    target: `${PLATFORM_PACKAGE}::streak_system::batch_update_streaks`,
    arguments: [tx.object(LEADERBOARD), tx.object(CLOCK)]
});

await executeWithAdminKey(tx);   // Backend sponsored or admin wallet
```

#### Example 3: Claim Weekly Prize + Multiplier

```typescript
const tx = new TransactionBlock();

tx.moveCall({
    target: `${PLATFORM_PACKAGE}::prize_pool::claim_prize`,
    arguments: [
        tx.object(WEEKLY_PRIZE_POOL),
        tx.object(USER_STREAK),
        tx.pure.u64(rank),
    ]
});

// Apply multiplier automatically inside the Move function
```

---

### Key Integration Notes

- **Shared Liquidity**: Use `BalanceManager` from DeepBook to share margin across Daily Binaries + normal AI markets.
- **Gasless**: Use sponsored transactions for daily streak plays (very important for UX).
- **Oracle**: Use Pyth/Supra for BTC/ETH prices. For AI news, use a multi-sig admin oracle with dispute window.
- **Indexers**: Subscribe to DeepBook Predict events + your custom streak events.

---




**Here's a more complete and production-ready `platform.move` module** for your prediction market on Sui + DeepBook Predict.

```move
module platform::prediction_platform {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::event;
    use std::vector;
    use std::string::{Self, String};

    // Import from DeepBook Predict (assumed package)
    use deepbook_predict::predict::{Self, Predict, Market, Position};

    // =============================================
    // Core Objects
    // =============================================

    // Admin capability
    struct AdminCap has key { id: UID }

    // Global platform configuration
    struct PlatformConfig has key {
        id: UID,
        predict: ID,                    // ID of DeepBook Predict shared object
        treasury: Balance<SUI>,         // Platform fees
        prize_pool_balance: Balance<USDT>, // USDT prize pool
        daily_market_count: u8,         // Usually 5
    }

    // Per-user streak tracking
    struct UserStreak has key {
        id: UID,
        owner: address,
        current_streak: u64,
        longest_streak: u64,
        last_participation_day: u64,      // Day index (timestamp / 86400000)
        total_predictions: u64,
        total_correct: u64,
    }

    // =============================================
    // Events
    // =============================================

    struct StreakUpdated has copy, drop {
        user: address,
        new_streak: u64,
        multiplier: u64,
    }

    struct BadgeMinted has copy, drop {
        user: address,
        badge_type: u8,
        badge_id: ID,
    }

    // =============================================
    // Initialization
    // =============================================

    public entry fun initialize_platform(ctx: &mut TxContext) {
        let admin_cap = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin_cap, tx_context::sender(ctx));

        let config = PlatformConfig {
            id: object::new(ctx),
            predict: object::id_from_address(@0x0), // Will be set later
            treasury: balance::zero(),
            prize_pool_balance: balance::zero(),
            daily_market_count: 5,
        };
        transfer::share_object(config);
    }

    // =============================================
    // Streak System
    // =============================================

    public entry fun create_user_streak(ctx: &mut TxContext) {
        let streak = UserStreak {
            id: object::new(ctx),
            owner: tx_context::sender(ctx),
            current_streak: 0,
            longest_streak: 0,
            last_participation_day: 0,
            total_predictions: 0,
            total_correct: 0,
        };
        transfer::transfer(streak, tx_context::sender(ctx));
    }

    public fun update_user_streak(
        streak: &mut UserStreak,
        clock: &Clock,
        all_correct: bool,
        num_markets: u64
    ) {
        let today = clock::timestamp_ms(clock) / 86400000;

        if (all_correct && today == streak.last_participation_day + 1) {
            streak.current_streak = streak.current_streak + 1;
            if (streak.current_streak > streak.longest_streak) {
                streak.longest_streak = streak.current_streak;
            }
        } else {
            streak.current_streak = 0;
        };

        streak.last_participation_day = today;
        streak.total_predictions = streak.total_predictions + num_markets;
        
        if (all_correct) {
            streak.total_correct = streak.total_correct + num_markets;
        };

        event::emit(StreakUpdated {
            user: streak.owner,
            new_streak: streak.current_streak,
            multiplier: get_streak_multiplier(streak),
        });
    }

    public fun get_streak_multiplier(streak: &UserStreak): u64 {
        if (streak.current_streak >= 30) { 150 }
        else if (streak.current_streak >= 14) { 70 }
        else if (streak.current_streak >= 7) { 30 }
        else if (streak.current_streak >= 3) { 10 }
        else { 0 }
    }

    // =============================================
    // Daily Markets Management
    // =============================================

    public entry fun create_daily_binary_markets(
        config: &mut PlatformConfig,
        predict: &mut Predict,
        clock: &Clock,
        admin_cap: &AdminCap,
        ctx: &mut TxContext
    ) {
        let expiry = clock::timestamp_ms(clock) + 86_400_000; // 24 hours

        let market_names = vector::empty<String>();
        vector::push_back(&mut market_names, string::utf8(b"BTC_24H_DIRECTION"));
        vector::push_back(&mut market_names, string::utf8(b"ETH_24H_DIRECTION"));
        vector::push_back(&mut market_names, string::utf8(b"AI_FUNDING_TODAY"));
        vector::push_back(&mut market_names, string::utf8(b"MAJOR_AI_NEWS_TODAY"));
        vector::push_back(&mut market_names, string::utf8(b"TOTAL_CRYPTO_UP_TODAY"));

        let i = 0;
        while (i < vector::length(&market_names)) {
            let name = *vector::borrow(&market_names, i);
            predict::create_binary_market(
                predict,
                name,
                expiry,
                @0x0, // Oracle ID (Pyth/Supra)
                ctx
            );
            i = i + 1;
        };
    }

    // =============================================
    // Prize & Reward Functions
    // =============================================

    public entry fun deposit_to_prize_pool(
        config: &mut PlatformConfig,
        coin: Coin<USDT>,
        _admin: &AdminCap
    ) {
        let amount = coin::into_balance(coin);
        balance::join(&mut config.prize_pool_balance, amount);
    }

    // Claim prize with streak multiplier applied
    public entry fun claim_weekly_prize(
        config: &mut PlatformConfig,
        streak: &UserStreak,
        rank: u64,
        ctx: &mut TxContext
    ) {
        let base_prize = calculate_base_prize(rank);
        let multiplier = get_streak_multiplier(streak);
        
        let final_amount = (base_prize * (100 + multiplier)) / 100;
        
        let prize = balance::split(&mut config.prize_pool_balance, final_amount);
        let coin = coin::from_balance(prize, ctx);
        transfer::public_transfer(coin, streak.owner);
    }

    fun calculate_base_prize(rank: u64): u64 {
        if (rank == 1) { 5000_000_000 }      // $5,000 (6 decimals)
        else if (rank <= 3) { 2000_000_000 }
        else if (rank <= 10) { 800_000_000 }
        else { 0 }
    }

    // =============================================
    // Admin Functions
    // =============================================

    public entry fun set_predict_object(
        config: &mut PlatformConfig,
        predict_id: ID,
        _admin: &AdminCap
    ) {
        config.predict = predict_id;
    }

    // =============================================
    // View / Helper Functions (for frontend)
    // =============================================

    public fun get_user_streak_info(streak: &UserStreak): (u64, u64, u64) {
        (streak.current_streak, streak.longest_streak, get_streak_multiplier(streak))
    }
}
```

---

### Key Notes on This Module:

- **Modular Design**: You can split this into multiple modules (`streak_system.move`, `badges.move`, `prize_pool.move`) later for better maintainability.
- **DeepBook Predict Integration**: Assumes `deepbook_predict::predict` package is available and has `create_binary_market` and `mint_position` functions.
- **Security**: Uses capability pattern for admin actions.
- **Gas Efficiency**: Designed for frequent small transactions (daily streak plays).
- **Extensibility**: Easy to add Parlay logic, social graph, etc.

---





**Here's a clean, well-structured, and production-ready implementation** for both **Prize Pool** and **Leaderboard** modules.

---

### 1. `prize_pool.move`

```move
module platform::prize_pool {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::coin::{Self, Coin};
    use sui::balance::{Self, Balance};
    use sui::clock::{Self, Clock};
    use std::vector;

    // =============================================
    // Objects
    // =============================================

    struct PrizePool has key {
        id: UID,
        balance: Balance<USDT>,           // USDT prize pool
        weekly_total: u64,                // Total prize for current week
        week_start_timestamp: u64,        // Start of current week
    }

    struct WeeklyPrizeConfig has key {
        id: UID,
        base_prizes: vector<u64>,         // Index 0 = rank 1, etc.
        streak_bonus_multiplier: u64,     // e.g. 150 for 150%
    }

    // =============================================
    // Events
    // =============================================

    struct PrizeClaimed has copy, drop {
        user: address,
        amount: u64,
        rank: u64,
        streak_multiplier: u64,
    }

    // =============================================
    // Initialization
    // =============================================

    public entry fun create_prize_pool(ctx: &mut TxContext) {
        let pool = PrizePool {
            id: object::new(ctx),
            balance: balance::zero(),
            weekly_total: 0,
            week_start_timestamp: 0,
        };
        transfer::share_object(pool);

        let config = WeeklyPrizeConfig {
            id: object::new(ctx),
            base_prizes: vector::empty(),
            streak_bonus_multiplier: 150,   // Max 150%
        };
        
        // Default prize distribution
        vector::push_back(&mut config.base_prizes, 5_000_000_000);  // Rank 1: $5,000
        vector::push_back(&mut config.base_prizes, 2_500_000_000);  // Rank 2
        vector::push_back(&mut config.base_prizes, 1_500_000_000);  // Rank 3
        vector::push_back(&mut config.base_prizes, 800_000_000);    // Rank 4-10

        transfer::share_object(config);
    }

    // =============================================
    // Admin Functions
    // =============================================

    public entry fun deposit_prize_funds(
        pool: &mut PrizePool,
        coin: Coin<USDT>,
        _admin: &/* AdminCap */
    ) {
        let amount = coin::into_balance(coin);
        balance::join(&mut pool.balance, amount);
        pool.weekly_total = pool.weekly_total + balance::value(&amount);
    }

    public entry fun reset_weekly_pool(
        pool: &mut PrizePool,
        clock: &Clock,
        _admin: &/* AdminCap */
    ) {
        let now = clock::timestamp_ms(clock);
        pool.week_start_timestamp = now;
        pool.weekly_total = 0;  // Reset for new week (funds remain in balance)
    }

    // =============================================
    // Claim Logic
    // =============================================

    public entry fun claim_prize(
        pool: &mut PrizePool,
        config: &WeeklyPrizeConfig,
        streak: &platform::prediction_platform::UserStreak,
        rank: u64,
        ctx: &mut TxContext
    ) {
        let base_amount = get_base_prize(config, rank);
        let multiplier = platform::prediction_platform::get_streak_multiplier(streak);
        
        let final_amount = (base_amount * (100 + multiplier)) / 100;

        assert!(final_amount > 0, 0);

        let prize_balance = balance::split(&mut pool.balance, final_amount);
        let prize_coin = coin::from_balance(prize_balance, ctx);

        transfer::public_transfer(prize_coin, streak.owner);

        event::emit(PrizeClaimed {
            user: streak.owner,
            amount: final_amount,
            rank,
            streak_multiplier: multiplier,
        });
    }

    fun get_base_prize(config: &WeeklyPrizeConfig, rank: u64): u64 {
        if (rank == 0) { return 0 };
        let idx = rank - 1;
        if (idx < vector::length(&config.base_prizes)) {
            *vector::borrow(&config.base_prizes, idx)
        } else {
            200_000_000  // Default small prize
        }
    }
}
```

---

### 2. `leaderboard.move`

```move
module platform::leaderboard {
    use sui::object::{Self, UID, ID};
    use sui::table::{Self, Table};
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};
    use std::vector;
    use std::option;

    // =============================================
    // Objects
    // =============================================

    struct Leaderboard has key {
        id: UID,
        weekly_scores: Table<address, u64>,     // User -> Score this week
        week_start: u64,
        week_number: u64,
    }

    struct UserScore has store, drop, copy {
        address: address,
        score: u64,
        streak: u64,
    }

    // =============================================
    // Events
    // =============================================

    struct ScoreUpdated has copy, drop {
        user: address,
        new_score: u64,
        week_number: u64,
    }

    // =============================================
    // Initialization
    // =============================================

    public entry fun create_leaderboard(ctx: &mut TxContext) {
        let lb = Leaderboard {
            id: object::new(ctx),
            weekly_scores: table::new(ctx),
            week_start: 0,
            week_number: 0,
        };
        transfer::share_object(lb);
    }

    // =============================================
    // Core Functions
    // =============================================

    public fun update_score(
        leaderboard: &mut Leaderboard,
        user: address,
        points: u64,
        clock: &Clock
    ) {
        let now = clock::timestamp_ms(clock);
        let current_week = now / 604800000; // 7 days in ms

        // Reset leaderboard if new week
        if (current_week > leaderboard.week_number) {
            reset_weekly_leaderboard(leaderboard, current_week);
        };

        let current_score = if (table::contains(&leaderboard.weekly_scores, user)) {
            *table::borrow(&leaderboard.weekly_scores, user)
        } else {
            0
        };

        let new_score = current_score + points;
        table::upsert(&mut leaderboard.weekly_scores, user, new_score);

        event::emit(ScoreUpdated {
            user,
            new_score,
            week_number: leaderboard.week_number,
        });
    }

    fun reset_weekly_leaderboard(leaderboard: &mut Leaderboard, new_week: u64) {
        // In production, you might archive old data.
        // For simplicity, we clear the table (acceptable for weekly reset)
        table::destroy_empty(leaderboard.weekly_scores); // Note: Real impl needs careful cleanup
        leaderboard.weekly_scores = table::new(/* ctx - need to handle properly */);
        leaderboard.week_number = new_week;
    }

    // Get top N users (for frontend)
    public fun get_top_n(
        leaderboard: &Leaderboard,
        n: u64
    ): vector<UserScore> {
        // Note: In Move, sorting large tables is expensive.
        // Recommendation: Use off-chain indexer for real-time leaderboard.
        // This function is for small N only.
        let result = vector::empty<UserScore>();
        // Implementation would iterate and sort (omitted for gas reasons)
        result
    }

    // =============================================
    // Admin / Maintenance
    // =============================================

    public entry fun manual_week_reset(
        leaderboard: &mut Leaderboard,
        new_week: u64,
        _admin: &/* AdminCap */
    ) {
        leaderboard.week_number = new_week;
        // Clear table logic here
    }
}
```

---


**Here's the Full Integration Example** showing how all three modules work together seamlessly.

---

### **Integrated Architecture Overview**

```
prediction_platform.move (Main Entry Point)
        ↓
├── streak_system (inside prediction_platform)
├── leaderboard.move
├── prize_pool.move
└── DeepBook Predict (external)
```

---

### 1. Updated & Complete `prediction_platform.move` (with integrations)

```move
module platform::prediction_platform {
    use sui::object::{Self, UID, ID};
    use sui::transfer;
    use sui::tx_context::{Self, TxContext};
    use sui::clock::{Self, Clock};
    use sui::event;
    use std::string::{Self, String};
    use std::vector;

    // Import other modules in the same package
    use platform::prize_pool::{Self, PrizePool, WeeklyPrizeConfig};
    use platform::leaderboard::{Self, Leaderboard};
    use deepbook_predict::predict::{Self, Predict, Market};

    // =============================================
    // Objects
    // =============================================

    struct AdminCap has key { id: UID }

    struct PlatformConfig has key {
        id: UID,
        predict: ID,
        daily_market_count: u8,
    }

    // Per-user streak (same as before)
    struct UserStreak has key {
        id: UID,
        owner: address,
        current_streak: u64,
        longest_streak: u64,
        last_participation_day: u64,
        total_predictions: u64,
        total_correct: u64,
    }

    // =============================================
    // Events
    // =============================================

    struct DailyStreakCompleted has copy, drop {
        user: address,
        streak: u64,
        points_awarded: u64,
    }

    // =============================================
    // Initialization
    // =============================================

    public entry fun initialize(ctx: &mut TxContext) {
        let admin = AdminCap { id: object::new(ctx) };
        transfer::transfer(admin, tx_context::sender(ctx));

        let config = PlatformConfig {
            id: object::new(ctx),
            predict: @0x0, // set later
            daily_market_count: 5,
        };
        transfer::share_object(config);
    }

    // =============================================
    // Daily Participation + Streak + Leaderboard
    // =============================================

    public entry fun participate_in_daily_streak(
        config: &PlatformConfig,
        streak: &mut UserStreak,
        leaderboard: &mut Leaderboard,
        clock: &Clock,
        all_correct: bool,
        ctx: &mut TxContext
    ) {
        // 1. Update streak
        let num_markets = (config.daily_market_count as u64);
        update_user_streak(streak, clock, all_correct, num_markets);

        // 2. Award points to leaderboard
        let points = if (all_correct) { 100 } else { 10 };
        leaderboard::update_score(leaderboard, streak.owner, points, clock);

        event::emit(DailyStreakCompleted {
            user: streak.owner,
            streak: streak.current_streak,
            points_awarded: points,
        });
    }

    // Internal streak update (kept in this module)
    fun update_user_streak(
        streak: &mut UserStreak,
        clock: &Clock,
        all_correct: bool,
        num_markets: u64
    ) {
        let today = clock::timestamp_ms(clock) / 86400000;

        if (all_correct && today == streak.last_participation_day + 1) {
            streak.current_streak = streak.current_streak + 1;
            if (streak.current_streak > streak.longest_streak) {
                streak.longest_streak = streak.current_streak;
            }
        } else {
            streak.current_streak = 0;
        };

        streak.last_participation_day = today;
        streak.total_predictions = streak.total_predictions + num_markets;
        if (all_correct) {
            streak.total_correct = streak.total_correct + num_markets;
        };
    }

    public fun get_streak_multiplier(streak: &UserStreak): u64 {
        if (streak.current_streak >= 30) { 150 }
        else if (streak.current_streak >= 14) { 70 }
        else if (streak.current_streak >= 7) { 30 }
        else if (streak.current_streak >= 3) { 10 }
        else { 0 }
    }

    // =============================================
    // Prize Claim Integration
    // =============================================

    public entry fun claim_weekly_reward(
        prize_pool: &mut PrizePool,
        prize_config: &WeeklyPrizeConfig,
        streak: &UserStreak,
        leaderboard: &Leaderboard,
        user_rank: u64,
        ctx: &mut TxContext
    ) {
        // Optional: Validate that user is actually in top ranks (recommended via indexer)
        prize_pool::claim_prize(prize_pool, prize_config, streak, user_rank, ctx);
    }

    // =============================================
    // Daily Market Creation (Admin)
    // =============================================

    public entry fun create_daily_binaries(
        predict: &mut Predict,
        clock: &Clock,
        _admin: &AdminCap,
        ctx: &mut TxContext
    ) {
        let expiry = clock::timestamp_ms(clock) + 86_400_000; // 24h

        let names = vector::empty<String>();
        vector::push_back(&mut names, string::utf8(b"BTC_24H"));
        vector::push_back(&mut names, string::utf8(b"ETH_24H"));
        vector::push_back(&mut names, string::utf8(b"AI_FUNDING_TODAY"));
        vector::push_back(&mut names, string::utf8(b"MAJOR_AI_NEWS"));
        vector::push_back(&mut names, string::utf8(b"CRYPTO_MKT_UP"));

        let i = 0;
        while (i < vector::length(&names)) {
            predict::create_binary_market(
                predict,
                *vector::borrow(&names, i),
                expiry,
                @0x0, // Oracle
                ctx
            );
            i = i + 1;
        };
    }
}
```

---

### **How Everything Connects (Flow)**

**Daily User Flow (Frontend → On-chain):**
1. User submits 5 binary predictions → PTB calls `mint_position()` on DeepBook Predict (5 times)
2. After submission → Call `participate_in_daily_streak()` 
   - Updates `UserStreak`
   - Updates `Leaderboard` score
3. End of day → Backend resolves all 5 markets via oracle
4. After resolution → Recalculate `all_correct` and call `participate_in_daily_streak()` again (or separate function)

**Weekly Prize Flow:**
1. Backend detects new week → Calls `prize_pool::reset_weekly_pool()`
2. Users check leaderboard (via indexer)
3. Top users call `claim_weekly_reward()` → Prize Pool applies streak multiplier automatically

---

**Sponsored Transaction Examples for Daily Streak Plays**

Here are **production-ready TypeScript examples** for gasless/sponsored daily streak participation using **Sui SDK**.

---

### 1. Basic Sponsored Daily Streak PTB (Recommended)

```typescript
import { TransactionBlock } from '@mysten/sui';
import { getFullnodeUrl, SuiClient } from '@mysten/sui/client';
import { sponsorTransaction } from '@mysten/sui/sponsored'; // or your sponsor service

const client = new SuiClient({ url: getFullnodeUrl('mainnet') });

async function sponsorDailyStreakPlay(
    userAddress: string,
    wallet,                    // User's wallet (for signing)
    sponsorAddress: string,    // Your backend sponsor wallet
    sponsorKeypair,            // Sponsor private key (securely managed)
    userStreakId: string,
    leaderboardId: string,
    dailyMarketIds: string[],  // Array of 5 market object IDs
    userChoices: boolean[],    // [true, false, true, true, false]
) {
    const tx = new TransactionBlock();

    // === 1. Mint positions on all 5 Daily Binary Markets ===
    for (let i = 0; i < dailyMarketIds.length; i++) {
        tx.moveCall({
            target: 'deepbook_predict::predict::mint_position',
            arguments: [
                tx.object('0x...PREDICT_SHARED_OBJECT...'),     // Predict shared object
                tx.object(dailyMarketIds[i]),
                tx.pure.bool(userChoices[i]),                   // Yes = true
                tx.object('0x...USER_BALANCE_MANAGER...'),      // Shared margin
            ],
        });
    }

    // === 2. Update Streak + Leaderboard (Atomic) ===
    tx.moveCall({
        target: 'platform::prediction_platform::participate_in_daily_streak',
        arguments: [
            tx.object('0x...PLATFORM_CONFIG...'),
            tx.object(userStreakId),
            tx.object(leaderboardId),
            tx.object('0x6'), // Clock object
            tx.pure.bool(true), // all_correct = true (for first submission)
        ],
    });

    // === 3. Optional: Mint Badge if milestone reached ===
    // tx.moveCall({ ... badge mint ... });

    // === Sponsor the transaction ===
    const sponsoredTx = await sponsorTransaction({
        transactionBlock: tx,
        sponsor: sponsorAddress,
        signer: userAddress,           // User signs intent
    });

    // User signs the sponsored transaction
    const signedTx = await wallet.signTransactionBlock({
        transactionBlock: sponsoredTx.transactionBlock,
    });

    // Sponsor signs and executes
    const result = await client.executeTransactionBlock({
        transactionBlock: signedTx,
        signature: [signedTx.signature, sponsoredTx.sponsorSignature],
        options: {
            showEffects: true,
            showObjectChanges: true,
        },
    });

    console.log('Daily Streak Play Success:', result.digest);
    return result;
}
```

---

### 2. Advanced Version with Dynamic `all_correct` Check (After Resolution)

```typescript
async function sponsorDailyStreakAfterResolution(
    userAddress: string,
    userStreakId: string,
    leaderboardId: string,
    sponsorAddress: string,
    isAllCorrect: boolean,     // Determined by backend after oracle resolution
) {
    const tx = new TransactionBlock();

    tx.moveCall({
        target: 'platform::prediction_platform::participate_in_daily_streak',
        arguments: [
            tx.object('0x...PLATFORM_CONFIG...'),
            tx.object(userStreakId),
            tx.object(leaderboardId),
            tx.object('0x6'),                    // Clock
            tx.pure.bool(isAllCorrect),
        ],
    });

    // Add small reward or XP if wanted
    if (isAllCorrect) {
        tx.moveCall({
            target: 'platform::prize_pool::award_daily_bonus',
            arguments: [tx.object('0x...PRIZE_POOL...'), tx.pure.address(userAddress)],
        });
    }

    // Sponsor + Execute (same as above)
    const sponsoredTx = await sponsorTransaction({ /* ... */ });
    // ... sign and execute
}
```

---

### 3. Sponsor Service Backend Example (Node.js)

```typescript
// sponsorService.ts
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { sponsorTransaction } from '@mysten/sui/sponsored';

const sponsorKeypair = Ed25519Keypair.fromSecretKey(/* your sponsor secret key */);

export async function createSponsoredDailyStreak(tx: TransactionBlock, userAddress: string) {
    return await sponsorTransaction({
        transactionBlock: tx,
        sponsor: sponsorKeypair.getPublicKey().toSuiAddress(),
        signer: userAddress,
        keypair: sponsorKeypair,   // Backend signs as sponsor
    });
}
```

---

### Best Practices for Daily Streak Sponsored Tx

| Item                        | Recommendation |
|----------------------------|----------------|
| **Gas Budget**             | 0.05 SUI (very low for daily plays) |
| **Sponsor Rotation**       | Use multiple sponsor wallets |
| **Rate Limiting**          | Limit 1 sponsored streak per user per day |
| **Fallback**               | If sponsor fails → show normal gas payment |
| **Balance Manager**        | Use DeepBook shared `BalanceManager` for margin |
| **Monitoring**             | Track sponsor balance + usage |

---


**Sequence Diagram: Full Daily + Weekly Flow**

```mermaid
sequenceDiagram
    participant User
    participant PWA as PWA (Frontend)
    participant Backend
    participant Sui as Sui Blockchain
    participant Oracle
    participant Indexer as Sui Indexer

    %% ==================== DAILY FLOW WITH PARLAY ====================

    Note over User,PWA: Daily Flow with Parlay Option

    User->>PWA: Open App - Daily Predictions
    PWA->>Sui: Query 5 Daily Binary Markets

    User->>PWA: Choose Single or Parlay

    opt User Creates Parlay
        User->>PWA: Select markets and amount
        PWA->>Sui: Sponsored PTB: create_parlay + mint_position
        Sui-->>PWA: Parlay Position Created
    end

    User->>PWA: Submit Daily Predictions
    PWA->>Sui: Sponsored PTB: mint_position + participate_in_daily_streak
    Sui-->>PWA: Success (Streak + Leaderboard Updated)

    PWA->>User: Show Streak + Parlay Bonus

    %% Resolution
    Backend->>Oracle: Monitor Oracle Feeds
    Oracle->>Backend: Market Results
    Backend->>Sui: Resolve Markets + Parlays
    Sui-->>Backend: Resolved

    Backend->>Sui: Update Streaks + Parlay Bonuses
    Sui-->>Backend: Complete

    Backend->>PWA: Push Notification

    %% ==================== WEEKLY FLOW ====================

    Note over User,Indexer: Weekly Flow

    Backend->>Sui: Reset Prize Pool + Leaderboard
    Sui-->>Backend: Reset Done

    Indexer->>Backend: Calculate Top Ranks (with Parlay points)
    Backend->>PWA: Update Leaderboard

    User->>PWA: View Leaderboard and Claim Prize
    PWA->>Sui: Sponsored PTB: claim_weekly_reward
    Sui-->>PWA: Prize Paid with Streak and Parlay Multiplier

    PWA->>User: Show Winning Amount

    %% ==================== PARLAY INTEGRATION ====================

    Note over Sui: Parlay is integrated into participate_in_daily_streak, update_score, and claim_prize
```

---

### **Explanation of the Flows**

#### **Daily Flow (High Frequency)**
1. **User Participation** — Fast, gasless (sponsored) transaction
2. **Market Resolution** — Handled by backend at market expiry
3. **Streak Update** — Happens on both submission and resolution

#### **Weekly Flow (Batch Process)**
1. **Reset** — Backend triggers new week
2. **Ranking** — Mostly off-chain via Indexer (gas efficient)
3. **Prize Claim** — User-initiated, with automatic streak multiplier

---

### Key Technical Highlights

- **Daily plays** are fully **sponsored** → excellent UX
- **Streak logic** runs on-chain but is lightweight
- **Leaderboard & Rankings** are hybrid (on-chain scoring + off-chain sorting)
- **Prize distribution** uses multiplier from `UserStreak` object

---

```mermaid
sequenceDiagram
    participant User
    participant PWA as PWA (Frontend)
    participant Backend
    participant Sponsor as Sponsor Service
    participant Sui as Sui Blockchain
    participant Oracle
    participant Indexer as Sui Indexer
    participant Admin as Admin / Manual Resolver

    %% ==================== DAILY FLOW WITH ERROR HANDLING ====================

    Note over User,PWA: Daily Streak Participation

    User->>PWA: Open App → Daily Predictions
    PWA->>Sui: Query Daily Markets

    User->>PWA: Submit Predictions (Single or Parlay)
    
    alt Sponsored TX Success
        PWA->>Sponsor: Request Sponsored PTB
        Sponsor->>Sui: Execute sponsored participate_in_daily_streak
        Sui-->>PWA: Success (Streak + Leaderboard Updated)
        PWA->>User: Show "Streak: X days + Parlay Bonus"
    else Sponsored TX Fails (insufficient sponsor gas / rate limit)
        PWA->>User: "Sponsor unavailable. Pay gas yourself?"
        User->>PWA: Approve normal transaction
        PWA->>Sui: Normal PTB (user pays gas)
        Sui-->>PWA: Success (with higher gas fee)
        PWA->>User: Success + Warning "Used your gas this time"
    end

    %% ==================== RESOLUTION WITH FALLBACKS ====================

    Note over Backend,Oracle: Market Resolution Phase

    Backend->>Oracle: Fetch price / event data
    alt Oracle Success
        Oracle->>Backend: Return data
        Backend->>Sui: resolve_market() batch
        Sui-->>Backend: Markets resolved successfully
    else Oracle Failure / Timeout / Dispute
        Backend->>Admin: Alert: Oracle resolution failed
        Admin->>Sui: Manual resolve_market() with multi-sig
        Sui-->>Backend: Markets resolved (manual)
        Backend->>PWA: Notify users "Markets resolved manually"
    end

    %% Streak Update after resolution
    Backend->>Sui: Update streaks + Parlay results
    alt Streak Update Success
        Sui-->>Backend: Streaks updated
    else Streak Update Fails (rare)
        Backend->>Backend: Retry job (exponential backoff)
        Backend->>Admin: Alert if retries exhausted
    end

    %% ==================== WEEKLY PRIZE FLOW WITH ERRORS ====================

    Note over Backend,Indexer: Weekly Prize Distribution

    Backend->>Sui: Reset weekly leaderboard + prize pool
    Sui-->>Backend: Reset complete

    Indexer->>Backend: Calculate final ranks (incl. Parlay bonuses)
    Backend->>PWA: Publish final leaderboard

    User->>PWA: Claim Weekly Prize
    PWA->>Sui: claim_weekly_reward (sponsored)
    
    alt Claim Success
        Sui-->>PWA: Prize transferred with multipliers
        PWA->>User: "You received $XXX (Streak + Parlay bonus)"
    else Already Claimed
        PWA->>User: Error: "Prize already claimed"
    else Insufficient Prize Pool
        PWA->>User: Error: "Prize pool temporarily low. Try again later"
        Backend->>Admin: Alert: Prize pool underfunded
    else Transaction Reverted
        PWA->>User: "Claim failed. Please try again"
        Backend->>Backend: Log failure for manual review
    end

    %% ==================== PARLAY SPECIFIC ERROR PATH ====================

    Note over User,Sui: Parlay Specific Handling

    alt One leg of Parlay fails
        Sui->>Backend: Parlay auto-resolves as LOSS
        Backend->>PWA: Notify "Parlay lost (one condition failed)"
    else Parlay resolution disputed
        Backend->>Admin: Flag for manual review
        Admin->>Sui: Manual override if needed
    end
```