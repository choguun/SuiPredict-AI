/// Shared types for SuiPredict prediction markets.
module suipredict_agent_policy::types;

public fun active(): u8 { 0 }
public fun resolved(): u8 { 1 }
public fun cancelled(): u8 { 2 }

public fun unset(): u8 { 0 }
public fun yes_wins(): u8 { 1 }
public fun no_wins(): u8 { 2 }

const RESOLUTION_PYTH: u8 = 0;
const RESOLUTION_SUPRA: u8 = 1;
const RESOLUTION_ADMIN_MULTISIG: u8 = 2;

/// Describes how a market resolves.
/// `kind` 0 = Pyth, 1 = Supra, 2 = Admin multisig.
/// `feed_id` is the oracle feed identifier (32-byte hex for Pyth/Supra).
/// `oracle_addresses` is the set of multisig signers (kind=2 only).
public struct ResolutionSource has copy, drop, store {
    kind: u8,
    feed_id: vector<u8>,
    oracle_addresses: vector<address>,
    threshold: u8,
}

public fun new_pyth_source(feed_id: vector<u8>): ResolutionSource {
    ResolutionSource { kind: RESOLUTION_PYTH, feed_id, oracle_addresses: vector[], threshold: 0 }
}

public fun new_supra_source(feed_id: vector<u8>): ResolutionSource {
    ResolutionSource { kind: RESOLUTION_SUPRA, feed_id, oracle_addresses: vector[], threshold: 0 }
}

public fun new_admin_multisig_source(
    signers: vector<address>,
    threshold: u8,
): ResolutionSource {
    ResolutionSource {
        kind: RESOLUTION_ADMIN_MULTISIG,
        feed_id: vector[],
        oracle_addresses: signers,
        threshold,
    }
}

public fun resolution_kind(src: &ResolutionSource): u8 { src.kind }
public fun resolution_feed_id(src: &ResolutionSource): &vector<u8> { &src.feed_id }
public fun resolution_oracle_addresses(src: &ResolutionSource): &vector<address> { &src.oracle_addresses }
public fun resolution_threshold(src: &ResolutionSource): u8 { src.threshold }

public struct UserPosition has store {
    yes: u64,
    no: u64,
}

public fun new_position(): UserPosition {
    UserPosition { yes: 0, no: 0 }
}

public fun yes_balance(pos: &UserPosition): u64 { pos.yes }
public fun no_balance(pos: &UserPosition): u64 { pos.no }

public fun add_yes(pos: &mut UserPosition, amount: u64) {
    pos.yes = pos.yes + amount;
}

public fun add_no(pos: &mut UserPosition, amount: u64) {
    pos.no = pos.no + amount;
}

public fun sub_yes(pos: &mut UserPosition, amount: u64) {
    pos.yes = pos.yes - amount;
}

public fun sub_no(pos: &mut UserPosition, amount: u64) {
    pos.no = pos.no - amount;
}

public fun clear_yes(pos: &mut UserPosition) { pos.yes = 0; }
public fun clear_no(pos: &mut UserPosition) { pos.no = 0; }

public struct Order has store, copy, drop {
    id: u64,
    owner: address,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
    filled: u64,
    timestamp_ms: u64,
}

public fun new_order(
    id: u64,
    owner: address,
    is_bid: bool,
    price_bps: u64,
    quantity: u64,
    timestamp_ms: u64,
): Order {
    Order {
        id,
        owner,
        is_bid,
        price_bps,
        quantity,
        filled: 0,
        timestamp_ms,
    }
}

public fun order_owner(order: &Order): address { order.owner }
public fun order_is_bid(order: &Order): bool { order.is_bid }
public fun order_price_bps(order: &Order): u64 { order.price_bps }
public fun order_quantity(order: &Order): u64 { order.quantity }
public fun order_filled(order: &Order): u64 { order.filled }
public fun order_remaining(order: &Order): u64 { order.quantity - order.filled }

public fun fill_order(order: &mut Order, amount: u64) {
    order.filled = order.filled + amount;
}

public fun is_open(order: &Order): bool {
    order.filled < order.quantity
}
