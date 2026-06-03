#[test_only]
module suipredict_agent_policy::streak_system_tests;

use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};
use suipredict_agent_policy::streak_system::{
    Self,
    StreakAdmin,
    StreakRegistry,
    UserStreak,
};

const ADMIN: address = @0xA;
const USER: address = @0xB;

const OUTCOME_NOT_SUBMITTED: u8 = 0;
const OUTCOME_ALL_CORRECT: u8 = 1;
const OUTCOME_SOME_WRONG: u8 = 2;

const DAY_MS: u64 = 86_400_000;

fun setup(): (Scenario, Clock) {
    let mut scenario = ts::begin(ADMIN);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    (scenario, clock)
}

fun init_modules(scenario: &mut Scenario) {
    ts::next_tx(scenario, ADMIN);
    {
        streak_system::init_for_testing(ts::ctx(scenario));
    };
}

fun take_user_streak(scenario: &Scenario): UserStreak {
    ts::take_from_address<UserStreak>(scenario, USER)
}

fun create_user_streak(scenario: &mut Scenario) {
    ts::next_tx(scenario, USER);
    {
        let mut registry = ts::take_shared<StreakRegistry>(scenario);
        streak_system::create_streak(&mut registry, ts::ctx(scenario));
        ts::return_shared(registry);
    };
}

fun advance_days(clock: &mut Clock, days: u64) {
    clock::increment_for_testing(clock, days * DAY_MS);
}

