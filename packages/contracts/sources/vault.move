/// User vault for DBUSDC deposits — funds agent market making.
module suipredict_agent_policy::vault;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin, TreasuryCap};
use sui::event;
use suipredict_agent_policy::vlp::{Self, VLP};

public struct ProtocolVault<phantom QuoteCoin> has key {
    id: UID,
    admin: address,
    balance: Balance<QuoteCoin>,
    allocated: u64,
    treasury: TreasuryCap<VLP>,
}

public struct VaultCreated has copy, drop {
    vault_id: ID,
    admin: address,
}

public struct Deposited has copy, drop {
    vault_id: ID,
    user: address,
    amount: u64,
    vlp_minted: u64,
}

public struct Withdrawn has copy, drop {
    vault_id: ID,
    user: address,
    amount: u64,
    vlp_burned: u64,
}

public struct Allocated has copy, drop {
    vault_id: ID,
    amount: u64,
    total_allocated: u64,
}

public struct Deallocated has copy, drop {
    vault_id: ID,
    amount: u64,
    total_allocated: u64,
}

const ENotAdmin: u64 = 0;
const EZeroAmount: u64 = 1;
// MOVE-GAP-04 fix: was `const EInsufficientAvailable: u64 = 3;`
// (skipping 2). The other 9 modules use sequential numbering
// 0..N; the E2 gap was either an intentional reservation for a
// since-removed code or an oversight. Renumbered to 2 so a
// future contributor can't accidentally alias an unrelated
// error path or collide with a refactor that re-introduces a
// third error.
const EInsufficientAvailable: u64 = 2;

public fun create_vault<QuoteCoin>(
    treasury: TreasuryCap<VLP>,
    ctx: &mut TxContext,
) {
    let admin = ctx.sender();
    let vault = ProtocolVault<QuoteCoin> {
        id: object::new(ctx),
        admin,
        balance: balance::zero(),
        allocated: 0,
        treasury,
    };
    let vault_id = object::id(&vault);
    event::emit(VaultCreated { vault_id, admin });
    transfer::share_object(vault);
}

public fun deposit<QuoteCoin>(
    vault: &mut ProtocolVault<QuoteCoin>,
    coin: Coin<QuoteCoin>,
    ctx: &mut TxContext,
): Coin<VLP> {
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroAmount);
    balance::join(&mut vault.balance, coin::into_balance(coin));
    let vlp_amount = amount;
    let vlp = coin::mint(&mut vault.treasury, vlp_amount, ctx);
    event::emit(Deposited {
        vault_id: object::id(vault),
        user: ctx.sender(),
        amount,
        vlp_minted: vlp_amount,
    });
    vlp
}

public fun withdraw<QuoteCoin>(
    vault: &mut ProtocolVault<QuoteCoin>,
    vlp: Coin<VLP>,
    ctx: &mut TxContext,
): Coin<QuoteCoin> {
    let vlp_amount = coin::value(&vlp);
    assert!(vlp_amount > 0, EZeroAmount);
    let available = available_balance(vault);
    assert!(available >= vlp_amount, EInsufficientAvailable);
    coin::burn(&mut vault.treasury, vlp);
    let out = balance::split(&mut vault.balance, vlp_amount);
    event::emit(Withdrawn {
        vault_id: object::id(vault),
        user: ctx.sender(),
        amount: vlp_amount,
        vlp_burned: vlp_amount,
    });
    coin::from_balance(out, ctx)
}

public fun allocate_for_mm<QuoteCoin>(
    vault: &mut ProtocolVault<QuoteCoin>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<QuoteCoin> {
    assert!(ctx.sender() == vault.admin, ENotAdmin);
    assert!(amount > 0, EZeroAmount);
    let available = available_balance(vault);
    assert!(available >= amount, EInsufficientAvailable);
    vault.allocated = vault.allocated + amount;
    event::emit(Allocated {
        vault_id: object::id(vault),
        amount,
        total_allocated: vault.allocated,
    });
    coin::from_balance(balance::split(&mut vault.balance, amount), ctx)
}

public fun return_from_mm<QuoteCoin>(
    vault: &mut ProtocolVault<QuoteCoin>,
    coin: Coin<QuoteCoin>,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == vault.admin, ENotAdmin);
    let amount = coin::value(&coin);
    assert!(amount > 0, EZeroAmount);
    assert!(vault.allocated >= amount, EInsufficientAvailable);
    vault.allocated = vault.allocated - amount;
    balance::join(&mut vault.balance, coin::into_balance(coin));
    event::emit(Deallocated {
        vault_id: object::id(vault),
        amount,
        total_allocated: vault.allocated,
    });
}

public fun total_balance<QuoteCoin>(vault: &ProtocolVault<QuoteCoin>): u64 {
    balance::value(&vault.balance) + vault.allocated
}

public fun available_balance<QuoteCoin>(vault: &ProtocolVault<QuoteCoin>): u64 {
    balance::value(&vault.balance)
}

public fun allocated<QuoteCoin>(vault: &ProtocolVault<QuoteCoin>): u64 {
    vault.allocated
}

public fun admin<QuoteCoin>(vault: &ProtocolVault<QuoteCoin>): address {
    vault.admin
}
