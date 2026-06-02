#[test_only]
module suipredict_agent_policy::prize_pool_tests;

use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use suipredict_agent_policy::prize_pool::{
    Self,
    PrizeAdmin,
    PrizePool,
};
use suipredict_agent_policy::streak_system::{
    Self,
    StreakRegistry,
    UserStreak,
};

const ADMIN: address = @0xA;
const USER: address = @0xB;
const STRANGER: address = @0xC;

/// `MAX_RANK` mirrors the on-chain constant in `prize_pool.move`.
const MAX_RANK: u64 = 100;
/// `BPS` is 10_000 (1.0 in basis points). Mirrors the source.
const BPS: u64 = 10_000;

fun init_prize(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    prize_pool::init_for_testing(ts::ctx(scenario));
}

fun init_streak(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    streak_system::init_for_testing(ts::ctx(scenario));
}

fun create_test_pool(scenario: &mut ts::Scenario, seed_amount: u64): ID {
    ts::next_tx(scenario, ADMIN);
    let seed = coin::mint_for_testing<SUI>(seed_amount, ts::ctx(scenario));
    let pool_id = object::id_from_address(@0x1);
    prize_pool::create_pool<SUI>(seed, 0, ts::ctx(scenario));
    pool_id
}

fun create_user_streak(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, USER);
    let mut registry = ts::take_shared<StreakRegistry>(scenario);
    streak_system::create_streak(&mut registry, ts::ctx(scenario));
    ts::return_shared(registry);
}

fun bogus_sig(): vector<u8> {
    let mut sig = vector[];
    let mut i: u64 = 0;
    while (i < 64) {
        sig.push_back(0u8);
        i = i + 1;
    };
    sig
}

// ============================================================
// create_pool + default distribution
// ============================================================

#[test]
fun default_distribution_sums_to_bps() {
    // Sanity check on the on-chain invariant: `create_pool` is
    // expected to seed a `PrizePool` with `distribution_bps` summing
    // to `BPS` (10_000). A regression here would silently mis-payout
    // every freshly-deployed pool — this test guards the r12 fix.
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    create_test_pool(&mut scenario, 0);
    ts::next_tx(&mut scenario, ADMIN);
    let pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let dist = prize_pool::distribution(&pool);
    let mut sum: u64 = 0;
    let mut i: u64 = 0;
    let len = dist.length();
    while (i < len) {
        sum = sum + dist[i];
        i = i + 1;
    };
    assert!(sum == BPS);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test]
fun fund_pool_increases_balance() {
    // Happy path: a non-zero top-up joins the pool balance and
    // adds to `weekly_prize`. Guards the bug fixed in r11 where
    // zero-amount funds silently no-op'd.
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    create_test_pool(&mut scenario, 0);
    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let topup = coin::mint_for_testing<SUI>(1_000, ts::ctx(&mut scenario));
    prize_pool::fund_pool<SUI>(&mut pool, topup, ts::ctx(&mut scenario));
    assert!(prize_pool::balance_value(&pool) == 1_000);
    assert!(prize_pool::weekly_prize(&pool) == 1_000);
    ts::return_shared(pool);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = prize_pool::EInvalidAmount)]
fun fund_pool_zero_amount_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    create_test_pool(&mut scenario, 0);
    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let zero = coin::mint_for_testing<SUI>(0, ts::ctx(&mut scenario));
    prize_pool::fund_pool<SUI>(&mut pool, zero, ts::ctx(&mut scenario));
    abort 999
}

// ============================================================
// set_distribution
// ============================================================

#[test, expected_failure(abort_code = prize_pool::EInvalidDistribution)]
fun set_distribution_invalid_sum_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    create_test_pool(&mut scenario, 0);
    ts::next_tx(&mut scenario, ADMIN);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    // Sum = 9_999 (one off) — must abort.
    prize_pool::set_distribution<SUI>(
        &mut pool,
        &admin,
        vector[5_000, 3_000, 1_500, 499],
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = prize_pool::ENotAdmin)]
fun set_distribution_not_admin_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    create_test_pool(&mut scenario, 0);
    ts::next_tx(&mut scenario, STRANGER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    prize_pool::set_distribution<SUI>(
        &mut pool,
        &admin,
        vector[BPS, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ts::ctx(&mut scenario),
    );
    abort 999
}

// ============================================================
// claim_prize — abort-only paths
//
// We exercise every abort that doesn't require a real ed25519
// signature. The signature path is covered by an integration
// smoke test in `apps/agents` (off-chain signer + Sui verifier).
// ============================================================

#[test, expected_failure(abort_code = prize_pool::ENotStreakOwner)]
fun claim_prize_not_streak_owner_aborts() {
    // The caller must be the owner of the supplied `UserStreak`.
    // STRANGER claims while USER's streak is passed in — must abort.
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    init_streak(&mut scenario);
    create_test_pool(&mut scenario, 10_000);
    create_user_streak(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    let streak = ts::take_from_address<UserStreak>(&scenario, USER);
    prize_pool::claim_prize<SUI>(
        &mut pool,
        &admin,
        &streak,
        0,
        1,
        1_000,
        bogus_sig(),
        object::id_from_address(@0x1),
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = prize_pool::EInvalidRank)]
fun claim_prize_rank_zero_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    init_streak(&mut scenario);
    create_test_pool(&mut scenario, 10_000);
    create_user_streak(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    let streak = ts::take_from_address<UserStreak>(&scenario, USER);
    prize_pool::claim_prize<SUI>(
        &mut pool,
        &admin,
        &streak,
        0,
        0, // rank = 0
        1_000,
        bogus_sig(),
        object::id_from_address(@0x1),
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = prize_pool::EInvalidRank)]
fun claim_prize_rank_above_max_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    init_streak(&mut scenario);
    create_test_pool(&mut scenario, 10_000);
    create_user_streak(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    let streak = ts::take_from_address<UserStreak>(&scenario, USER);
    prize_pool::claim_prize<SUI>(
        &mut pool,
        &admin,
        &streak,
        0,
        MAX_RANK + 1,
        1_000,
        bogus_sig(),
        object::id_from_address(@0x1),
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = prize_pool::EInvalidAmount)]
fun claim_prize_amount_zero_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    init_streak(&mut scenario);
    create_test_pool(&mut scenario, 10_000);
    create_user_streak(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    let streak = ts::take_from_address<UserStreak>(&scenario, USER);
    prize_pool::claim_prize<SUI>(
        &mut pool,
        &admin,
        &streak,
        0,
        1,
        0, // amount = 0
        bogus_sig(),
        object::id_from_address(@0x1),
        ts::ctx(&mut scenario),
    );
    abort 999
}

#[test, expected_failure(abort_code = prize_pool::EPrizeTooLarge)]
fun claim_prize_amount_too_large_aborts() {
    // Claim > 90% of the pool's balance must abort. With 10_000
    // seeded, requesting 9_001 is just over the 9_000 cap.
    let mut scenario = ts::begin(ADMIN);
    init_prize(&mut scenario);
    init_streak(&mut scenario);
    create_test_pool(&mut scenario, 10_000);
    create_user_streak(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut pool = ts::take_shared<PrizePool<SUI>>(&scenario);
    let admin = ts::take_shared<PrizeAdmin>(&scenario);
    let streak = ts::take_from_address<UserStreak>(&scenario, USER);
    prize_pool::claim_prize<SUI>(
        &mut pool,
        &admin,
        &streak,
        0,
        1,
        9_001, // > 90% of 10_000
        bogus_sig(),
        object::id_from_address(@0x1),
        ts::ctx(&mut scenario),
    );
    abort 999
}