#[test]
fun test_streak_increments_on_all_correct() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let day1 = day0 + 1;
    let day2 = day1 + 1;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);

        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        assert!(streak_system::current_streak(&streak) == 1, 0);

        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    advance_days(&mut clock, 1);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);

        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day1, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        assert!(streak_system::current_streak(&streak) == 2, 1);

        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    advance_days(&mut clock, 1);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);

        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day2, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        assert!(streak_system::current_streak(&streak) == 3, 2);
        assert!(streak_system::longest_streak(&streak) == 3, 3);
        assert!(streak_system::multiplier_tier(&streak) == 1, 4); // bronze at 3d
        assert!(streak_system::get_multiplier_bps(&streak) == 11_000, 5); // 1.1x

        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun test_streak_resets_on_some_wrong() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let day1 = day0 + 1;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    advance_days(&mut clock, 1);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day1, OUTCOME_SOME_WRONG, 1, &clock, ts::ctx(&mut scenario),
        );
        assert!(streak_system::current_streak(&streak) == 0, 0);
        assert!(streak_system::total_participated(&streak) == 2, 1); // counted day0+day1
        assert!(streak_system::total_correct(&streak) == 1, 2); // only day0
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun test_streak_resets_on_not_submitted() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let day1 = day0 + 1;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    advance_days(&mut clock, 1);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day1, OUTCOME_NOT_SUBMITTED, 1, &clock, ts::ctx(&mut scenario),
        );
        assert!(streak_system::current_streak(&streak) == 0, 0);
        assert!(streak_system::total_participated(&streak) == 1, 1); // NOT_SUBMITTED doesn't count
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EAlreadyRecordedToday)]
fun test_replay_protection() {
    let (mut scenario, clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        // Replay the same day_index — must abort.
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EStreakBroken)]
fun test_skipped_day_breaks_streak() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let day2 = day0 + 2; // skip day0+1

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    advance_days(&mut clock, 2);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        // Skipped a day — must abort.
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day2, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::ENotAdmin)]
fun test_non_admin_cannot_record() {
    let (mut scenario, clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;

    ts::next_tx(&mut scenario, USER);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        // USER is not ADMIN — must abort.
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun test_multiplier_tier_thresholds() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;

    // Build up to 7 days to test the silver tier.
    let mut i: u64 = 0;
    while (i < 7) {
        let day = day0 + i;
        advance_days(&mut clock, 1);
        ts::next_tx(&mut scenario, ADMIN);
        {
            let admin = ts::take_shared<StreakAdmin>(&scenario);
            let mut registry = ts::take_shared<StreakRegistry>(&scenario);
            let mut streak = take_user_streak(&scenario);
            streak_system::record_participation(
                &admin, &mut registry, &mut streak, day, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
            );
            assert!(streak_system::current_streak(&streak) == i + 1, (i as u64));
            if (i + 1 < 3) {
                assert!(streak_system::get_multiplier_bps(&streak) == 10_000, 100);
            } else if (i + 1 < 7) {
                assert!(streak_system::get_multiplier_bps(&streak) == 11_000, 101);
            } else {
                assert!(streak_system::get_multiplier_bps(&streak) == 13_000, 102);
            };
            ts::return_shared(admin);
            ts::return_shared(registry);
            ts::return_to_address(USER, streak);
        };
        i = i + 1;
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
fun test_badge_claim_after_longest_streak() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let mut i: u64 = 0;
    while (i < 3) {
        let day = day0 + i;
        advance_days(&mut clock, 1);
        ts::next_tx(&mut scenario, ADMIN);
        {
            let admin = ts::take_shared<StreakAdmin>(&scenario);
            let mut registry = ts::take_shared<StreakRegistry>(&scenario);
            let mut streak = take_user_streak(&scenario);
            streak_system::record_participation(
                &admin, &mut registry, &mut streak, day, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(admin);
            ts::return_shared(registry);
            ts::return_to_address(USER, streak);
        };
        i = i + 1;
    };

    // Now claim the bronze badge (tier 1).
    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = take_user_streak(&scenario);
        assert!(streak_system::can_claim_badge(&streak, 1), 0);
        streak_system::claim_badge(&mut streak, 1, ts::ctx(&mut scenario));
        assert!(!streak_system::can_claim_badge(&streak, 1), 1);
        let earned = streak_system::badges_earned(&streak);
        assert!(vector::length(&earned) == 1, 2);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EBadgeAlreadyClaimed)]
fun test_double_claim_aborts() {
    let (mut scenario, mut clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    let mut i: u64 = 0;
    while (i < 3) {
        let day = day0 + i;
        advance_days(&mut clock, 1);
        ts::next_tx(&mut scenario, ADMIN);
        {
            let admin = ts::take_shared<StreakAdmin>(&scenario);
            let mut registry = ts::take_shared<StreakRegistry>(&scenario);
            let mut streak = take_user_streak(&scenario);
            streak_system::record_participation(
                &admin, &mut registry, &mut streak, day, OUTCOME_ALL_CORRECT, 1, &clock, ts::ctx(&mut scenario),
            );
            ts::return_shared(admin);
            ts::return_shared(registry);
            ts::return_to_address(USER, streak);
        };
        i = i + 1;
    };

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = take_user_streak(&scenario);
        streak_system::claim_badge(&mut streak, 1, ts::ctx(&mut scenario));
        streak_system::claim_badge(&mut streak, 1, ts::ctx(&mut scenario)); // abort
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EStreakExists)]
fun test_cannot_create_two_streaks() {
    let (mut scenario, _clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);
    create_user_streak(&mut scenario); // abort — already exists
    clock::destroy_for_testing(_clock);
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EInvalidOutcome)]
fun test_invalid_outcome_aborts() {
    let (mut scenario, clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        // 99 is not a valid outcome.
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, 99, 1, &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
/// Same-day replay: a second `record_participation` call for the
/// same `day_index` must abort with EAlreadyRecordedToday. This is
/// distinct from EStreakBroken (which fires for a non-consecutive
/// day after at least one recorded day).
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EAlreadyRecordedToday)]
fun test_already_recorded_today_aborts() {
    let (mut scenario, clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    let day0 = clock::timestamp_ms(&clock) / DAY_MS;

    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1,
            &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    // Re-submit the same day — should abort.
    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1,
            &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
/// Calling `claim_badge` with a tier outside 1..=4 must abort with
/// EInvalidTier. The off-chain `badge_nft::mint_badge` re-asserts
/// this via `assert_eligible` so the contract-level test pins the
/// behavior independently.
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EInvalidTier)]
fun test_claim_badge_invalid_tier_aborts() {
    let (mut scenario, clock) = setup();
    init_modules(&mut scenario);
    create_user_streak(&mut scenario);

    // No streak length needed — claim_badge validates tier before
    // checking eligibility.
    let day0 = clock::timestamp_ms(&clock) / DAY_MS;
    ts::next_tx(&mut scenario, ADMIN);
    {
        let admin = ts::take_shared<StreakAdmin>(&scenario);
        let mut registry = ts::take_shared<StreakRegistry>(&scenario);
        let mut streak = take_user_streak(&scenario);
        streak_system::record_participation(
            &admin, &mut registry, &mut streak, day0, OUTCOME_ALL_CORRECT, 1,
            &clock, ts::ctx(&mut scenario),
        );
        ts::return_shared(admin);
        ts::return_shared(registry);
        ts::return_to_address(USER, streak);
    };

    ts::next_tx(&mut scenario, USER);
    {
        let mut streak = take_user_streak(&scenario);
        streak_system::claim_badge(&mut streak, 9, ts::ctx(&mut scenario));
        ts::return_to_address(USER, streak);
    };

    clock::destroy_for_testing(clock);
    ts::end(scenario);
}

#[test]
/// `rotate_admin` rejects `@0x0` so the admin address can never
/// be zeroed out (which would brick the protocol — no one could
/// ever rotate away from it).
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::EInvalidNewAdmin)]
fun test_rotate_admin_to_zero_aborts() {
    let (mut scenario, _clock) = setup();
    init_modules(&mut scenario);

    ts::next_tx(&mut scenario, ADMIN);
    {
        let mut admin = ts::take_shared<StreakAdmin>(&scenario);
        streak_system::rotate_admin(&mut admin, @0x0, ts::ctx(&mut scenario));
        ts::return_shared(admin);
    };

    clock::destroy_for_testing(_clock);
    ts::end(scenario);
}

#[test]
/// `rotate_admin` is admin-only; a non-admin caller must abort
/// with ENotAdmin. This pins the admin-gate independently of the
/// `record_participation` admin check that was already covered by
/// test_non_admin_cannot_record.
#[expected_failure(abort_code = suipredict_agent_policy::streak_system::ENotAdmin)]
fun test_rotate_admin_by_stranger_aborts() {
    let (mut scenario, _clock) = setup();
    init_modules(&mut scenario);

    ts::next_tx(&mut scenario, USER);
    {
        let mut admin = ts::take_shared<StreakAdmin>(&scenario);
        streak_system::rotate_admin(&mut admin, USER, ts::ctx(&mut scenario));
        ts::return_shared(admin);
    };

    clock::destroy_for_testing(_clock);
    ts::end(scenario);
}
