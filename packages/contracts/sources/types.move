/// Shared types for SuiPredict prediction markets.
module suipredict_agent_policy::types;

public fun active(): u8 { 0 }
public fun resolved(): u8 { 1 }
public fun cancelled(): u8 { 2 }

public fun unset(): u8 { 0 }
public fun yes_wins(): u8 { 1 }
public fun no_wins(): u8 { 2 }

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
