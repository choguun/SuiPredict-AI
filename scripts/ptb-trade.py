#!/usr/bin/env python3
"""PTB-based DeepBook Trading Script - Places limit order directly via CLI"""
import subprocess, json, time, sys

SUI = "sui"
NETWORK = "testnet"
SENDER = "0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716"
DEEPBOOK = "0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27"
POOL = "0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125"
BALANCE_MANAGER = "0xd8cae28159a3b9fa40613a0630231d434201a8201d7b0e05626eac388a3ebe0a"
DEEP_TYPE = "0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP"
DUSDC_TYPE = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"
GAS_BUDGET = 500_000_000  # 500 MIST (0.0005 SUI)

def run(args, timeout=60):
    env = {"SUI_NETWORK": NETWORK, **__import__("os").environ}
    result = subprocess.run([SUI] + args, capture_output=True, text=True, env=env, timeout=timeout)
    return result

print("=" * 60)
print("DeepBook PTB Trading Script")
print("=" * 60)

# Step 1: Check pool exists
print(f"\n--- Checking Pool {POOL[:40]}... ---")
r = run(["client", "object", POOL, "--json"])
if r.returncode != 0:
    print(f"ERROR: Pool not found: {r.stderr}")
    sys.exit(1)
d = json.loads(r.stdout)
print(f"Pool type: {d.get('objType', 'unknown')[:60]}...")
print(f"Pool status: OK")

# Step 2: Check balance manager
print(f"\n--- Checking Balance Manager {BALANCE_MANAGER[:40]}... ---")
r = run(["client", "object", BALANCE_MANAGER, "--json"])
if r.returncode != 0:
    print(f"ERROR: Balance Manager not found: {r.stderr}")
    sys.exit(1)
d = json.loads(r.stdout)
print(f"BM type: {d.get('objType', 'unknown')[:60]}...")

# Step 3: Check our DEEP coins
print(f"\n--- Checking DEEP Coins ---")
r = run(["client", "objects", "--json"])
objects = json.loads(r.stdout)
deep_coins = []
for obj in objects:
    data = obj.get("data", {})
    if not data:
        continue
    move = data.get("Move", {})
    type_ = move.get("type_", "")
    if "0x6bddac" in type_ and "deep::DEEP" in type_:
        contents = move.get("contents", [])
        for c in contents:
            if isinstance(c, list) and len(c) == 2 and c[0] == 1:
                deep_coins.append((data.get('id'), int(c[1])))
print(f"Found {len(deep_coins)} DEEP coins")
for cid, bal in sorted(deep_coins, key=lambda x: -x[1])[:3]:
    print(f"  {cid}: {bal/1e6:.3f} DEEP")

if not deep_coins:
    print("ERROR: No DEEP coins found!")
    sys.exit(1)

# Use the 500 DEEP coin for deposit
deep_coin = deep_coins[1] if len(deep_coins) > 1 else deep_coins[0]
deep_coin_id = deep_coin[0]
print(f"\nUsing DEEP coin: {deep_coin_id[:40]}... ({deep_coin[1]/1e6} DEEP)")

# Step 4: Deposit DEEP into Balance Manager via PTB
print(f"\n--- Depositing 10 DEEP into Balance Manager ---")
deposit_amount = 10_000_000  # 10 DEEP in MIST

# Build PTB to:
# 1. Transfer DEEP coin to BM
# 2. Call deposit_into_manager

r = run([
    "client", "ptb",
    "--sender", SENDER,
    "--assign", "bm", f"@0x{ BALANCE_MANAGER.lstrip('0x') }",
    "--assign", "deep_coin", f"@0x{ deep_coin_id.lstrip('0x') }",
    "--move-call", 
    f"{DEEPBOOK}::balance_manager::deposit_into_manager<{DEEP_TYPE}>",
    "@bm", "@deep_coin",
    "--gas-budget", str(GAS_BUDGET),
], timeout=120)

print(f"Deposit PTB output: {r.stdout[:500]}")
print(f"Deposit PTB stderr: {r.stderr[:500]}")
if r.returncode != 0:
    print(f"ERROR: Deposit failed (code {r.returncode})")
    print(f"STDOUT: {r.stdout}")
    print(f"STDERR: {r.stderr}")
    # Try to extract tx digest
    for line in r.stdout.split('\n'):
        if 'TX' in line or 'tx' in line or 'digest' in line.lower():
            print(f"  {line}")
    sys.exit(1)

# Extract TX digest
tx_digest = None
for line in r.stdout.split('\n'):
    if 'digest' in line.lower() or line.startswith('0x'):
        tx_digest = line.strip().split()[-1].strip('.,')
        break

if not tx_digest:
    # Try to parse JSON
    try:
        idx = r.stdout.find('{')
        if idx >= 0:
            d = json.loads(r.stdout[idx:])
            tx_digest = d.get('Transaction', {}).get('digest') or d.get('digest')
    except:
        pass

print(f"Deposit TX: {tx_digest or 'unknown'}")

# Wait for finality
if tx_digest:
    print("Waiting for deposit confirmation...")
    time.sleep(3)

# Step 5: Place limit order via PTB
print(f"\n--- Placing Limit Order (SELL 1 DEEP @ 0.01 DUSDC) ---")

# place_limit_order arguments:
# pool: &Pool<BaseAsset, QuoteAsset>
# balance_manager: &mut BalanceManager
# order_side: bool (0=bid/buy, 1=ask/sell)  
# price: u128 (quote QTY per base unit, in MIST-scaled units)
# quantity: u128 (base asset quantity in MIST-scaled units)
# expire_timestamp: u64 (0 = never)
# self_matching_option: u8 (0=cancel, 1=park, 2=abort)

# For DEEP/DUSDC: 1 DEEP = 1_000_000 MIST
# Price 0.01 DUSDC/DEEP = 0.01 * 1_000_000 = 10_000 MIST per DEEP
# But DUSDC has 6 decimals too, so price = 10_000_000

ORDER_SIDE = 1  # ask (sell)
ORDER_PRICE = 1_000_000  # 1 DUSDC per DEEP (simpler)
ORDER_QTY = 1_000_000  # 1 DEEP
EXPIRE_TS = 0  # never
SELF_MATCH = 0  # cancel

r = run([
    "client", "ptb",
    "--sender", SENDER,
    "--assign", "pool", f"@0x{ POOL.lstrip('0x') }",
    "--assign", "bm", f"@0x{ BALANCE_MANAGER.lstrip('0x') }",
    "--move-call",
    f"{DEEPBOOK}::pool::place_limit_order<{DEEP_TYPE}, {DUSDC_TYPE}>",
    "@pool", "@bm",
    str(ORDER_SIDE), str(ORDER_PRICE), str(ORDER_QTY), str(EXPIRE_TS), str(SELF_MATCH),
    "--gas-budget", str(GAS_BUDGET),
], timeout=120)

print(f"Order PTB output: {r.stdout[:1000]}")
print(f"Order PTB stderr: {r.stderr[:500]}")
if r.returncode != 0:
    print(f"ERROR: Order failed (code {r.returncode})")
    print(f"STDOUT: {r.stdout}")
    print(f"STDERR: {r.stderr}")
    sys.exit(1)

# Extract tx digest
for line in r.stdout.split('\n'):
    if 'digest' in line.lower():
        tx_digest = line.strip().split()[-1].strip('.,')
        break

print(f"\nOrder TX: {tx_digest or 'unknown'}")
print("\n--- SUCCESS ---")
if tx_digest:
    print(f"Check TX: sui client tx-block {tx_digest}")
