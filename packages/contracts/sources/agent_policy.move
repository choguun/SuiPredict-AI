/// Agent policy objects for autonomous DeepBook Predict trading.
/// Grants an AI agent a capped budget with on-chain audit logging and owner revocation.
module suipredict_agent_policy::agent_policy;

use sui::clock::Clock;
use sui::event;

// === Errors ===
const ENotOwner: u64 = 0;
const ENotAgent: u64 = 1;
const ERevoked: u64 = 2;
const EPaused: u64 = 3;
const EExpired: u64 = 4;
const EBudgetExceeded: u64 = 5;
const EZeroAmount: u64 = 6;

// === Events ===
public struct PolicyCreated has copy, drop {
    policy_id: ID,
    owner: address,
    agent: address,
    max_budget: u64,
    expires_at: u64,
}

public struct AgentActionEvent has copy, drop {
    policy_id: ID,
    agent: address,
    action: vector<u8>,
    amount: u64,
    spent_total: u64,
    timestamp_ms: u64,
}

public struct PolicyRevoked has copy, drop {
    policy_id: ID,
    owner: address,
}

public struct PolicyPaused has copy, drop {
    policy_id: ID,
    paused: bool,
}

/// Capability object controlling agent spend on DeepBook Predict.
public struct AgentPolicy has key, store {
    id: UID,
    owner: address,
    agent: address,
    max_budget: u64,
    spent: u64,
    expires_at: u64,
    revoked: bool,
    paused: bool,
}

/// Create a new agent policy. Shared so both owner and agent can interact via PTBs.
public fun create_policy(
    agent: address,
    max_budget: u64,
    expires_at: u64,
    ctx: &mut TxContext,
) {
    assert!(max_budget > 0, EZeroAmount);
    let owner = ctx.sender();
    let policy = AgentPolicy {
        id: object::new(ctx),
        owner,
        agent,
        max_budget,
        spent: 0,
        expires_at,
        revoked: false,
        paused: false,
    };
    let policy_id = object::id(&policy);
    event::emit(PolicyCreated {
        policy_id,
        owner,
        agent,
        max_budget,
        expires_at,
    });
    transfer::share_object(policy);
}

/// Agent authorizes spend before executing a Predict transaction.
///
/// MOVE-GAP-18 doc note: `policy.spent += amount` happens *here*,
/// before the agent's downstream PTB call (e.g. DeepBook
/// `place_limit_order`) runs. The on-chain design assumes the
/// authorize-and-spend pair lives in the **same** transaction;
/// the Sui PTB either finalizes both calls atomically (and the
/// debited budget reflects the actual on-chain spend) or aborts
/// the whole PTB (and the budget is restored). A future SDK
/// builder who splits the two calls across transactions would
/// silently lose budget on every failed downstream call. See
/// `packages/sdk/src/predict-client.ts#buildAuthorizeSpendTx` for
/// the matching PTB composition.
public fun authorize_spend(
    policy: &mut AgentPolicy,
    amount: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy.agent, ENotAgent);
    assert!(!policy.revoked, ERevoked);
    assert!(!policy.paused, EPaused);
    assert!(clock.timestamp_ms() <= policy.expires_at, EExpired);
    assert!(amount > 0, EZeroAmount);
    assert!(policy.spent + amount <= policy.max_budget, EBudgetExceeded);

    policy.spent = policy.spent + amount;

    event::emit(AgentActionEvent {
        policy_id: object::id(policy),
        agent: policy.agent,
        action: b"authorize_spend",
        amount,
        spent_total: policy.spent,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Log an agent action without spending budget (e.g. redeem keeper).
public fun log_action(
    policy: &mut AgentPolicy,
    action: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == policy.agent, ENotAgent);
    assert!(!policy.revoked, ERevoked);
    assert!(!policy.paused, EPaused);

    event::emit(AgentActionEvent {
        policy_id: object::id(policy),
        agent: policy.agent,
        action,
        amount: 0,
        spent_total: policy.spent,
        timestamp_ms: clock.timestamp_ms(),
    });
}

/// Owner revokes the policy — agent can no longer act.
public fun revoke(policy: &mut AgentPolicy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    policy.revoked = true;
    event::emit(PolicyRevoked {
        policy_id: object::id(policy),
        owner: policy.owner,
    });
}

/// Owner or agent pauses policy (circuit breaker).
public fun pause(policy: &mut AgentPolicy, ctx: &TxContext) {
    let sender = ctx.sender();
    assert!(sender == policy.owner || sender == policy.agent, ENotOwner);
    policy.paused = true;
    event::emit(PolicyPaused {
        policy_id: object::id(policy),
        paused: true,
    });
}

/// Owner unpauses policy.
public fun unpause(policy: &mut AgentPolicy, ctx: &TxContext) {
    assert!(ctx.sender() == policy.owner, ENotOwner);
    policy.paused = false;
    event::emit(PolicyPaused {
        policy_id: object::id(policy),
        paused: false,
    });
}

// === Read functions ===
public fun owner(policy: &AgentPolicy): address { policy.owner }
public fun agent(policy: &AgentPolicy): address { policy.agent }
public fun max_budget(policy: &AgentPolicy): u64 { policy.max_budget }
public fun spent(policy: &AgentPolicy): u64 { policy.spent }
public fun remaining(policy: &AgentPolicy): u64 { policy.max_budget - policy.spent }
public fun is_revoked(policy: &AgentPolicy): bool { policy.revoked }
public fun is_paused(policy: &AgentPolicy): bool { policy.paused }
public fun expires_at(policy: &AgentPolicy): u64 { policy.expires_at }
