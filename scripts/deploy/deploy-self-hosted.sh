#!/usr/bin/env bash
# deploy-self-hosted.sh
# Deploys a self-hosted DeepBook V3 stack to testnet.
# Step 1 (token) already done - use known addresses.
# Step 2 (DUSDC) needs to be published.
# Step 3 (deepbook) already published.
# Step 4+ (registry, pool, balance manager) - run now.

set -e

NETWORK="${SUI_NETWORK:-testnet}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$SCRIPT_DIR/../../deps/deepbookv3-self-hosted/packages"
ENV_FILE="$SCRIPT_DIR/../../.env.deployed-self-hosted"

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

ADDR="$(SUI_NETWORK="$NETWORK" sui client active-address)" || die "No active address"
log "Deployer: $ADDR"

# === KNOWN ADDRESSES FROM PREVIOUS RUNS ===
# Self-hosted token package (published via sui client publish)
SELF_TOKEN_PKG="0x0ef95963988fc443f31b822836ea5841f0cfed18e4749b45254b87cb82978cab"
# Registry shared object (from self-hosted deepbook init)
SELF_REGISTRY_ID="0x23b1725543f4e48255b79a3e857986826be87a3ad703016176286fb47b6f4009"
# Self-hosted DEEP coin (initial mint, 100k DEEP)
SELF_DEEP_COIN_ID="0x6975232e5e9495a63f6f1e362d47aa48e42a9e70f82cc785e471c5240c582cda"
# Self-hosted deepbook package
SELF_DEEPBOOK_PKG="0x0ef95963988fc443f31b822836ea5841f0cfed18e4749b45254b87cb82978cab"

# Mysten Labs DUSDC (already on testnet, will use as quote asset)
ML_DUSDC_TYPE="0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC"
ML_DUSDC_COIN_ID="0x2c24575820d9e0d2b5d5edea716dc699ddf12096c3cfe98609d0f2f106906c50"

# Self-hosted DEEP type string
SELF_DEEP_TYPE="${SELF_TOKEN_PKG}::deep::DEEP"

log "Self-hosted DEEP type: $SELF_DEEP_TYPE"
log "Mysten Labs DUSDC type:  $ML_DUSDC_TYPE"

# Write header
> "$ENV_FILE"
echo "# Self-hosted DeepBook V3 deployment $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$ENV_FILE"
echo "NETWORK=testnet" >> "$ENV_FILE"
echo "SELF_TOKEN_PKG=$SELF_TOKEN_PKG" >> "$ENV_FILE"
echo "SELF_REGISTRY_ID=$SELF_REGISTRY_ID" >> "$ENV_FILE"
echo "SELF_DEEPBOOK_PKG=$SELF_DEEPBOOK_PKG" >> "$ENV_FILE"
echo "SELF_DEEP_COIN_ID=$SELF_DEEP_COIN_ID" >> "$ENV_FILE"
echo "SELF_DEEP_TYPE=$SELF_DEEP_TYPE" >> "$ENV_FILE"
echo "ML_DUSDC_COIN_ID=$ML_DUSDC_COIN_ID" >> "$ENV_FILE"

###############################################################################
# Step 2: Publish self-hosted DUSDC package
###############################################################################
log "Step 2: Publishing self-hosted DUSDC package..."
DUSDC_DIR="$PKG_DIR/dusdc"
rm -f "$DUSDC_DIR/Published.toml"

OUT=$(SUI_NETWORK="$NETWORK" sui client publish "$DUSDC_DIR" --skip-dependency-verification --json 2>&1)

