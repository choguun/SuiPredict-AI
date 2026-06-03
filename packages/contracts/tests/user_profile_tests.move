#[test_only]
module suipredict_agent_policy::user_profile_tests;

use sui::test_scenario::{Self as ts, Scenario};
use suipredict_agent_policy::user_profile::{
    Self,
    ProfileRegistry,
    UserProfile,
};

const ADMIN: address = @0xA;
const USER: address = @0xB;
const OTHER: address = @0xC;

fun init_modules(scenario: &mut Scenario) {
    ts::next_tx(scenario, ADMIN);
    {
        user_profile::init_for_testing(ts::ctx(scenario));
    };
}

fun create_for(scenario: &mut Scenario, who: address) {
    ts::next_tx(scenario, who);
    {
        let mut registry = ts::take_shared<ProfileRegistry>(scenario);
        user_profile::create_profile(&mut registry, ts::ctx(scenario));
        ts::return_shared(registry);
    };
}

#[test]
fun test_create_profile_emits_and_sets_default_kind() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, USER);
    {
        let profile = ts::take_from_address<UserProfile>(&scenario, USER);
        assert!(user_profile::owner(&profile) == USER, 0);
        assert!(user_profile::forecaster_kind(&profile) == 0, 1);
        assert!(std::vector::is_empty(user_profile::country_code(&profile)), 2);
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::user_profile::EProfileExists)]
fun test_create_profile_twice_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);
    create_for(&mut scenario, USER); // second call aborts
    ts::end(scenario);
}

#[test]
fun test_set_country_code_and_kind() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, USER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_country_code(&mut profile, b"us", ts::ctx(&mut scenario));
        user_profile::set_forecaster_kind(&mut profile, 1, ts::ctx(&mut scenario));
        assert!(user_profile::country_code(&profile) == &b"us", 0);
        assert!(user_profile::forecaster_kind(&profile) == 1, 1);
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::user_profile::ENotOwner)]
fun test_set_country_by_non_owner_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, OTHER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_country_code(&mut profile, b"us", ts::ctx(&mut scenario));
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::user_profile::EInvalidCountry)]
fun test_country_code_too_long_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, USER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_country_code(
            &mut profile,
            b"this_is_way_too_long_for_iso3166",
            ts::ctx(&mut scenario),
        );
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::user_profile::EInvalidForecasterKind)]
fun test_invalid_forecaster_kind_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, USER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_forecaster_kind(&mut profile, 7, ts::ctx(&mut scenario));
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
fun test_set_country_then_clear() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, USER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_country_code(&mut profile, b"th", ts::ctx(&mut scenario));
        assert!(user_profile::country_code(&profile) == &b"th", 0);
        user_profile::set_country_code(&mut profile, vector[], ts::ctx(&mut scenario));
        assert!(std::vector::is_empty(user_profile::country_code(&profile)), 1);
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
/// Symmetric to test_set_country_by_non_owner_aborts: a non-owner
/// calling `set_forecaster_kind` must abort with ENotOwner. This
/// pins the admin-gate on the second mutator and gives a regression
/// signal if the gate ever drifts.
#[expected_failure(abort_code = suipredict_agent_policy::user_profile::ENotOwner)]
fun test_set_forecaster_kind_by_non_owner_aborts() {
    let mut scenario = ts::begin(ADMIN);
    init_modules(&mut scenario);
    create_for(&mut scenario, USER);

    ts::next_tx(&mut scenario, OTHER);
    {
        let mut profile = ts::take_from_address<UserProfile>(&scenario, USER);
        user_profile::set_forecaster_kind(&mut profile, 2, ts::ctx(&mut scenario));
        ts::return_to_address(USER, profile);
    };

    ts::end(scenario);
}

#[test]
/// `init_for_testing` creates the shared `ProfileRegistry` so the
/// agent can call `profile_id_for` against it. This test pins the
/// bootstrap shape: a fresh init produces a registry with an empty
/// `profiles` table, ready for `create_profile` to populate.
fun test_profile_init_creates_registry() {
    let mut scenario = ts::begin(ADMIN);
    ts::next_tx(&mut scenario, ADMIN);
    {
        user_profile::init_for_testing(ts::ctx(&mut scenario));
    };
    ts::next_tx(&mut scenario, ADMIN);
    {
        let registry = ts::take_shared<ProfileRegistry>(&scenario);
        // No user has a profile yet.
        assert!(user_profile::profile_id_for(&registry, USER).is_none(), 0);
        assert!(user_profile::profile_id_for(&registry, ADMIN).is_none(), 1);
        ts::return_shared(registry);
    };
    ts::end(scenario);
}
