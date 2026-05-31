# DeepBook V3 Trading - Standard Operating Procedure

## Overview

This document covers the complete flow for integrating DeepBook V3 trading into SuiPredict-AI, including self-hosted deepbook deployment, Balance Manager creation, deposit/withdrawal, and order placement via CLI and SDK.

**Network:** Testnet
**DeepBook Package (OLD):** `0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27`
**DeepBook Package (npm):** `0xfb28c4cbc6865bd1c897d26aecbe1f8792d1509a20ffec692c800660cbec6982`

---

## 1. Self-Hosted DeepBook Setup

### 1.1 Clone and Build

```bash
cd ~/projects
git clone https://github.com/MystenLabs/deepbook.git
cd deepbook
git log --oneline -1  # Note commit for verification

# Build for testnet
sui client publish --path deepbook_v3 --network testnet -y
```

### 1.2 Verify Deployment

```bash
# Check package on-chain
sui client object <DEEPBOOK_PACKAGE_ID> --network testnet

# Key package objects:
DEEPBOOK_PKG="0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27"
```

### 1.3 Pool Creation

**Pool creation requires:**
- 0.5 SUI (500_000_000 MIST) - NOT 500 DEEP
- DEEP tokens for fees
- Both base and quote asset coin types must exist

```bash
# Create DEEP/DUSDC pool
sui client ptb \
  --sender @<OWNER_ADDRESS> \
  --move-call '<DEEPBOOK_PKG>::pool::create_permissionless_pool<<braseCoinType>, <quoteCoinType>>' \
  @<deepTreasuryCap> \
  @<dusdcTreasuryCap> \
  @<deepDeployerCap> \
  @<clock> \
  --gas-budget 600000000
```

**Pool creation fee (from constants.move):**
```move
const POOL_CREATION_FEE: u64 = 500_000_000; // MIST, not DEEP
```

---

## 2. Token Deployment (DUSDC Example)

### 2.1 Deploy Coin Module

```bash
cd ~/projects/suipredict-ai
sui client publish --path deps/deepbookv3 --network testnet -y
```

### 2.2 Mint Tokens

```bash
# Mint DUSDC
sui client ptb \
  --sender @<OWNER_ADDRESS> \
  --move-call '<DUSDC_PKG>::coin::mint<...::dusdc::DUSDC>' \
    @<OWNER_ADDRESS> \
    <AMOUNT_IN_TINYMOU> \
  --gas-budget 50000000
```

### 2.3 Token Constants

```typescript
const DEEP_TOKEN = "0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP";
const DUSDC_TOKEN = "0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC";
```

---

## 3. Balance Manager Operations

Balance Manager (BM) holds user funds for trading. Each user needs their own BM.

### 3.1 Create Balance Manager

```bash
# Create BM with custom owner
sui client ptb \
  --sender @<USER_ADDRESS> \
  --move-call '<DEEPBOOK_PKG>::balance_manager::new_with_custom_owner' \
    @<USER_ADDRESS> \
  --assign new_bm \
  --transfer-objects "[new_bm]" @<USER_ADDRESS> \
  --gas-budget 50000000
```

**Output:** Returns new BM object ID. Store this for all trading operations.

### 3.2 Deposit Assets into BM

```bash
# Deposit DUSDC into BM
sui client ptb \
  --sender @<USER_ADDRESS> \
  --move-call '<DEEPBOOK_PKG>::balance_manager::deposit<...>::dusdc::DUSDC>' \
    @<BM_ID> \
    @<DUSDC_COIN_ID> \
  --gas-budget 50000000
```

**Verified working deposit types:**
- `balance_manager::deposit<0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC>` (DUSDC)
- `balance_manager::deposit<0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP>` (DEEP)

### 3.3 Withdraw Assets from BM

```bash
# Withdraw DUSDC from BM
sui client ptb \
  --sender @<USER_ADDRESS> \
  --move-call '<DEEPBOOK_PKG>::balance_manager::withdraw<...>::dusdc::DUSDC>' \
    @<BM_ID> \
    <AMOUNT_IN_TINYMOU> \
  --assign withdrawn_coin \
  --transfer-objects "[withdrawn_coin]" @<USER_ADDRESS> \
  --gas-budget 50000000
```

---

## 4. Order Placement (CLI)

### 4.1 Place Limit Order

```bash
# Full command structure for place_limit_order
sui client ptb \
  --sender @<USER_ADDRESS> \
  --move-call '<DEEPBOOK_PKG>::balance_manager::generate_proof_as_owner' \
    @<BM_ID> \
  --assign proof \
  --move-call '<DEEPBOOK_PKG>::pool::place_limit_order<BASE, QUOTE>' \
    @<POOL_ID> \
    @<BM_ID> \
    proof \
    <CLIENT_ORDER_ID> \          # u64, e.g., 55555
    <IS_BID> \                   # true = buy base, false = sell base
    <SCALING_WAS_BASE> \         # usually 0
    <BASE_QTY> \                 # in base asset units
    <PRICE> \                   # in quote asset units per base
    <ORDER_TYPE> \               # 0 = no_fee, check other options
    <SELF_MATCHING> \            # 0 = cancel oldest
    <EXPIRE_TIMESTAMP> \         # MUST be 18446744073709551615 (max u64)
    @<CLOCK> \
  --gas-budget 200000000
```

