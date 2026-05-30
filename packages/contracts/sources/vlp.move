/// Vault LP share token.
#[allow(deprecated_usage)]
module suipredict_agent_policy::vlp;

use sui::coin;

public struct VLP has drop {}

fun init(witness: VLP, ctx: &mut TxContext) {
    let (treasury, metadata) = coin::create_currency(
        witness,
        6,
        b"VLP",
        b"SuiPredict Vault LP",
        b"SuiPredict prediction market vault LP shares",
        option::none(),
        ctx,
    );
    transfer::public_freeze_object(metadata);
    transfer::public_transfer(treasury, ctx.sender());
}
