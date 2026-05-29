#[test_only]
module suipredict_agent_policy::agent_policy_tests;

use sui::test_scenario::{Self as ts, Scenario};
use sui::clock::{Self, Clock};
use suipredict_agent_policy::agent_policy::{Self, AgentPolicy};

const OWNER: address = @0xA;
const AGENT: address = @0xB;

fun setup(): Scenario {
    let mut scenario = ts::begin(OWNER);
    scenario
}

#[test]
fun test_create_and_authorize_spend() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, AGENT);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_policy::authorize_spend(&mut policy, 500_000, &clock, ts::ctx(&mut scenario));
        assert!(agent_policy::spent(&policy) == 500_000, 0);
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::agent_policy::ENotAgent)]
fun test_non_agent_cannot_spend() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, OWNER);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_policy::authorize_spend(&mut policy, 100_000, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
fun test_owner_revokes() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, OWNER);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        agent_policy::revoke(&mut policy, ts::ctx(&mut scenario));
        assert!(agent_policy::is_revoked(&policy), 0);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}