### 4.2 Real Example (Verified Working)

```bash
# Place ASK order: sell 1000 DEEP for 1 DUSDC each
sui client ptb \
  --sender @0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716 \
  --move-call '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27::balance_manager::generate_proof_as_owner' \
    @0x7627b14590d561b37dcd3e4d5953dc3faa29f425c5f70d4acce28e46b6a13af1 \
  --assign proof \
  --move-call '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27::pool::place_limit_order<0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP, 0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC>' \
    @0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125 \
    @0x7627b14590d561b37dcd3e4d5953dc3faa29f425c5f70d4acce28e46b6a13af1 \
    proof \
    55555 \
    0 \
    0 \
    1000000 \
    1000000 \
    false \
    false \
    18446744073709551615 \
    @0x6 \
  --gas-budget 200000000
```

**Arguments explained:**
| Arg | Value | Meaning |
|-----|-------|---------|
| CLIENT_ORDER_ID | 55555 | Your internal order reference |
| IS_BID | 0 | 0 = ASK (selling base), 1 = BID (buying base) |
| SCALING_WAS_BASE | 0 | Used for market orders |
| BASE_QTY | 1000000 | 1 DEEP (1e6 decimal) |
| PRICE | 1000000 | 1 DUSDC per DEEP (1e6 decimal) |
| ORDER_TYPE | false | false = no_fee |
| SELF_MATCHING | false | Cancel older order on self-match |
| EXPIRE_TIMESTAMP | 18446744073709551615 | Never expire (max u64) |

### 4.3 Common Errors

| Error Code | Constant | Fix |
|------------|----------|-----|
| 1 | EOrderBelowMinimumSize | Increase quantity or check pool lot_size |
| 2 | EInvalidExpireTimestamp | Use max u64: 18446744073709551615 |
| 3 | EBalanceManagerBalanceTooLow | Deposit more quote asset for BID, base for ASK |
| 5 | EOrderInvalidPrice | Price must be multiple of tick_size |

---

## 5. SDK Integration (TypeScript)

### 5.1 SDK Setup

```typescript
// packages/sdk/package.json dependencies
{
  "@mysten/deepbook-v3": "file:../deps/deepbookv3",
  "@mysten/sui": "^2.17.0"
}
```

### 5.2 Keypair from Private Key

**Important:** @mysten/sui v2.17.0 does NOT expose `fromSuiPrivateKey()`. Use raw key bytes:

```typescript
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromB64 } from '@mysten/sui/utils';

function keypairFromHex(hex: string): Ed25519Keypair {
  const secretKey = Buffer.from(hex, 'hex');
  return new Ed25519Keypair(secretKey);
}

const keypair = keypairFromHex(privateKeyHex);
const address = keypair.getPublicKey().toSuiAddress();
```

### 5.3 Place Order via SDK

```typescript
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiClient } from '@mysten/sui/client';

const client = new SuiClient({
  url: 'https://fullnode.testnet.sui.io:443'
});

const keypair = keypairFromHex(process.env.PRIVATE_KEY);

// Build transaction via SDK then sign/execute
// Note: SDK's placeLimitOrder() builds correct PTB internally
```

### 5.4 SDK Trade Script Example

See: `packages/sdk/scripts/sdk-trade.mjs`

```bash
cd packages/sdk
SUI_PRIVATE_KEY=<hex_key> node scripts/sdk-trade.mjs
```

---

## 6. Frontend Integration

### 6.1 Architecture

```
Frontend (React/Next.js)
    |
    |---> SuiClient (RPC) <---> fullnode.testnet.sui.io:443
    |           |
    |           +-> sui_getObject (pool, BM state)
    |           +-> sui_getTransactionBlock (events, status)
    |
    |---> Your Backend API (optional)
    |           |
    |           +-> Generate unsigned TX
    |           +-> Sponsor gas (if using sponsored TX)
    |
    |---> User's Wallet (ZengoWallet, Sui Wallet)
                |
                +-> Sign + Execute TX
```

### 6.2 Frontend Components

```typescript
// lib/deepbook.ts
import { SuiClient } from '@mysten/sui/client';

const TESTNET_RPC = 'https://fullnode.testnet.sui.io:443';

export const suiClient = new SuiClient({ url: TESTNET_RPC });

// Pool object ID
export const DEEP_BOOK_POOL = {
  deep_dusdc: '0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125',
  deep_usdc: '0xe86b991f8632217505fd859445f9803967ac84a9d4a1219065bf191fcb74b622',
};

// Balance Manager per user (stored in your backend/localStorage)
export interface UserTradingAccount {
  balanceManagerId: string;
  deepBalance: string;
  dusdcBalance: string;
}
```

### 6.3 Fetch Pool State

