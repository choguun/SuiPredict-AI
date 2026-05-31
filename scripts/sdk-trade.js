/**
 * SDK Trading Script - Using our own pool and coins
 * 
 * Uses:
 * - Our pool: 0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125 (DEEP/DUSDC)
 * - Our DEEP: 0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP
 * - Our DUSDC: 0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC
 * - Our deepbook: 0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27
 */

import { SuiGrpcClient } from '../../node_modules/@mysten/sui/grpc/index.js';
import { Ed25519Keypair } from '../../node_modules/@mysten/sui/keypairs/ed25519/index.js';
import { Transaction } from '../../node_modules/@mysten/sui/transactions/index.js';
import { DeepBookClient, OrderType, SelfMatchingOptions } from '../../node_modules/@mysten/deepbook-v3/dist/index.mjs';

// Configuration
const NETWORK = 'testnet';
const SUI_GRPC_URL = 'https://fullnode.testnet.sui.io:443';

// Our addresses
const PRIVATE_KEY = process.env.SUI_PRIVATE_KEY;
const DEEPBOOK_PKG = '0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27';
const REGISTRY = '0x25c9b47c21ec2ee481824d0dee3cd3ebb903fb92e177508071433d06281e3541';
const POOL_ID = '0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125';
const CLOCK = '0x6';

// Our coin types
const DEEP_TYPE = '0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP';
const DUSDC_TYPE = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';

// Pool key
const OUR_POOL_KEY = 'OUR_DEEP_DUSDC';

async function main() {
  console.log('='.repeat(60));
  console.log('DeepBook Trading Script');
  console.log('='.repeat(60));
  
  if (!PRIVATE_KEY) {
    console.error('Error: SUI_PRIVATE_KEY environment variable not set');
    process.exit(1);
  }
  
  // 1. Setup client and signer
  const client = new SuiGrpcClient({ network: NETWORK, baseUrl: SUI_GRPC_URL });
  const keypair = Ed25519Keypair.fromSecretKey(PRIVATE_KEY);
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`\nWallet: ${address}`);
  
  // 2. Create DeepBookClient with custom config for our pool
  const dbClient = new DeepBookClient({
    client,
    address,
    network: NETWORK,
    balanceManagers: {},
    coins: {
      DEEP: {
        address: DEEP_TYPE.split('::')[0],
        type: DEEP_TYPE,
        scalar: 1e6,
      },
      DUSDC: {
        address: DUSDC_TYPE.split('::')[0],
        type: DUSDC_TYPE,
        scalar: 1e6,
      },
    },
    pools: {
      [OUR_POOL_KEY]: {
        address: POOL_ID,
        baseCoin: 'DEEP',
        quoteCoin: 'DUSDC',
      },
    },
  });
  console.log('DeepBookClient initialized with custom config');
  
  // 3. Check our DEEP balance
  console.log('\n--- Checking DEEP Balance ---');
  const deepCoins = await client.getCoins({ owner: address, coinType: DEEP_TYPE });
  console.log(`DEEP coins: ${deepCoins.data.length}`);
  let totalDeep = 0n;
  for (const coin of deepCoins.data) {
    console.log(`  ${coin.coinObjectId}: ${Number(coin.balance) / 1e6} DEEP`);
    totalDeep += BigInt(coin.balance);
  }
  console.log(`Total DEEP: ${Number(totalDeep) / 1e6}`);
  
  // 4. Create Balance Manager
  console.log('\n--- Creating Balance Manager ---');
  const createTx = new Transaction();
  const manager = dbClient.balanceManager.createAndShareBalanceManager()(createTx);
  createTx.setSender(address);
  
  const createResult = await client.signAndExecuteTransaction({
    transaction: createTx,
    signer: keypair,
  });
  
  if (createResult.$kind === 'FailedTransaction') {
    console.error('Failed to create balance manager:', createResult.FailedTransaction.status.error);
    process.exit(1);
  }
  
  console.log(`TX: ${createResult.Transaction.digest}`);
  
  // Extract balance manager ID
  const effects = createResult.Transaction.effects;
  let managerId = null;
  if (effects?.$kind === 'Effects') {
    for (const created of effects.Effects.created || []) {
      if (created.owner?.$kind === 'Shared') {
        managerId = created.reference.objectId;
        console.log(`Balance Manager ID: ${managerId}`);
      }
    }
  }
  
  if (!managerId) {
    console.error('Could not find Balance Manager ID');
    process.exit(1);
  }
  
  // 5. Deposit DEEP into Balance Manager
  if (deepCoins.data.length === 0) {
    console.error('No DEEP coins to deposit');
    process.exit(1);
  }
  
  console.log('\n--- Depositing DEEP into Balance Manager ---');
  const deepCoinId = deepCoins.data[0].coinObjectId;
  const depositAmount = Math.min(Number(deepCoins.data[0].balance), 500_000_000n); // Up to 500 DEEP
  
  const depositTx = new Transaction();
  dbClient.balanceManager.depositIntoManager(OUR_POOL_KEY, 'DEEP', depositAmount)(depositTx);
  depositTx.setSender(address);
  
  const depositResult = await client.signAndExecuteTransaction({
    transaction: depositTx,
    signer: keypair,
  });
  
  if (depositResult.$kind === 'FailedTransaction') {
    console.error('Failed to deposit:', depositResult.FailedTransaction.status.error);
    process.exit(1);
  }
  
  console.log(`Deposit TX: ${depositResult.Transaction.digest}`);
  console.log(`Deposited ${depositAmount / 1e6} DEEP`);
  
  // 6. Place a limit order (SELL DEEP for DUSDC)
  console.log('\n--- Placing Limit Order (SELL DEEP) ---');
  
  const placeOrderTx = new Transaction();
  dbClient.deepBook.placeLimitOrder({
    poolKey: OUR_POOL_KEY,
    balanceManagerKey: OUR_POOL_KEY,
    clientOrderId: BigInt(Date.now()),
    price: 0.5, // 0.5 DUSDC per DEEP (we want to sell)
    quantity: 10, // 10 DEEP
    isBid: false, // ASK - selling DEEP
    expiration: BigInt(Math.floor(Date.now() / 1000) + 3600), // 1 hour
    orderType: OrderType.NO_RESTRICTION,
    selfMatchingOption: SelfMatchingOptions.SELF_MATCHING_ALLOWED,
    payWithDeep: true, // Pay fees with DEEP
  })(placeOrderTx);
  
  placeOrderTx.setSender(address);
  
  const orderResult = await client.signAndExecuteTransaction({
    transaction: placeOrderTx,
    signer: keypair,
  });
  
  if (orderResult.$kind === 'FailedTransaction') {
    console.error('Failed to place order:', orderResult.FailedTransaction.status.error);
    process.exit(1);
  }
  
  console.log(`Order TX: ${orderResult.Transaction.digest}`);
  console.log('SUCCESS! Order placed');
  
  console.log('\n' + '='.repeat(60));
  console.log('Trading complete!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
