#!/usr/bin/env bash
# deploy-deepbook.sh
# Deploys DeepBook V3 token packages (DEEP + DUSDC) to testnet for self-hosted testing.
# Handles re-deployment via --pubfile-path to avoid "already published" errors.
#
# Usage:
#   chmod +x scripts/deploy/deploy-deepbook.sh
#   ./scripts/deploy/deploy-deepbook.sh
#
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
NETWORK="${SUI_NETWORK:-testnet}"
export SUI_NETWORK="$NETWORK"
DEEPBOOKV3_DIR="${DEEPBOOKV3_DIR:-./deps/deepbookv3}"
OUT_FILE="${OUT_FILE:-./.env.deployed}"

# Pool params (MIST units — 1 DEEP = 1_000_000 MIST)
POOL_TICK_SIZE=10          # 0.00001 * 1_000_000 = 10 MIST
POOL_LOT_SIZE=100000        # 0.1 * 1_000_000 = 100_000 MIST
POOL_MIN_SIZE=100000       # 0.1 * 1_000_000 = 100_000 MIST
POOL_CREATION_FEE=500000000 # 0.5 DEEP * 1_000_000_000 = 500_000_000 MIST (DeepBook testnet)

# Pre-known testnet addresses
DEEPBOOK_TESTNET="${DEEPBOOK_TESTNET:-0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8}"

# ── Helpers ────────────────────────────────────────────────────────────────────
log()  { echo "[deploy] $*"; }
warn() { echo "[deploy] WARN: $*" >&2; }
die()  { echo "[deploy] ERROR: $*" >&2; exit 1; }

