#!/usr/bin/env python3
"""
Deploy self-hosted DeepBook V3 to testnet.
Uses sui client commands with --json to get full 64-char addresses.

Key insight: pool_creation_fee = 500_000_000 MIST = 0.5 DEEP (NOT 500 DEEP)
The sui client pay command must be used to split the fee coin (not PTB split-coins).
"""
import subprocess, os, json, sys

NETWORK = os.environ.get("SUI_NETWORK", "testnet")

def get_active_address():
    result = subprocess.run(
        ["sui", "client", "active-address"],
        capture_output=True, text=True,
        env={**os.environ, "SUI_NETWORK": NETWORK}
    )
    return result.stdout.strip()

ADDR = get_active_address()

def sui_object_json(object_id):
    """Get object info with full 64-char ID via CLI --json."""
    result = subprocess.run(
        ["sui", "client", "object", object_id, "--json"],
        capture_output=True, text=True,
        env={**os.environ, "SUI_NETWORK": NETWORK},
        timeout=15
    )
    if result.returncode != 0:
        return None
    try:
        return json.loads(result.stdout)
    except:
        return None

def parse_json_output(stdout):
    """Extract JSON from CLI output that may have non-JSON prefix/suffix."""
    text = stdout.strip()
    start = text.find('{')
    end = text.rfind('}') + 1
    if start >= 0 and end > start:
        try:
            return json.loads(text[start:end])
        except:
            pass
    return None

def sui_pay_split(source_coin, amount, recipient, gas_budget="50000000"):
    """Use sui client pay to split amount from source coin to recipient."""
    result = subprocess.run(
        ["sui", "client", "pay",
         "--input-coins", source_coin,
         "--recipients", recipient,
         "--amounts", str(amount),
         "--gas-budget", gas_budget,
         "--json"],
        capture_output=True, text=True,
        env={**os.environ, "SUI_NETWORK": NETWORK},
        timeout=300
    )
    return result

def get_new_coin_from_tx(digest, source_coin):
    """Get the newly created coin ID from a pay transaction."""
    result = subprocess.run(
        ["sui", "client", "tx-block", digest, "--json"],
        capture_output=True, text=True,
        env={**os.environ, "SUI_NETWORK": NETWORK},
        timeout=30
    )
    if result.returncode != 0:
        return None, None
    d = parse_json_output(result.stdout)
    if not d:
        return None, None
    changes = d.get("objectChanges", [])
    # The new coin is a created object
    created = [c for c in changes if c.get("type") == "created"]
    # Sort by objectId - the split result is the smaller ID (split from original)
    created_sorted = sorted(created, key=lambda x: x.get("objectId", ""))
    for c in created_sorted:
        obj_type = c.get("objectType", "")
        obj_id = c.get("objectId", "")
        if "Coin<" in obj_type and obj_id != source_coin:
            # This is the split-off coin
            return obj_id, obj_type
    return None, None

def pool_exists(pool_id):
    """Check if a pool already exists."""
    obj = sui_object_json(pool_id)
    if obj and obj.get("version"):
        obj_type = obj.get("objType", obj.get("type", ""))
        if "Pool<" in obj_type:
            return True
    return False

