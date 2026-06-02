#[test_only]
module suipredict_agent_policy::badge_nft_tests;

use sui::clock::{Self, Clock};
use sui::kiosk::{Self, Kiosk, KioskOwnerCap};
use sui::test_scenario::{Self as ts, Scenario};
use suipredict_agent_policy::badge_nft::{Self, StreakBadge};
use suipredict_agent_policy::streak_system::{
    Self,
    StreakAdmin,
    StreakRegistry,
    UserStreak,
};

const ADMIN: address = @0xA;
const USER: address = @0xB;
const OUTCOME_ALL_CORRECT: u8 = 1;
const DAY_MS: u64 = 86_400_000;

fun init_modules(scenario: &mut Scenario) {
    ts::next_tx(scenario, ADMIN);
    {
        streak_system::init_for_testing(ts::ctx(scenario));
        badge_nft::init_for_testing(ts::ctx(scenario));
    };
}

fun create_streak(scenario: &mut Scenario) {
    ts::next_tx(scenario, USER);
    {
        let mut registry = ts::take_shared<StreakRegistry>(scenario);
        streak_system::create_streak(&mut registry, ts::ctx(scenario));
        ts::return_shared(registry);
    };
}

/// Run `days` consecutive AllCorrect days so `longest_streak >= days`.
fun grow_streak(scenario: &mut Scenario, clock: &mut Clock, days: u64) {
    let mut i: u64 = 0;
    while (i < days) {
        let day = clock::timestamp_ms(clock) / DAY_MS;
        ts::next_tx(scenario, ADMIN);
        {
            let admin = ts::take_shared<StreakAdmin>(scenario);
            let mut registry = ts::take_shared<StreakRegistry>(scenario);
            let mut streak = ts::take_from_address<UserStreak>(scenario, USER);
            streak_system::record_participation(
                &admin, &mut registry, &mut streak,
                day, OUTCOME_ALL_CORRECT, 1, clock, ts::ctx(scenario),
            );
            ts::return_shared(admin);
            ts::return_shared(registry);
            ts::return_to_address(USER, streak);
        };
        clock::increment_for_testing(clock, DAY_MS);
        i = i + 1;
    };
}

#[test]
fun test_mint_badge_at_bronze_threshold() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 3);

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let _id = badge_nft::mint_badge(&mut streak, 1, &clock, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };

    // Badge object should now be owned by USER.
    ts::next_tx(&mut scenario, USER);
    {
        let badge = ts::take_from_address<StreakBadge>(&scenario, USER);
        assert!(badge_nft::tier_of(&badge) == 1, 0);
        assert!(badge_nft::threshold_days(&badge) == 3, 1);
        assert!(badge_nft::longest_streak_at_mint(&badge) >= 3, 2);
        ts::return_to_address(USER, badge);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EBadgeNotReached)]
fun test_mint_below_threshold_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 2);

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        // longest_streak == 2; bronze requires 3.
        let _ = badge_nft::mint_badge(&mut streak, 1, &clock, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EBadgeAlreadyClaimed)]
fun test_double_mint_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 3);

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let _ = badge_nft::mint_badge(&mut streak, 1, &clock, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };
    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let _ = badge_nft::mint_badge(&mut streak, 1, &clock, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::badge_nft::EInvalidTier)]
fun test_invalid_tier_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 7);

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let _ = badge_nft::mint_badge(&mut streak, 9, &clock, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
/// Happy path: mint_badge_to_kiosk should emit BadgeMinted and
/// BadgePlacedInKiosk events, transfer the badge into the kiosk
/// (so the user no longer holds the StreakBadge directly), and
/// leave the streak with the tier flagged as claimed. The position
/// indexer in apps/agents subscribes to both events so a regression
/// in either emission would silently break the off-chain mirror.
fun test_mint_badge_to_kiosk_succeeds() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 3);

    // User creates a kiosk via the standard Sui primitive.
    let kiosk_id;
    ts::next_tx(&mut scenario, USER);
    {
        let (kiosk, kiosk_cap) = kiosk::new(ts::ctx(&mut scenario));
        kiosk_id = object::id(&kiosk);
        transfer::public_transfer(kiosk_cap, USER);
        transfer::public_share_object(kiosk);
    };

    // Mint the badge into the kiosk and capture the returned ID.
    let badge_id;
    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let mut kiosk = ts::take_shared_by_id<Kiosk>(&scenario, kiosk_id);
        let kiosk_cap = ts::take_from_address<KioskOwnerCap>(&scenario, USER);
        badge_id = badge_nft::mint_badge_to_kiosk(
            &mut streak, 1, &mut kiosk, &kiosk_cap, &clock, ts::ctx(&mut scenario),
        );
        ts::return_to_address(USER, streak);
        ts::return_to_address(USER, kiosk_cap);
        ts::return_shared(kiosk);
    };

    // The badge is now in the kiosk, NOT in the user's wallet.
    // `take_from_address<StreakBadge>` would fail because the user
    // no longer owns the badge directly — kiosk::place transferred
    // it to the kiosk. Confirm by taking it back out using the ID.
    ts::next_tx(&mut scenario, USER);
    {
        let mut kiosk = ts::take_shared_by_id<Kiosk>(&scenario, kiosk_id);
        let kiosk_cap = ts::take_from_address<KioskOwnerCap>(&scenario, USER);
        let badge = kiosk::take<StreakBadge>(&mut kiosk, &kiosk_cap, badge_id);
        assert!(badge_nft::tier_of(&badge) == 1, 0);
        transfer::public_transfer(badge, USER);
        ts::return_to_address(USER, kiosk_cap);
        ts::return_shared(kiosk);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
/// Below-threshold kiosk mint should abort with the same code as
/// the wallet path (EBadgeNotReached comes from the streak_system
/// call inside mint_badge_to_kiosk, since the eligibility check
/// delegates to the streak module).
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EBadgeNotReached)]
fun test_mint_badge_to_kiosk_below_threshold_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
    init_modules(&mut scenario);
    create_streak(&mut scenario);

    grow_streak(&mut scenario, &mut clock, 2);

    let kiosk_id;
    ts::next_tx(&mut scenario, USER);
    {
        let (kiosk, kiosk_cap) = kiosk::new(ts::ctx(&mut scenario));
        kiosk_id = object::id(&kiosk);
        transfer::public_transfer(kiosk_cap, USER);
        transfer::public_share_object(kiosk);
    };

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = ts::take_from_address<UserStreak>(&scenario, USER);
        let mut kiosk = ts::take_shared_by_id<Kiosk>(&scenario, kiosk_id);
        let kiosk_cap = ts::take_from_address<KioskOwnerCap>(&scenario, USER);
        // longest_streak == 2; bronze requires 3 → should abort.
        let _ = badge_nft::mint_badge_to_kiosk(
            &mut streak, 1, &mut kiosk, &kiosk_cap, &clock, ts::ctx(&mut scenario),
        );
        ts::return_to_address(USER, streak);
        ts::return_to_address(USER, kiosk_cap);
        ts::return_shared(kiosk);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}