```typescript
async function getPoolState(poolId: string) {
  const pool = await suiClient.getObject({
    id: poolId,
    options: { showContent: true }
  });

  const fields = (pool.data?.content as { fields: Record<string, unknown> }).fields;
  return {
    baseAssetSupply: fields.base_asset_supply,
    quoteAssetSupply: fields.quote_asset_supply,
    tickSize: fields.tick_size,
    lotSize: fields.lot_size,
    asksId: fields.asks_id,
    bidsId: fields.bids_id,
  };
}
```

### 6.4 Fetch User BM Balance

```typescript
async function getBMBalances(bmId: string) {
  // DEEP balance (as dynamic field)
  const deepKey = {
    type: '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27::balance_manager::BalanceKey<0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP>',
  };

  const [deepBalance, dusdcBalance] = await Promise.all([
    suiClient.getDynamicFieldObject({ parentId: bmId, name: deepKey }),
    // Similar for DUSDC...
  ]);

  return { deepBalance, dusdcBalance };
}
```

### 6.5 Transaction Builder

```typescript
import { Transaction } from '@mysten/sui/transactions';

function buildPlaceOrderTx(params: {
  poolId: string;
  bmId: string;
  isBid: boolean;
  quantity: bigint;
  price: bigint;
  clientOrderId: number;
}) {
  const tx = new Transaction();

  // Generate proof
  const proof = tx.moveCall({
    target: '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27::balance_manager::generate_proof_as_owner',
    arguments: [tx.object(params.bmId)],
  });

  // Place order
  tx.moveCall({
    target: '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27::pool::place_limit_order',
    typeArguments: [
      '0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP',
      '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC',
    ],
    arguments: [
      tx.object(params.poolId),
      tx.object(params.bmId),
      proof,
      tx.pure(params.clientOrderId, 'u64'),
      tx.pure(params.isBid, 'bool'),
      tx.pure(0, 'u8'),           // scaling flags
      tx.pure(params.quantity, 'u128'),
      tx.pure(params.price, 'u128'),
      tx.pure(false, 'bool'),     // order_type
      tx.pure(false, 'bool'),     // self_matching
      tx.pure(18446744073709551615n, 'u64'), // expire_timestamp
      tx.object('0x6'),          // Clock
    ],
  });

  return tx;
}
```

### 6.6 Execute Transaction

```typescript
async function placeOrder(params: OrderParams) {
  const tx = buildPlaceOrderTx(params);

  // For wallet-connected users:
  const result = await suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: walletAdapter,
    options: { showEffects: true, showEvents: true },
  });

  // Extract order ID from events
  const orderPlacedEvent = result.events?.find(
    e => e.type.includes('OrderPlaced')
  );

  return {
    txDigest: result.digest,
    orderId: orderPlacedEvent?.parsedJson?.order_id,
    status: result.effects?.status,
  };
}
```

---

## 7. Known Issues & Debugging

### 7.1 expire_timestamp = 0 Fails

**Error:** `EInvalidExpireTimestamp (code 2)`
**Fix:** Always use `18446744073709551615` (max u64)

### 7.2 Balance Manager Mismatch

**Error:** `EBalanceManagerBalanceTooLow (code 3)` despite deposit
**Cause:** Using BM created with npm deepbook (0xfb28...) with OLD deepbook pool (0x2fec...)
**Fix:** Use consistent package ID for all operations

### 7.3 Pool Not Found

**Error:** Module not found
**Cause:** Wrong package ID or package not published to network
**Fix:** Verify with `sui client object <DEEPBOOK_PKG_ID> --network testnet`

### 7.4 Gas Budget Too Low

**Error:** Computation or storage error
**Fix:** Use minimum 200_000_000 MIST for order placement, 50_000_000 for simple operations

---

## 8. Testnet Reference Data

| Object | ID |
|--------|-----|
| Pool (DEEP/DUSDC) | `0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125` |
| Balance Manager | `0x7627b14590d561b37dcd3e4d5953dc3faa29f425c5f70d4acce28e46b6a13af1` |
| DEEP Token | `0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP` |
| DUSDC Token | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| OLD DeepBook | `0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27` |
| Clock | `0x6` |
| Test Wallet | `0x0cdc0f4df0284828adde270ab50db083341135562866c26404ec945597d49716` |

---

## 9. Scripts Reference

| Script | Path | Purpose |
|--------|------|---------|
| deepbook-trade.py | `scripts/deepbook-trade.py` | CLI trading examples |
| verify-trading.py | `scripts/verify-trading.py` | Verify trading state |
| sdk-trade.mjs | `packages/sdk/scripts/sdk-trade.mjs` | SDK trading examples |

---

## 10. Security Considerations

1. **Never expose private keys** - Use wallet adapters in frontend
2. **Validate all amounts** - Check balances before placing orders
3. **Handle errors gracefully** - Order placement can fail for many reasons
4. **Monitor gas fees** - Order placement uses ~0.01-0.02 SUI
5. **Use unique client_order_id** - Prevents accidental duplicate orders
6. **Verify pool addresses** - On-chain contracts can differ from expected