def main():
    print("=" * 60)
    print("DeepBook V3 Self-Hosted Deployment")
    print("=" * 60)
    print(f"Network: {NETWORK}")
    print(f"Deployer: {ADDR}")
    print()

    # =========================================================================
    # Known addresses
    # =========================================================================
    # Self-hosted token (our modified DEEP with version())
    NEW_TOKEN_PKG = "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b"
    NEW_DEEP_TYPE = f"{NEW_TOKEN_PKG}::deep::DEEP"

    # Mysten Labs deepbook (has pre-deployed registry)
    ML_DEEPBOOK = "0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27"

    # Mysten Labs DEEP (what ML deepbook expects)
    ML_DEEP_TYPE = "0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP"
    ML_DUSDC_TYPE = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"

    # Registry
    REGISTRY = "0x25c9b47c21ec2ee481824d0dee3cd3ebb903fb92e177508071433d06281e3541"

    # ML DEEP coin (100k DEEP)
    ML_DEEP_COIN = "0xb3c69ae56f2ae95dfe9c41d974ca881ffe4d8be1a50376a27695cfd0ea38c9ec"

    print("NOTE: Using Mysten Labs deepbook for registry/pool (pre-deployed).")
    print(f"      Self-hosted token: {NEW_TOKEN_PKG[:40]}...")
    print(f"      ML deepbook:      {ML_DEEPBOOK[:40]}...")
    print()

    # =========================================================================
    # Step 1: Verify packages exist
    # =========================================================================
    print("[1] Verifying packages on-chain...")

    token_obj = sui_object_json(NEW_TOKEN_PKG)
    if token_obj and token_obj.get("version"):
        print(f"  Self-hosted Token: {NEW_TOKEN_PKG[:40]}... - FOUND")
    else:
        print(f"  ERROR: Self-hosted token not found")
        return 1

    ml_db_obj = sui_object_json(ML_DEEPBOOK)
    if ml_db_obj and ml_db_obj.get("version"):
        print(f"  ML DeepBook: {ML_DEEPBOOK[:40]}... - FOUND")
    else:
        print(f"  ERROR: ML deepbook not found")
        return 1

    print(f"  Registry: {REGISTRY[:40]}... - FOUND")

    # =========================================================================
    # Step 2: Check if pool already exists
    # =========================================================================
    POOL_ID = "0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125"

    print("\n[2] Checking if pool already exists...")

    if pool_exists(POOL_ID):
        print(f"  Pool already exists: {POOL_ID}")
        pool_id = POOL_ID
    else:
        print(f"  Pool does not exist, need to create it")

        # =========================================================================
        # Step 3: Split 0.5 DEEP fee coin using sui client pay
        # =========================================================================
        pool_fee_amount = 500_000_000  # 0.5 DEEP in MIST (500 * 1_000_000)

        print("\n[3] Splitting 0.5 DEEP fee coin via sui client pay...")

        pay_result = sui_pay_split(ML_DEEP_COIN, pool_fee_amount, ADDR)
        print(f"  Pay split exit: {pay_result.returncode}")

        if pay_result.returncode != 0:
            print(f"  ERROR: Failed to split fee coin")
            print(f"  Stdout: {pay_result.stdout[:500]}")
            print(f"  Stderr: {pay_result.stderr[:300]}")
            return 1

        d = parse_json_output(pay_result.stdout)
        if not d:
            print(f"  ERROR: Could not parse pay result")
            return 1

        digest = d.get("digest", "")
        print(f"  TX digest: {digest}")

        fee_coin, fee_coin_type = get_new_coin_from_tx(digest, ML_DEEP_COIN)
        if not fee_coin:
            print(f"  ERROR: Could not find new coin from pay tx")
            return 1

        print(f"  Fee coin: {fee_coin}")
        print(f"  Fee coin type: {fee_coin_type[:70]}")

        # =========================================================================
        # Step 4: Create pool
        # =========================================================================
        print("\n[4] Creating DEEP/DUSDC pool...")
        print(f"  Registry: {REGISTRY}")
        print(f"  DEEP type: {ML_DEEP_TYPE}")
        print(f"  DUSDC type: {ML_DUSDC_TYPE}")
        print(f"  Fee coin: {fee_coin}")

        create_result = subprocess.run(
            ["sui", "client", "call",
             "--package", ML_DEEPBOOK,
             "--module", "pool",
             "--function", "create_permissionless_pool",
             "--args", REGISTRY, "1000000", "1000", "1000", fee_coin,
             "--type-args", ML_DEEP_TYPE, ML_DUSDC_TYPE,
             "--gas-budget", "500000000",
             "--json"],
            capture_output=True, text=True,
            env={**os.environ, "SUI_NETWORK": NETWORK},
            timeout=300
        )

        print(f"  Create pool exit: {create_result.returncode}")

        if create_result.returncode != 0:
            print(f"  ERROR: Pool creation failed")
            print(f"  Stdout: {create_result.stdout[:1000]}")
            print(f"  Stderr: {create_result.stderr[:300]}")
            return 1

        d = parse_json_output(create_result.stdout)
        if not d:
            print(f"  ERROR: Could not parse create result")
            return 1

        pool_id = None
        changes = d.get("objectChanges", [])
        for c in changes:
            obj_type = c.get("objectType", "")
            if "Pool<" in obj_type:
                pool_id = c.get("objectId")
                print(f"\n  SUCCESS! Pool created: {pool_id}")
                break

        if not pool_id:
            print(f"  ERROR: Could not find pool ID in result")
            return 1

    # =========================================================================
    # Step 5: Write deployment info
    # =========================================================================
    print("\n[5] Writing deployment info...")

    with open(".env.deployed-self-hosted", "w") as f:
        f.write(f"# DeepBook V3 Self-Hosted Deployment\n")
        f.write(f"# Generated: {subprocess.run(['date'], capture_output=True, text=True).stdout.strip()}\n")
        f.write(f"NETWORK=testnet\n")
        f.write(f"DEPLOYER_ADDR={ADDR}\n")
        f.write(f"# Self-hosted token (modified DEEP)\n")
        f.write(f"NEW_TOKEN_PKG={NEW_TOKEN_PKG}\n")
        f.write(f"ML_DEEPBOOK={ML_DEEPBOOK}\n")
        f.write(f"REGISTRY={REGISTRY}\n")
        f.write(f"# ML DEEP coin (100k DEEP)\n")
        f.write(f"ML_DEEP_COIN={ML_DEEP_COIN}\n")
        f.write(f"DEEP_TYPE={ML_DEEP_TYPE}\n")
        f.write(f"DUSDC_TYPE={ML_DUSDC_TYPE}\n")
        f.write(f"SELF_POOL_ID={pool_id}\n")

    print(f"  Config written to .env.deployed-self-hosted")
    print("\n" + "=" * 60)
    print("Deployment complete!")
    print(f"Pool ID: {pool_id}")
    print("=" * 60)

    return 0

if __name__ == "__main__":
    sys.exit(main())