# Extract the JSON portion (skip non-JSON lines like "INCLUDING DEPENDENCY...", warnings, etc.)
CLEAN_JSON=$(echo "$OUT" | sed -n '/^{/,/^}/p' | tr '\n' ' ' | python3 -c "
import json,sys
raw = sys.stdin.read()
# Find the first '{' and last '}'
start = raw.find('{')
end = raw.rfind('}') + 1
if start >= 0 and end > start:
    print(raw[start:end])
" 2>/dev/null) || CLEAN_JSON="{}"

echo "$CLEAN_JSON" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
if 'error' in d:
    print('ERROR:', d['error'])
else:
    pkg_id=''
    for c in d.get('objectChanges',[]):
        if c.get('type')=='published':
            pkg_id=c.get('packageId','NOT_FOUND')
            print(f'DUSDC_PKG_ID={pkg_id}')
    if not pkg_id:
        print('DUSDC_PKG_ID=NOT_FOUND')
    for c in d.get('objectChanges',[]):
        if c.get('type')=='created':
            t=c.get('objectType','')
            if 'Treasury' in t or 'Coin' in t:
                print(f\"DUSDC_OBJ={c.get('objectId','')}\")
" 2>/dev/null >> "$ENV_FILE"

SELF_DUSDC_PKG=$(grep "DUSDC_PKG_ID=" "$ENV_FILE" | tail -1 | cut -d= -f2)
log "  Self-hosted DUSDC package: $SELF_DUSDC_PKG"

###############################################################################
# Step 4: Create DEEP/DUSDC pool using self-hosted DEEP + Myster Labs DUSDC
###############################################################################
log "Step 4: Creating DEEP/DUSDC pool..."

# Pool creation fee = 500 DEEP = 500_000_000 MIST
# We have ~100k DEEP in one coin, need to split off 500 DEEP for the fee

log "  Splitting 500 DEEP for pool creation fee..."
SPLIT_OUT=$(SUI_NETWORK="$NETWORK" sui client call \
    --package 0x2 \
    --module coin \
    --function split \
    --args "0x2::coin::Coin<${SELF_DEEP_TYPE}>" "$SELF_DEEP_COIN_ID" 500000000 \
    --json 2>&1)

if echo "$SPLIT_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('ERROR' if 'error' in d else 'OK')" 2>/dev/null | grep -q ERROR; then
    die "Failed to split DEEP coin: $(echo "$SPLIT_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','') if 'error' in d else '')" 2>/dev/null)"
fi

POOL_FEE_COIN_ID=$(echo "$SPLIT_OUT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for c in d.get('objectChanges',[]):
    if c.get('type')=='created':
        t=c.get('objectType','')
        if 'Coin' in t and 'DEEP' in t:
            print(c.get('objectId',''))
" 2>/dev/null) || die "Could not parse pool fee coin from split output"
log "  Pool fee coin (500 DEEP): $POOL_FEE_COIN_ID"

# Also get remaining DEEP coin after split
REMAINING_DEEP_COIN_ID=$(echo "$SPLIT_OUT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for c in d.get('objectChanges',[]):
    if c.get('type')=='created':
        t=c.get('objectType','')
        if 'Coin' in t and 'DEEP' in t:
            oid=c.get('objectId','')
            if oid!='$POOL_FEE_COIN_ID':
                print(oid)
" 2>/dev/null) || REMAINING_DEEP_COIN_ID=""
[ -n "$REMAINING_DEEP_COIN_ID" ] && log "  Remaining DEEP coin: $REMAINING_DEEP_COIN_ID"

log "  Creating pool (registry=$SELF_REGISTRY_ID)..."
POOL_OUT=$(SUI_NETWORK="$NETWORK" sui client call \
    --package "$SELF_DEEPBOOK_PKG" \
    --module pool \
    --function create_permissionless_pool \
    --args "$SELF_REGISTRY_ID" 1000000 1 100 "$POOL_FEE_COIN_ID" \
    --type-args "$SELF_DEEP_TYPE" "$ML_DUSDC_TYPE" \
    --json 2>&1)

if echo "$POOL_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('ERROR' if 'error' in d else 'OK')" 2>/dev/null | grep -q ERROR; then
    die "Pool creation failed: $(echo "$POOL_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','') if 'error' in d else '')" 2>/dev/null)"
fi

POOL_ID=$(echo "$POOL_OUT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for c in d.get('objectChanges',[]):
    if c.get('type')=='created':
        t=c.get('objectType','')
        if 'Pool' in t:
            print(c.get('objectId',''))
" 2>/dev/null) || POOL_ID="NOT_FOUND"
log "  Pool ID: $POOL_ID"

echo "SELF_POOL_ID=$POOL_ID" >> "$ENV_FILE"
[ -n "$REMAINING_DEEP_COIN_ID" ] && echo "SELF_DEEP_COIN_ID_REMAINING=$REMAINING_DEEP_COIN_ID" >> "$ENV_FILE"

###############################################################################
# Step 5: Create BalanceManager
###############################################################################
log "Step 5: Creating BalanceManager..."

BM_OUT=$(SUI_NETWORK="$NETWORK" sui client call \
    --package "$SELF_DEEPBOOK_PKG" \
    --module balance_manager \
    --function create_balance_manager \
    --args "$ADDR" \
    --json 2>&1) || log "  WARNING: BalanceManager call returned non-zero"

if echo "$BM_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print('ERROR' if 'error' in d else 'OK')" 2>/dev/null | grep -q ERROR; then
    log "  BalanceManager creation may have failed (continuing):"
    log "  $(echo "$BM_OUT" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); print(d.get('error',{}).get('message','') if 'error' in d else '')" 2>/dev/null)"
    BM_ID="NOT_FOUND"
else
    BM_ID=$(echo "$BM_OUT" | python3 -c "
import json,sys
d=json.loads(sys.stdin.read())
for c in d.get('objectChanges',[]):
    if c.get('type')=='created':
        t=c.get('objectType','')
        if 'BalanceManager' in t:
            print(c.get('objectId',''))
" 2>/dev/null) || BM_ID="NOT_FOUND"
fi

if [ "$BM_ID" != "NOT_FOUND" ] && [ -n "$BM_ID" ]; then
    log "  BalanceManager ID: $BM_ID"
    echo "SELF_BALANCE_MANAGER_ID=$BM_ID" >> "$ENV_FILE"
else
    log "  BalanceManager not in output (may already exist or not returned)"
fi

###############################################################################
# Summary
###############################################################################
log ""
log "=== Self-hosted deployment complete ==="
log "Token package:   $SELF_TOKEN_PKG"
log "DeepBook pkg:    $SELF_DEEPBOOK_PKG"
log "Registry:        $SELF_REGISTRY_ID"
log "Pool:            $POOL_ID"
[ -n "$BM_ID" ] && [ "$BM_ID" != "NOT_FOUND" ] && log "BalanceManager: $BM_ID"
log ""
log "Config written to: $ENV_FILE"
log ""
log "NOTE: Using Mysten Labs DUSDC ($ML_DUSDC_TYPE) as quote asset."
log "      Self-hosted DUSDC package: ${SELF_DUSDC_PKG:-NOT_PUBLISHED}"
log ""
log "Next steps:"
log "  1. Update packages/sdk/src/deepbook/constants.ts with pool address"
log "  2. Fund BalanceManager with DEEP from remaining coin"
log "  3. Run market-maker and verify order book syncs"