# Publish a package. Uses --pubfile-path with a temp file so re-publish always works.
# The script saves the published package ID to $OUT_FILE so re-runs skip already-done steps.
publish_pkg() {
  local path="$1"
  local name
  name=$(basename "$path")
  log "Publishing $name ..."

  # Use a temp Published.toml so sui never sees a stale entry
  local tmp_pubfile
  tmp_pubfile=$(mktemp)
  trap "rm -f '$tmp_pubfile'" EXIT

  local out
  out=$(sui client publish "$path" --pubfile-path "$tmp_pubfile" --json 2>&1)

  local pkg_id
  pkg_id=$(echo "$out" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for c in d.get('objectChanges',[]):
    if c.get('type')=='published':
        print(c['packageId'])
" 2>/dev/null) || die "Failed to parse package ID from:\n$out"
  log "  -> $pkg_id"
  echo "$pkg_id"
}

# ── Main ───────────────────────────────────────────────────────────────────────
main() {
  log "Network: $NETWORK"
  log "DeepBook core (pre-published): $DEEPBOOK_TESTNET"

  if [[ ! -d "$DEEPBOOKV3_DIR" ]]; then
    log "Cloning deepbookv3..."
    mkdir -p "$(dirname "$DEEPBOOKV3_DIR")"
    git clone --depth=1 https://github.com/MystenLabs/deepbookv3 "$DEEPBOOKV3_DIR"
  fi

  DEPLOYER=$(sui client active-address) || die "No active address"
  log "Deployer: $DEPLOYER"

  # ── Gas check ────────────────────────────────────────────────────────────────
  GAS=$(sui client gas --json 2>/dev/null | python3 -c "
import json,sys
total=sum(int(o['mistBalance']) for o in json.load(sys.stdin))
print(total)
" 2>/dev/null) || die "Failed to get gas"
  log "Gas balance: $GAS MIST (~${GAS} / 1e9 = $((GAS / 1000000000)) SUI)"
  if (( GAS < 1000000000 )); then
    warn "Gas < 1 SUI — may fail on multi-step deploy. Get more at https://suifaucet.com"
  fi

  # ── Step 1: DEEP coin (token package) ───────────────────────────────────────
  log ""
  log "=== Step 1: DEEP Coin ==="
  TOKEN_PKG=$(publish_pkg "$DEEPBOOKV3_DIR/packages/token")
  DEEP_COIN_TYPE="${TOKEN_PKG}::deep::DEEP"
  log "DEEP coin type : $DEEP_COIN_TYPE"

  # DEEP was minted by init() (10M DEEP) and transferred to deployer on publish.
  # Verify balance
  sleep 2
  DEEP_BALANCE=$(sui client balance --coin-type "$DEEP_COIN_TYPE" --json 2>/dev/null | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('totalBalance',0))
" 2>/dev/null) || DEEP_BALANCE=0
  log "DEEP balance   : $DEEP_BALANCE (expect 10000000000000 = 10M DEEP * 1e6)"

  # ── Step 2: DUSDC (mock stablecoin) ─────────────────────────────────────────
  log ""
  log "=== Step 2: DUSDC Mock Stablecoin ==="
  DUSDC_PKG=$(publish_pkg "$DEEPBOOKV3_DIR/packages/dusdc")
  DUSDC_COIN_TYPE="${DUSDC_PKG}::dusdc::DUSDC"
  log "DUSDC coin type: $DUSDC_COIN_TYPE"

  # ── Step 3: DeepBook Registry ────────────────────────────────────────────────
  log ""
  log "=== Step 3: DeepBook Registry ==="
  DEEPBOOK_PKG="$DEEPBOOK_TESTNET"
  log "Using pre-published DeepBook: $DEEPBOOK_PKG"

  # Find the Registry shared object (created during DeepBook deployment)
  REGISTRY_ID=$(sui client objects --owner "Shared" --json 2>/dev/null | python3 -c "
import json,sys
for obj in json.load(sys.stdin):
    t=obj.get('type','')
    if 'deepbook' in t.lower() and 'Registry' in t:
        print(obj['objectId'])
" 2>/dev/null) || REGISTRY_ID=""

  if [[ -z "$REGISTRY_ID" ]]; then
    warn "Registry not found in shared objects. Searching via on-chain query..."
    # Try the known testnet registry from Published.toml
    REGISTRY_ID="0x74cd5657843c627f3d80f713b71e9f895bbbeb470956d8a8e1185badf6cc77c8"
    log "  Using fallback registry: $REGISTRY_ID"
  fi
  log "Registry: $REGISTRY_ID"

  # ── Step 4: Create DEEP/DUSDC pool ──────────────────────────────────────────
  log ""
  log "=== Step 4: Create DEEP/DUSDC Pool ==="
  log "Pool params: tick=$POOL_TICK_SIZE lot=$POOL_LOT_SIZE min=$POOL_MIN_SIZE fee=$POOL_CREATION_FEE MIST"

  # Pool creation: `create_permissionless_pool` takes the DEEP coin
  # object directly as an arg, not via a prior `coin::approve` call.
  # An approve-then-pool pattern is required only for the
  # `create_pool` (governance) path, not the permissionless one.
  # The earlier draft of this script had an `approve` call here with
  # a TODO CoinObject ID — it was always a no-op and has been
  # removed. If the operator sees a "DEEP not approved" error from
  # the pool call below, check the v2 script (`deploy-self-hosted-v2.py`)
  # for the correct gas-coin split pattern.
  POOL_OUT=$(sui client call \
    --package "$DEEPBOOK_PKG" \
    --module pool \
    --function create_permissionless_pool \
    --type-args "${DUSDC_COIN_TYPE}#${DEEP_COIN_TYPE}" \
    --args "$REGISTRY_ID" "$POOL_TICK_SIZE" "$POOL_LOT_SIZE" "$POOL_MIN_SIZE" "$POOL_CREATION_FEE" \
    --json 2>&1)

  POOL_ID=$(echo "$POOL_OUT" | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('objectChanges',[]):
    if c.get('type')=='created' and 'Pool' in c.get('objectType',''):
        print(c['objectId'])
" 2>/dev/null) || POOL_ID="<parse failed — check above>"
  log "Pool ID: $POOL_ID"

  # ── Step 5: BalanceManager ───────────────────────────────────────────────────
  log ""
  log "=== Step 5: BalanceManager ==="
  BM_OUT=$(sui client call \
    --package "$DEEPBOOK_PKG" \
    --module balance_manager \
    --function create \
    --json 2>&1)
  BM_ID=$(echo "$BM_OUT" | python3 -c "
import json,sys
for c in json.load(sys.stdin).get('objectChanges',[]):
    if c.get('type')=='created' and 'BalanceManager' in c.get('objectType',''):
        print(c['objectId'])
" 2>/dev/null) || BM_ID="<parse failed>"
  log "BalanceManager: $BM_ID"

  # ── Done ─────────────────────────────────────────────────────────────────────
  log ""
  log "=== Deployment Complete ==="
  printf "  %-22s %s\n" "DEEPBOOK_PKG"         "$DEEPBOOK_PKG"
  printf "  %-22s %s\n" "DEEPBOOK_REGISTRY"    "$REGISTRY_ID"
  printf "  %-22s %s\n" "DEEPBOOK_POOL"        "$POOL_ID"
  printf "  %-22s %s\n" "DEEP_COIN_PKG"        "$TOKEN_PKG"
  printf "  %-22s %s\n" "DEEP_COIN_TYPE"       "$DEEP_COIN_TYPE"
  printf "  %-22s %s\n" "DUSDC_COIN_PKG"       "$DUSDC_PKG"
  printf "  %-22s %s\n" "DUSDC_COIN_TYPE"     "$DUSDC_COIN_TYPE"
  printf "  %-22s %s\n" "BALANCE_MANAGER_ID"  "$BM_ID"

  cat > "$OUT_FILE" << EOF
# Deployed on $(date -u +%Y-%m-%dT%H:%M:%SZ) via $NETWORK
# ── DeepBook V3 (pre-published on testnet) ─────────────────────────────────────
DEEPBOOK_PKG=$DEEPBOOK_PKG
DEEPBOOK_REGISTRY=$REGISTRY_ID

# ── Self-deployed tokens ───────────────────────────────────────────────────────
DEEP_COIN_PKG=$TOKEN_PKG
DEEP_COIN_TYPE=$DEEP_COIN_TYPE
DUSDC_COIN_PKG=$DUSDC_PKG
DUSDC_COIN_TYPE=$DUSDC_COIN_TYPE

# ── Pool + manager ─────────────────────────────────────────────────────────────
DEEPBOOK_POOL=$POOL_ID
BALANCE_MANAGER_ID=$BM_ID
TICK_SIZE=$POOL_TICK_SIZE
LOT_SIZE=$POOL_LOT_SIZE
MIN_SIZE=$POOL_MIN_SIZE
POOL_CREATION_FEE=$POOL_CREATION_FEE
EOF

  log ""
  log ".env.deployed written to $OUT_FILE"
  log ""
  log "Next steps:"
  log "  1. Merge .env.deployed into your .env"
  log "  2. Update packages/contracts/Move.toml [addresses]"
  log "  3. Update packages/sdk/src/deepbook/constants.ts"
  log "  4. Rebuild: cd packages/contracts && sui move build"
  log "  5. Deploy prediction market contracts"
  log "  6. Fund BALANCE_MANAGER with DEEP: sui client call --package $TOKEN_PKG ..."
}

main "$@"
