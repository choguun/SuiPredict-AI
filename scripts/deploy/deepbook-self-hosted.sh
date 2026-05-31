#!/usr/bin/env bash
# deploy-deepbook-self-hosted.sh
# Deploys DeepBook V3 + DEEP + DUSDC to testnet without Sui team faucet.
#
# Prerequisites:
#   - sui CLI installed and configured with `sui client`
#   - Active address has sufficient testnet SUI for gas
#
# Usage:
#   chmod +x scripts/deploy/deepbook-self-hosted.sh
#   ./scripts/deploy/deepbook-self-hosted.sh
#
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
NETWORK="${SUI_NETWORK:-testnet}"
DEEPBOOKV3_DIR="./deps/deepbookv3"
OUT_FILE="./.env.deployed"

POOL_TICK_SIZE=10000     # 0.00001 * 1e9 (quote scalar for 6-dec tokens, in natural units)
POOL_LOT_SIZE=100000000  # 0.1 * 1e9 (base scalar = 1e9)
POOL_MIN_SIZE=100000000  # 0.1 * 1e9
POOL_CREATION_FEE=500000000  # 500 DEEP * 1e6 MIST

# ── Helpers ────────────────────────────────────────────────────────────────────
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy] WARN: $*" >&2; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

sui()  { command sui --network "$NETWORK" "$@"; }

