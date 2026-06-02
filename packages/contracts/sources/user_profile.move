/// Per-user profile metadata used by the national leaderboard and the
/// AI-forecaster category leaderboard (PRD §4.3).
///
/// The `UserProfile` is owned by the user (transferable to the user only
/// at creation time). A shared `ProfileRegistry` maps `address → ID` so
/// the off-chain indexer can find a user's profile without walking the
/// address space.
///
/// Two pieces of mutable metadata:
///   - `country_code` — ISO-3166-1 alpha-2, lowercased (e.g. "us", "th").
///     Empty vector means "not set".
///   - `forecaster_kind` — 0 = human (default), 1 = ai-assisted, 2 = bot.
///     Used by the leaderboard worker to split the AI-forecaster ranking
///     from the human ranking.
///
/// The country_code is opt-in: a user with no profile is excluded from
/// the national leaderboard but still appears on the global one.
#[allow(unused_const)]
module suipredict_agent_policy::user_profile;

use std::option::{Self, Option};
use std::vector;
use sui::event;
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;

// ============================================================
// Constants
// ============================================================

/// Max bytes for an ISO-3166-1 alpha-2 country code (always 2; cap at 8
/// to allow for future extensions like alpha-3 or BCP-47 locale tags).
const MAX_COUNTRY_BYTES: u64 = 8;

const FORECASTER_HUMAN: u8 = 0;
const FORECASTER_AI: u8 = 1;
const FORECASTER_BOT: u8 = 2;

// ============================================================
// Error codes
// ============================================================

const EProfileExists: u64 = 0;
const ENotOwner: u64 = 1;
const EInvalidCountry: u64 = 2;
const EInvalidForecasterKind: u64 = 3;

// ============================================================
// Shared registry
// ============================================================

/// Shared object mapping a user's address → their `UserProfile` ID.
/// Allows the indexer to look up a profile without a full table scan.
public struct ProfileRegistry has key {
    id: UID,
    profiles: Table<address, ID>,
}

// ============================================================
// Per-user profile object
// ============================================================

/// Owned by the user. Mutated only by the owner.
public struct UserProfile has key {
    id: UID,
    owner: address,
    /// ISO-3166-1 alpha-2, lowercased. Empty = unset.
    country_code: vector<u8>,
    /// 0 = human, 1 = ai-assisted, 2 = bot.
    forecaster_kind: u8,
    created_at_ms: u64,
}

// ============================================================
// Events
// ============================================================

public struct ProfileCreated has copy, drop {
    user: address,
    profile_id: ID,
}

public struct CountryCodeSet has copy, drop {
    user: address,
    country_code: vector<u8>,
}

public struct ForecasterKindSet has copy, drop {
    user: address,
    forecaster_kind: u8,
}

// ============================================================
// Init
// ============================================================

fun init(ctx: &mut TxContext) {
    let registry = ProfileRegistry {
        id: object::new(ctx),
        profiles: table::new(ctx),
    };
    transfer::share_object(registry);
}

// ============================================================
// Creation
// ============================================================

/// Self-register a `UserProfile` for the sender. Idempotent — aborts if
/// the sender already has a profile in the registry. The profile is
/// transferred to the sender so they can mutate it without sharing.
public fun create_profile(
    registry: &mut ProfileRegistry,
    ctx: &mut TxContext,
) {
    let owner = ctx.sender();
    assert!(!table::contains(&registry.profiles, owner), EProfileExists);

    let profile = UserProfile {
        id: object::new(ctx),
        owner,
        country_code: vector[],
        forecaster_kind: FORECASTER_HUMAN,
        created_at_ms: ctx.epoch_timestamp_ms(),
    };
    let profile_id = object::id(&profile);
    table::add(&mut registry.profiles, owner, profile_id);

    event::emit(ProfileCreated { user: owner, profile_id });
    transfer::transfer(profile, owner);
}

// ============================================================
// Mutation (owner-gated)
// ============================================================

/// Set or replace the country code. Validation:
///   - sender must equal `profile.owner`
///   - byte length must be 0..=MAX_COUNTRY_BYTES
///   - empty vector clears the country (so the user can opt out)
///   - non-empty values are lowercased by the caller (no normalisation
///     in Move — keeps the module dep-free).
public fun set_country_code(
    profile: &mut UserProfile,
    country_code: vector<u8>,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == profile.owner, ENotOwner);
    assert!(
        vector::length(&country_code) <= MAX_COUNTRY_BYTES,
        EInvalidCountry,
    );
    profile.country_code = country_code;
    event::emit(CountryCodeSet { user: profile.owner, country_code: profile.country_code });
}

/// Switch the forecaster kind. 0 = human, 1 = ai-assisted, 2 = bot.
/// Users can self-declare honestly; the leaderboard worker uses this
/// only to split the AI-forecaster category. Lying just moves the user
/// to a different leaderboard, not a different payout tier.
public fun set_forecaster_kind(
    profile: &mut UserProfile,
    kind: u8,
    ctx: &TxContext,
) {
    assert!(ctx.sender() == profile.owner, ENotOwner);
    assert!(
        kind == FORECASTER_HUMAN || kind == FORECASTER_AI || kind == FORECASTER_BOT,
        EInvalidForecasterKind,
    );
    profile.forecaster_kind = kind;
    event::emit(ForecasterKindSet { user: profile.owner, forecaster_kind: kind });
}

// ============================================================
// Reads
// ============================================================

public fun owner(profile: &UserProfile): address { profile.owner }
public fun country_code(profile: &UserProfile): &vector<u8> { &profile.country_code }
public fun forecaster_kind(profile: &UserProfile): u8 { profile.forecaster_kind }
public fun created_at_ms(profile: &UserProfile): u64 { profile.created_at_ms }

public fun profile_id_for(registry: &ProfileRegistry, user: address): Option<ID> {
    if (table::contains(&registry.profiles, user)) {
        option::some(*table::borrow(&registry.profiles, user))
    } else {
        option::none()
    }
}

// ============================================================
// Test helpers
// ============================================================

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}

#[test_only]
public fun destroy_registry_for_testing(registry: ProfileRegistry) {
    let ProfileRegistry { id, profiles } = registry;
    table::destroy_empty(profiles);
    object::delete(id);
}

#[test_only]
public fun destroy_profile_for_testing(profile: UserProfile) {
    let UserProfile { id, owner: _, country_code: _, forecaster_kind: _, created_at_ms: _ } = profile;
    object::delete(id);
}
