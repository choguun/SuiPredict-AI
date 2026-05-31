/**
 * SDK Trading Script - Place limit order on DeepBook
 * 
 * Uses:
 * - Our pool: 0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125 (DEEP/DUSDC)
 * - Our DEEP: 0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP
 * - Our DUSDC: 0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC
 * - Our deepbook: 0x2fec08edf5a0c605aef9eb2160246ac2b29d3296f1ce62d08b478d411d654a27
 * 
 * Balance Manager (OLD deepbook): 0x7627b14590d561b37dcd3e4d5953dc3faa29f425c5f70d4acce28e46b6a13af1
 * (Created via OLD deepbook, 90B DEEP deposited)
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import { DeepBookClient, OrderType, SelfMatchingOptions } from '@mysten/deepbook-v3';

// Configuration
const NETWORK = 'testnet';
const PRIVATE_KEY = process.env.SUI_PRIVATE_KEY;
const DEEP_TYPE = '0x6bddac566309828f13c34fcba5b48f080fd6b02d64bdfb1525b912d47d0c5104::deep::DEEP';
const DUSDC_TYPE = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
const POOL_ID = '0xbfa0580443cab0876c11520b519f37de7e04dba5ad6dc28a3e6d74ca1495d125';
const BALANCE_MANAGER = '0x7627b14590d561b37dcd3e4d5953dc3faa29f425c5f70d4acce28e46b6a13af1';
const OUR_POOL_KEY = 'DEEP_DUSDC';

async function main() {
  console.log('=' * 60);
  console.log('DeepBook SDK Trading Script');
  console.log('=' * 60);

  // Initialize client
  const client = new SuiGrpcClient({ network: NETWORK });
  const keypair = Ed25519Keypair.fromSuiPrivateKey(PRIVATE_KEY);
  const address = keypair.getPublicKey().toSuiAddress();
  console.log(`Wallet: ${address}`);

  // Create DeepBookClient with our config
  const dbClient = new DeepBookClient({
    client,
    address,
    network: NETWORK,
    balanceManagers: {
      [OUR_POOL_KEY]: { address: BALANCE_MANAGER },
    },
    coins: {
      DEEP: { address: DEEP_TYPE.split('::')[0], type: DEEP_TYPE, scalar: 1e6 },
      DUSDC: { address: DUSDC_TYPE.split('::')[0], type: DUSDC_TYPE, scalar: 1e6 },
    },
    pools: {
      [OUR_POOL_KEY]: { address: POOL_ID, baseCoin: 'DEEP', quoteCoin: 'DUSDC' },
    },
  });
  console.log('DeepBookClient initialized');
  console.log(`Balance Manager: ${BALANCE_MANAGER}`);

  // Place limit order using SDK
  console.log('\n--- Placing Limit Order (SELL 1 DEEP @ 1 DUSDC) ---');
  
  const orderTx = new Transaction();
  
  dbClient.pool.placeLimitOrder(
    OUR_POOL_KEY,
    'DEEP',
    'DUSDC',
    1,  // side: 1 = ask (sell)
    1000000,  // price: 1 DUSDC per DEEP
    1000000,  // quantity: 1 DEEP
    OrderType.NO_FEE,  // order type
    SelfMatchingOptions.CANCEL_TAKER,  // self matching option
    0,  // expire timestamp
    false,  // pay with deep
    undefined,  // client order id (optional)
  )(orderTx);
  
  orderTx.setSender(address);
  
  try {
    const result = await client.signAndExecuteTransaction({
      transaction: orderTx,
      signer: keypair,
    });
    
    console.log('Order TX:', result.digest);
    
    if (result.effects?.status?.status === 'success') {
      console.log('SUCCESS: Limit order placed!');
    } else {
      console.log('Order failed:', JSON.stringify(result.effects?.status, null, 2));
    }
  } catch (err) {
    console.error('Order error:', err.message);
  }
}

main().catch(console.error);
