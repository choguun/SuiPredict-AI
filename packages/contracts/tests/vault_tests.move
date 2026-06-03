#[test_only]
module suipredict_agent_policy::vault_tests;

use sui::coin;
use sui::sui::SUI;
use sui::test_scenario as ts;
use suipredict_agent_policy::vault::{
    Self,
    ProtocolVault,
};
use suipredict_agent_policy::vlp::VLP;

const ADMIN: address = @0xA;
const USER: address = @0xB;
const STRANGER: address = @0xC;

/// Create a fresh `ProtocolVault<SUI>` and share it for the test.
/// The TreasuryCap is sourced from `coin::create_treasury_cap_for_testing`
/// (the vlp module's real `init` would transfer the cap to the
/// deployer; this test helper bypasses that path).
fun fresh_vault(scenario: &mut ts::Scenario) {
    ts::next_tx(scenario, ADMIN);
    let cap = coin::create_treasury_cap_for_testing<VLP>(ts::ctx(scenario));
    vault::create_vault<SUI>(cap, ts::ctx(scenario));
}

// ============================================================
// create_vault
// ============================================================

#[test]
fun create_vault_initializes_state() {
    let mut scenario = ts::begin(ADMIN);
    let cap = coin::create_treasury_cap_for_testing<VLP>(ts::ctx(&mut scenario));
    vault::create_vault<SUI>(cap, ts::ctx(&mut scenario));
    ts::next_tx(&mut scenario, ADMIN);
    let vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    assert!(vault::admin(&vault) == ADMIN, 0);
    assert!(vault::total_balance(&vault) == 0, 0);
    assert!(vault::available_balance(&vault) == 0, 0);
    assert!(vault::allocated(&vault) == 0, 0);
    ts::return_shared(vault);
    ts::end(scenario);
}

// ============================================================
// deposit
// ============================================================

#[test, expected_failure(abort_code = vault::EZeroAmount)]
fun deposit_zero_amount_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let zero = coin::mint_for_testing<SUI>(0, ts::ctx(&mut scenario));
    let vlp = vault::deposit<SUI>(&mut vault, zero, ts::ctx(&mut scenario));
    coin::burn_for_testing(vlp);
    ts::return_shared(vault);
    abort 999
}

#[test]
fun deposit_credits_balance_and_mints_vlp() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let amount: u64 = 1_000_000;
    let coin_in = coin::mint_for_testing<SUI>(amount, ts::ctx(&mut scenario));
    let vlp = vault::deposit<SUI>(&mut vault, coin_in, ts::ctx(&mut scenario));
    assert!(coin::value(&vlp) == amount, 0);
    assert!(vault::total_balance(&vault) == amount, 0);
    assert!(vault::available_balance(&vault) == amount, 0);
    assert!(vault::allocated(&vault) == 0, 0);
    coin::burn_for_testing(vlp);
    ts::return_shared(vault);
    ts::end(scenario);
}

// ============================================================
// withdraw
// ============================================================

#[test, expected_failure(abort_code = vault::EZeroAmount)]
fun withdraw_zero_vlp_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let zero = coin::mint_for_testing<VLP>(0, ts::ctx(&mut scenario));
    let out = vault::withdraw<SUI>(&mut vault, zero, ts::ctx(&mut scenario));
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    abort 999
}

#[test, expected_failure(abort_code = vault::EInsufficientAvailable)]
fun withdraw_more_than_available_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    // Fresh vault has 0 available balance. Withdrawing 200 must abort.
    let vlp_200 = coin::mint_for_testing<VLP>(200, ts::ctx(&mut scenario));
    let out = vault::withdraw<SUI>(&mut vault, vlp_200, ts::ctx(&mut scenario));
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    abort 999
}