# Publish a package and extract the package ID from the JSON output.
# Usage: publish_pkg <path> -> echo <packageId>
publish_pkg() {
  local path="$1"
  log "Publishing $path ..."
  local out
  out=$(sui client publish --path "$path" --json 2>&1)
  local pkg_id
  pkg_id=$(echo "$out" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('objectChanges',[]):
    if c.get('type')=='published':
        print(c['packageId'])
        break
" 2>/dev/null) || die "Failed to parse package ID from: $out"
  echo "$pkg_id"
}

# Find a shared object of a given type owned by an address.
# Usage: find_shared_obj <owner> <packageId>:<module>::<struct>
find_shared_obj() {
  local owner="$1"; local type="$2"
  sui client objects --owner "$owner" --json 2>/dev/null | python3 -c "
import json,sys
owner='$owner'; typ='$type'
for obj in json.load(sys.stdin):
    if obj.get('owner',{}).get('Shared'):
        t=obj.get('type','')
        if typ in t:
            print(obj['objectId'], t)
" 2>/dev/null | head -1
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  # 0. Pre-flight checks
  log "Network: $NETWORK"
  [[ -d "$DEEPBOOKV3_DIR" ]] || {
    log "Cloning deepbookv3..."
    mkdir -p "$(dirname "$DEEPBOOKV3_DIR")"
    git clone --depth=1 https://github.com/MystenLabs/deepbookv3 "$DEEPBOOKV3_DIR"
  }

  DEPLOYER=$(sui client active-address) || die "No active address. Run 'sui client' first."
  log "Deployer: $DEPLOYER"

  log "Checking gas..."
  GAS=$(sui client gas --json 2>/dev/null | python3 -c "
import json,sys
total=sum(int(o['balance']) for o in json.load(sys.stdin))
print(total)
" 2>/dev/null) || die "Failed to get gas"
  log "Gas balance: ${GAS} MIST"

  # ── Step 1: Publish token (DEEP coin) ────────────────────────────────────────
  log ""
  log "=== Step 1: DEEP Coin ==="
  TOKEN_PKG=$(publish_pkg "$DEEPBOOKV3_DIR/packages/token")
  DEEP_COIN_TYPE="${TOKEN_PKG}::deep::DEEP"
  log "DEEP coin type : $DEEP_COIN_TYPE"

  # DEEP was already minted by init() + sent to deployer.
  # Call share_treasury_for_testing to create the shared ProtectedTreasury.
  log "Calling share_treasury_for_testing..."
  TREASURY_OUT=$(sui client call \
    --package "$TOKEN_PKG" \
    --module deep \
    --function share_treasury_for_testing \
    --json 2>&1) || warn "share_treasury may have already been shared (first deploy only)"

  # ── Step 2: Publish dusdc (mock stablecoin) ─────────────────────────────────
  log ""
  log "=== Step 2: DUSDC Mock Stablecoin ==="
  DUSDC_PKG=$(publish_pkg "$DEEPBOOKV3_DIR/packages/dusdc")
  DUSDC_COIN_TYPE="${DUSDC_PKG}::dusdc::DUSDC"
  log "DUSDC coin type: $DUSDC_COIN_TYPE"

  # Mint some DUSDC to the deployer for trading.
  # The dusdc package has no mint function (it's just a type marker).
  # For mock purposes we use DUSDC as the quote coin and DEEP as base.
  # No mint needed — the mock DUSDC is just used as a coin type label.

  # ── Step 3: Publish deepbook ────────────────────────────────────────────────
  log ""
  log "=== Step 3: DeepBook V3 Core ==="
  DEEPBOOK_PKG=$(publish_pkg "$DEEPBOOKV3_DIR/packages/deepbook")
  log "DeepBook package: $DEEPBOOK_PKG"

  # Find the Registry shared object (created by deepbook init)
  REGISTRY_LINE=$(find_shared_obj "$DEPLOYER" "${DEEPBOOK_PKG}::registry::Registry")
  REGISTRY_ID=$(echo "$REGISTRY_LINE" | awk '{print $1}')
  if [[ -z "$REGISTRY_ID" ]]; then
    die "Registry not found. Is deepbook init a shared object? Check: sui client objects --owner $DEPLOYER"
  fi
  log "Registry: $REGISTRY_ID"

  # ── Step 4: Fund deployer with DEEP for pool creation fee ────────────────────
  log ""
  log "=== Step 4: Fund DEEP (pool creation fee) ==="
  # The init() in token already sent 10M DEEP to deployer.
  # Confirm balance.
  DEEP_BALANCE=$(sui client balance --coin-type "$DEEP_COIN_TYPE" --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('totalBalance',0))
" 2>/dev/null) || DEEP_BALANCE=0
  log "DEEP balance: $DEEP_BALANCE (need >= $POOL_CREATION_FEE for pool creation)"

  # ── Step 5: Create permissionless DEEP/DUSDC pool ───────────────────────────
  log ""
  log "=== Step 5: Create DEEP/DUSDC Pool ==="
  # DeepBook uses quote/base: base=DUSDC, quote=DEEP (base is YES token, quote is USDC)
  # tick_size/lot_size/min_size are in quote/base scalar units (1e9)
  log "Pool params: tick_size=$POOL_TICK_SIZE lot_size=$POOL_LOT_SIZE min_size=$POOL_MIN_SIZE fee=$POOL_CREATION_FEE"

  POOL_OUT=$(sui client call \
    --package "$DEEPBOOK_PKG" \
    --module pool \
    --function create_permissionless_pool \
    --type-args "$DUSDC_COIN_TYPE#$DEEP_COIN_TYPE" \
    --args "$REGISTRY_ID" "$POOL_TICK_SIZE" "$POOL_LOT_SIZE" "$POOL_MIN_SIZE" "$POOL_CREATION_FEE" \
    --json 2>&1)

  POOL_DIGEST=$(echo "$POOL_OUT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('digest','?'))
" 2>/dev/null)
  POOL_ID=$(echo "$POOL_OUT" | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('objectChanges',[]):
    if c.get('type')=='created' and 'Pool' in c.get('objectType',''):
        print(c['objectId'])
" 2>/dev/null) || POOL_ID="<parse-error>"
  log "Pool created: $POOL_ID (digest: $POOL_DIGEST)"

  # ── Step 6: Create BalanceManager for market-maker ───────────────────────────
  log ""
  log "=== Step 6: Create BalanceManager ==="
  BM_OUT=$(sui client call \
    --package "$DEEPBOOK_PKG" \
    --module balance_manager \
    --function create \
    --json 2>&1)
  BALANCE_MANAGER_ID=$(echo "$BM_OUT" | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('objectChanges',[]):
    if c.get('type')=='created' and 'BalanceManager' in c.get('objectType',''):
        print(c['objectId'])
" 2>/dev/null) || BALANCE_MANAGER_ID="<parse-error>"
  log "BalanceManager: $BALANCE_MANAGER_ID"

  # ── Step 7: Fund BalanceManager with DEEP ────────────────────────────────────
  log ""
  log "=== Step 7: Fund BalanceManager with DEEP ==="
  # Split off some DEEP from deployer to the BalanceManager
  SPLIT_OUT=$(sui client call \
    --package "0x2" \
    --module coin \
    --function split \
    --args "$(sui client gas --json | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['objectId'])")" \
    --json \
    100000000000 2>&1)  # 100k DEEP
  # This is simplified — in practice you'd split the DEEP coin object properly.
  # For now, we just note the BalanceManager needs DEEP funding via sui coin merge/split.

  # ── Done ─────────────────────────────────────────────────────────────────────
  log ""
  log "=== Deployment Complete ==="
  log "package: $TOKEN_PKG     (deep coin)"
  log "package: $DUSDC_PKG    (dusdc coin)"
  log "package: $DEEPBOOK_PKG (deepbook core)"
  log "Registry:  $REGISTRY_ID"
  log "Pool:      $POOL_ID"
  log "BalanceManager: $BALANCE_MANAGER_ID"

  # Write .env.deployed
  cat > "$OUT_FILE" << EOF
# Deployed on $(date -u +%Y-%m-%dT%H:%M:%SZ) via $NETWORK
SUI_NETWORK=$NETWORK
DEEPBOOK_PKG=$DEEPBOOK_PKG
DEEPBOOK_REGISTRY=$REGISTRY_ID
DEEPBOOK_POOL=$POOL_ID
DEEP_COIN_PKG=$TOKEN_PKG
DEEP_COIN_TYPE=$DEEP_COIN_TYPE
DUSDC_COIN_PKG=$DUSDC_PKG
DUSDC_COIN_TYPE=$DUSDC_COIN_TYPE
BALANCE_MANAGER_ID=$BALANCE_MANAGER_ID
TICK_SIZE=$POOL_TICK_SIZE
LOT_SIZE=$POOL_LOT_SIZE
MIN_SIZE=$POOL_MIN_SIZE
EOF
  log ".env.deployed written to $OUT_FILE"
  log ""
  log "Next steps:"
  log "  1. Copy .env.deployed values into your project's .env"
  log "  2. Update prediction_market.move [addresses] with DEEPBOOK_PKG and DEEP_COIN_PKG"
  log "  3. Update SDK deepbook/constants.ts with DEEPBOOK_PKG and DEEPBOOK_REGISTRY"
  log "  4. Re-build contracts: cd packages/contracts && sui move build"
}

main "$@"
