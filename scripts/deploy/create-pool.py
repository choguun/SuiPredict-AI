#!/usr/bin/env python3
import subprocess, os, json, sys

env = os.environ.copy()
env["SUI_NETWORK"] = "testnet"

# Try to create pool using the new deepbook and new registry
result = subprocess.run(
    ["sui", "client", "call",
     "--package", "0xfc780fa48fb5f73aee47d1f561e2b47be5409856157659f10f15a2460c129495",
     "--module", "pool",
     "--function", "create_permissionless_pool",
     "--args", "0x1d182fe19da0fd1802999415bf61457c93c084", "1000000", "1", "100",
     "0x5f253d1dd0f135b2773d1674895494134a53bf8e12366e747e30a737e9498a0e",
     "--type-args",
     "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP",
     "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC",
     "--gas-budget", "10000000",
     "--json"],
    capture_output=True, text=True, env=env, timeout=180
)

# Parse JSON, handling any non-JSON prefix
stdout = result.stdout.strip()
stderr = result.stderr.strip()

# Find JSON start
json_start = stdout.find('{')
if json_start > 0:
    json_str = stdout[json_start:]
else:
    json_str = stdout

print(f"Exit: {result.returncode}")
print(f"JSON portion: {json_str[:500]}")

if json_str:
    try:
        d = json.loads(json_str)
        if "error" in d:
            print(f"ERROR: {json.dumps(d['error'], indent=2)}")
        elif "effects" in d:
            eff = d.get("effects", {})
            status = eff.get("status", {})
            print(f"Status: {status}")
            created = eff.get("created", [])
            print(f"Created: {len(created)}")
            for c in created:
                t = c.get("objectType", "")
                obj_id = c.get("reference", {}).get("objectId", "")
                print(f"  {t[:70]} -> {obj_id[:40]}")
        elif "transaction" in d:
            # Transaction built but not executed
            print(f"Transaction built (not executed)")
    except json.JSONDecodeError as e:
        print(f"JSON parse error: {e}")
        print(f"Could not parse: {json_str[:200]}")

print(f"Stderr: {stderr[:300]}")