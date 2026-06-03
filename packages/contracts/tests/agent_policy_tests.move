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

#[test]
fun test_pause_unpause() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, AGENT);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        agent_policy::pause(&mut policy, ts::ctx(&mut scenario));
        assert!(agent_policy::is_paused(&policy), 0);
        ts::return_shared(policy);
    };

    ts::next_tx(&mut scenario, OWNER);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        agent_policy::unpause(&mut policy, ts::ctx(&mut scenario));
        assert!(!agent_policy::is_paused(&policy), 1);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
fun test_remaining_budget() {
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
        agent_policy::authorize_spend(&mut policy, 300_000, &clock, ts::ctx(&mut scenario));
        assert!(agent_policy::remaining(&policy) == 700_000, 0);
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::agent_policy::EBudgetExceeded)]
fun test_budget_cap_enforced() {
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
        // First call: 800_000
        agent_policy::authorize_spend(&mut policy, 800_000, &clock, ts::ctx(&mut scenario));
        // Second call: 300_000 — would exceed 1_000_000 cap
        agent_policy::authorize_spend(&mut policy, 300_000, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::agent_policy::EExpired)]
fun test_expired_policy_blocks_spend() {
    let mut scenario = setup();
    let expires = 1_000; // Expired long ago

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, AGENT);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        let mut clock = clock::create_for_testing(ts::ctx(&mut scenario));
        // Advance clock past the expiry
        clock::increment_for_testing(&mut clock, 5_000);
        agent_policy::authorize_spend(&mut policy, 100_000, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = suipredict_agent_policy::agent_policy::EPaused)]
fun test_paused_policy_blocks_spend() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    {
        agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));
    };

    ts::next_tx(&mut scenario, AGENT);
    {
        let mut policy = ts::take_shared<AgentPolicy>(&scenario);
        agent_policy::pause(&mut policy, ts::ctx(&mut scenario));
        let clock = clock::create_for_testing(ts::ctx(&mut scenario));
        agent_policy::authorize_spend(&mut policy, 100_000, &clock, ts::ctx(&mut scenario));
        clock::destroy_for_testing(clock);
        ts::return_shared(policy);
    };

    ts::end(scenario);
}

// ============================================================
// log_action — audit-only event emission
// ============================================================

/// `log_action` lets the agent emit an `AgentActionEvent` without
/// spending budget. Used by the redeem-keeper and other off-chain
/// workers to record activity against the policy. Happy path: the
/// action string is recorded; spent_total mirrors `policy.spent`
/// (which is unchanged); amount is 0.
#[test]
fun log_action_emits_event() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, AGENT);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    agent_policy::log_action(
        &mut policy,
        b"redeem_keeper_ping",
        &clock,
        ts::ctx(&mut scenario),
    );
    // Spent is unchanged because log_action does not consume budget.
    assert!(agent_policy::spent(&policy) == 0, 0);
    assert!(agent_policy::remaining(&policy) == 1_000_000, 0);
    clock::destroy_for_testing(clock);
    ts::return_shared(policy);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = agent_policy::ENotAgent)]
fun log_action_not_agent_aborts() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, OWNER);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    agent_policy::log_action(
        &mut policy,
        b"redeem_keeper_ping",
        &clock,
        ts::ctx(&mut scenario),
    );
    clock::destroy_for_testing(clock);
    ts::return_shared(policy);
    abort 999
}

#[test, expected_failure(abort_code = agent_policy::ERevoked)]
fun log_action_revoked_aborts() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, OWNER);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    agent_policy::revoke(&mut policy, ts::ctx(&mut scenario));
    ts::return_shared(policy);

    // Switch to AGENT (the policy agent) and call log_action —
    // the ENotAgent check passes, but ERevoked trips next.
    ts::next_tx(&mut scenario, AGENT);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    agent_policy::log_action(
        &mut policy,
        b"redeem_keeper_ping",
        &clock,
        ts::ctx(&mut scenario),
    );
    clock::destroy_for_testing(clock);
    ts::return_shared(policy);
    abort 999
}

#[test, expected_failure(abort_code = agent_policy::EPaused)]
fun log_action_paused_aborts() {
    let mut scenario = setup();
    let expires = 999_999_999_999;

    ts::next_tx(&mut scenario, OWNER);
    agent_policy::create_policy(AGENT, 1_000_000, expires, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, OWNER);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    agent_policy::pause(&mut policy, ts::ctx(&mut scenario));
    ts::return_shared(policy);

    ts::next_tx(&mut scenario, AGENT);
    let mut policy = ts::take_shared<AgentPolicy>(&scenario);
    let clock = clock::create_for_testing(ts::ctx(&mut scenario));
    agent_policy::log_action(
        &mut policy,
        b"redeem_keeper_ping",
        &clock,
        ts::ctx(&mut scenario),
    );
    clock::destroy_for_testing(clock);
    ts::return_shared(policy);
    abort 999
}