#[test]
fun withdraw_debits_balance_and_burns_vlp() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let amount: u64 = 1_000_000;
    let coin_in = coin::mint_for_testing<SUI>(amount, ts::ctx(&mut scenario));
    let mut vlp = vault::deposit<SUI>(&mut vault, coin_in, ts::ctx(&mut scenario));
    let half: u64 = 500_000;
    let half_vlp = coin::split(&mut vlp, half, ts::ctx(&mut scenario));
    let out = vault::withdraw<SUI>(&mut vault, half_vlp, ts::ctx(&mut scenario));
    assert!(coin::value(&out) == half, 0);
    // After withdraw, total balance (balance + allocated) drops by half.
    assert!(vault::total_balance(&vault) == amount - half, 0);
    assert!(vault::available_balance(&vault) == amount - half, 0);
    coin::burn_for_testing(out);
    coin::burn_for_testing(vlp);
    ts::return_shared(vault);
    ts::end(scenario);
}

// ============================================================
// allocate_for_mm / return_from_mm
// ============================================================

#[test, expected_failure(abort_code = vault::ENotAdmin)]
fun allocate_for_mm_not_admin_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let coin_in = coin::mint_for_testing<SUI>(1_000, ts::ctx(&mut scenario));
    let vlp = vault::deposit<SUI>(&mut vault, coin_in, ts::ctx(&mut scenario));
    coin::burn_for_testing(vlp);
    let out = vault::allocate_for_mm<SUI>(&mut vault, 100, ts::ctx(&mut scenario));
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    abort 999
}

#[test, expected_failure(abort_code = vault::EZeroAmount)]
fun allocate_for_mm_zero_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let out = vault::allocate_for_mm<SUI>(&mut vault, 0, ts::ctx(&mut scenario));
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    abort 999
}

#[test, expected_failure(abort_code = vault::EInsufficientAvailable)]
fun allocate_for_mm_overdraw_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let out = vault::allocate_for_mm<SUI>(&mut vault, 100, ts::ctx(&mut scenario));
    coin::burn_for_testing(out);
    ts::return_shared(vault);
    abort 999
}

#[test]
fun allocate_and_return_updates_allocated() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, USER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    // Seed the vault with 1_000 from USER.
    let seed = coin::mint_for_testing<SUI>(1_000, ts::ctx(&mut scenario));
    let vlp = vault::deposit<SUI>(&mut vault, seed, ts::ctx(&mut scenario));
    coin::burn_for_testing(vlp);
    ts::return_shared(vault);
    // ADMIN allocates 400 for market making.
    ts::next_tx(&mut scenario, ADMIN);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let mm_coin = vault::allocate_for_mm<SUI>(&mut vault, 400, ts::ctx(&mut scenario));
    assert!(coin::value(&mm_coin) == 400, 0);
    assert!(vault::allocated(&vault) == 400, 0);
    assert!(vault::available_balance(&vault) == 600, 0);
    assert!(vault::total_balance(&vault) == 1_000, 0);
    // Return 150 of it.
    let back = coin::mint_for_testing<SUI>(150, ts::ctx(&mut scenario));
    vault::return_from_mm<SUI>(&mut vault, back, ts::ctx(&mut scenario));
    assert!(vault::allocated(&vault) == 250, 0);
    assert!(vault::available_balance(&vault) == 750, 0);
    assert!(vault::total_balance(&vault) == 1_000, 0);
    coin::burn_for_testing(mm_coin);
    ts::return_shared(vault);
    ts::end(scenario);
}

#[test, expected_failure(abort_code = vault::EInsufficientAvailable)]
fun return_more_than_allocated_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, ADMIN);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    // Nothing is allocated. Returning 1 must abort.
    let back = coin::mint_for_testing<SUI>(1, ts::ctx(&mut scenario));
    vault::return_from_mm<SUI>(&mut vault, back, ts::ctx(&mut scenario));
    ts::return_shared(vault);
    abort 999
}

#[test, expected_failure(abort_code = vault::ENotAdmin)]
fun return_from_mm_not_admin_aborts() {
    let mut scenario = ts::begin(ADMIN);
    fresh_vault(&mut scenario);
    ts::next_tx(&mut scenario, STRANGER);
    let mut vault = ts::take_shared<ProtocolVault<SUI>>(&scenario);
    let back = coin::mint_for_testing<SUI>(1, ts::ctx(&mut scenario));
    vault::return_from_mm<SUI>(&mut vault, back, ts::ctx(&mut scenario));
    ts::return_shared(vault);
    abort 999
}
