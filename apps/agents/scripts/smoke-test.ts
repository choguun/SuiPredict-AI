#!/usr/bin/env tsx
/**
 * End-to-end smoke test.
 *
 * Runs two flows:
 *   1. Legacy "predict" manager + dUSDC mint (kept for backwards
 *      compatibility with the old DeepBook Predict path).
 *   2. Modern prediction-market CLOB: create market → mint YES+NO →
 *      create DeepBook BalanceManager → deposit → place limit order.
 *
 * Exits non-zero on any hard failure. Soft failures (a flow is
 * skipped because an optional env var is unset, or the chain
 * doesn't have a fixture oracle) print a clear `WARN:` and let the
 * rest of the script run.
 *
 * Required env (loaded via dotenv):
 *   AGENT_PRIVATE_KEY            — ed25519 secret of the test signer
 *
 * Optional env (skips that step if unset):
 *   AGENT_MANAGER_ID             — reuse an existing predict manager
 *   PREDICT_MARKET_PACKAGE_ID    — required for the CLOB flow
 *   NEXT_PUBLIC_FEE_VAULT_ID     — required for the CLOB mint
 *   NEXT_PUBLIC_DEEPBOOK_POOL_ID — required to place a CLOB order
 *   BALANCE_MANAGER_ID           — reuse an existing CLOB manager
 *
 * Network is selected via SUI_NETWORK (default "testnet").
 */
import "dotenv/config";
import {
  createPredictManager,
  createClient,
  findNearestActiveOracle,
  getStatus,
  keypairFromPrivateKey,
  mintDusdcFromTreasury,
  mintPositionWithTopup,
  pickAtmStrike,
  buildCreateMarketTx,
  buildMintSharesTx,
  buildDeepBookCreateBalanceManagerTx,
  buildDeepBookDepositTx,
  buildDeepBookPlaceLimitOrderTx,
  createPredictionDeepBookClient,
  DEEP_TYPE,
  DUSDC_TYPE,
  executeTransaction,
  extractCreatedObjectId,
} from "@suipredict/sdk";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";

interface Flow {
  name: string;
  ok: boolean;
  detail: string;
}

const results: Flow[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`  [${tag}] ${name}: ${detail}`);
}

function warn(name: string, detail: string): void {
  results.push({ name, ok: true, detail: `WARN: ${detail}` });
  console.log(`  [warn] ${name}: ${detail}`);
}

async function getSigner(): Promise<Ed25519Keypair> {
  if (process.env.AGENT_PRIVATE_KEY) {
    return keypairFromPrivateKey(process.env.AGENT_PRIVATE_KEY);
  }
  return new Ed25519Keypair();
}

async function legacyPredictFlow(
  signer: Ed25519Keypair,
  client: ReturnType<typeof createClient>,
): Promise<void> {
  console.log("\n── Legacy predict flow ──");
  const address = signer.getPublicKey().toSuiAddress();
  console.log(`Signer: ${address}`);

  const status = await getStatus();
  console.log(`predict-server: ${status.status}`);

  let managerId = process.env.AGENT_MANAGER_ID;
  if (!managerId) {
    console.log("\n1. Creating PredictManager...");
    try {
      managerId = await createPredictManager(client, signer);
      record("predict_manager_create", true, `MANAGER_ID=${managerId}`);
    } catch (err) {
      record(
        "predict_manager_create",
        false,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  } else {
    console.log(`\n1. Using existing manager: ${managerId}`);
    record("predict_manager_reuse", true, managerId);
  }

  try {
    console.log("\n2. Minting 10 dUSDC from treasury...");
    await mintDusdcFromTreasury(client, signer, 10);
    record("dusdc_mint", true, "10 dUSDC minted");
  } catch (err) {
    warn("dusdc_mint", err instanceof Error ? err.message : String(err));
  }

  const oracle = await findNearestActiveOracle();
  if (!oracle) {
    warn("oracle", "No active oracles — skipping strike + position steps");
    return;
  }

  console.log(`\n3. Active oracle: ${oracle.underlying_asset} expiry ${new Date(oracle.expiry).toISOString()}`);

  const strike = await pickAtmStrike(
    oracle.oracle_id,
    oracle.min_strike,
    oracle.tick_size,
  );
  record("strike_pick", true, `atm $${strike}`);

  console.log(`\n4. Minting $1 UP position @ $${strike}...`);
  try {
    const result = await mintPositionWithTopup(client, signer, {
      managerId: managerId!,
      oracleId: oracle.oracle_id,
      expiry: BigInt(oracle.expiry),
      strikeDollars: strike,
      direction: "up",
      quantityDollars: 1,
      topupDollars: 2,
    });
    record("position_mint", true, `digest ${result.digest}`);
  } catch (err) {
    record(
      "position_mint",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function clobFlow(
  signer: Ed25519Keypair,
  txClient: ReturnType<typeof createClient>,
): Promise<void> {
  console.log("\n── Prediction-market CLOB flow ──");
  const pkg = process.env.PREDICT_MARKET_PACKAGE_ID ?? process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID;
  const vaultId =
    process.env.NEXT_PUBLIC_FEE_VAULT_ID ?? process.env.FEE_VAULT_ID;
  const poolId =
    process.env.NEXT_PUBLIC_DEEPBOOK_POOL_ID ?? process.env.DEEPBOOK_POOL_ID;
  const poolKey =
    process.env.NEXT_PUBLIC_DEEPBOOK_POOL_KEY ?? "PREDICT_YES_DUSDC";
  const yesCoinType = process.env.NEXT_PUBLIC_DEEPBOOK_YES_COIN_TYPE;
  const address = signer.getPublicKey().toSuiAddress();

  if (!pkg || !vaultId || !poolId || !yesCoinType) {
    warn(
      "clob_env",
      "Missing PREDICT_MARKET_PACKAGE_ID / FEE_VAULT_ID / DEEPBOOK_POOL_ID / DEEPBOOK_YES_COIN_TYPE — skipping CLOB flow",
    );
    return;
  }

  // 1. Create market (requires 500 DEEP for pool creation)
  console.log("\n1. Creating prediction market + DeepBook pool...");
  const network = (process.env.SUI_NETWORK ?? "testnet") as
    | "testnet"
    | "mainnet"
    | "devnet"
    | "localnet";
  const rpc = new SuiJsonRpcClient({
    url: getJsonRpcFullnodeUrl(network),
    network,
  });
  const { data: deepCoins } = await rpc.getCoins({
    owner: address,
    coinType: DEEP_TYPE,
  });
  const deepCoin = deepCoins.find(
    (c) => BigInt(c.balance) >= 500_000_000n,
  );
  if (!deepCoin) {
    warn(
      "clob_create_market",
      `No DEEP coin >= 500 in ${address} — skipping market creation; cannot test CLOB end-to-end.`,
    );
    return;
  }
  const expiryMs = BigInt(Date.now() + 7 * 86_400_000);
  let marketId: string;
  try {
    const createTx = buildCreateMarketTx({
      title: "smoke-test market — will resolve in 7d",
      resolutionSource: "smoke-test",
      expiryMs,
      tickSize: 1_000_000n,
      lotSize: 1_000_000n,
      minSize: 1_000_000n,
      deepCoinId: deepCoin.coinObjectId,
    });
    const createResult = await executeTransaction(txClient, createTx, signer);
    const id = await extractCreatedObjectId(
      txClient,
      createResult.digest,
      "PredictionMarket",
    );
    if (!id) throw new Error("PredictionMarket object not found in effects");
    marketId = id;
    record("clob_create_market", true, `market ${marketId.slice(0, 10)}…`);
  } catch (err) {
    record(
      "clob_create_market",
      false,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // 2. Mint YES+NO (requires DUSDC coin)
  console.log("\n2. Minting YES+NO shares...");
  const { data: dusdcCoins } = await rpc.getCoins({
    owner: address,
    coinType: DUSDC_TYPE,
  });
  const dusdcCoin = dusdcCoins
    .filter((c) => BigInt(c.balance) >= 1_000_000n)
    .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1))[0];
  if (!dusdcCoin) {
    record("clob_mint_shares", false, "No DUSDC >= 1 — skipping rest of CLOB flow");
    return;
  }
  try {
    const mintTx = buildMintSharesTx(marketId, vaultId, dusdcCoin.coinObjectId);
    const r = await executeTransaction(txClient, mintTx, signer);
    record("clob_mint_shares", true, `digest ${r.digest.slice(0, 12)}…`);
  } catch (err) {
    record(
      "clob_mint_shares",
      false,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // 3. Create or reuse BalanceManager
  console.log("\n3. Setting up DeepBook BalanceManager...");
  let managerId = process.env.BALANCE_MANAGER_ID ?? "";
  if (!managerId) {
    try {
      const dbClient = createPredictionDeepBookClient({
        client: txClient,
        address,
        market: {
          poolKey,
          poolId,
          baseCoinType: yesCoinType as `${string}::${string}::${string}`,
          quoteCoinType: DUSDC_TYPE,
          baseScalar: 1_000_000,
          quoteScalar: 1_000_000,
        },
      });
      const mgrTx = buildDeepBookCreateBalanceManagerTx(dbClient, address);
      const r = await executeTransaction(txClient, mgrTx, signer);
      const id = await extractCreatedObjectId(
        txClient,
        r.digest,
        "balance_manager::BalanceManager",
      );
      if (!id) throw new Error("BalanceManager object not found");
      managerId = id;
      record("clob_balance_manager_create", true, id);
    } catch (err) {
      record(
        "clob_balance_manager_create",
        false,
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
  } else {
    record("clob_balance_manager_reuse", true, managerId);
  }

  // 4. Deposit DUSDC to BalanceManager
  console.log("\n4. Depositing 1 DUSDC to BalanceManager...");
  try {
    const dbClient = createPredictionDeepBookClient({
      client: txClient,
      address,
      balanceManagerId: managerId,
      market: {
        poolKey,
        poolId,
        baseCoinType: yesCoinType as `${string}::${string}::${string}`,
        quoteCoinType: DUSDC_TYPE,
        baseScalar: 1_000_000,
        quoteScalar: 1_000_000,
      },
    });
    const depTx = buildDeepBookDepositTx(dbClient, "DUSDC", 1);
    const r = await executeTransaction(txClient, depTx, signer);
    record("clob_deposit", true, `digest ${r.digest.slice(0, 12)}…`);
  } catch (err) {
    record(
      "clob_deposit",
      false,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  // 5. Place a limit order
  console.log("\n5. Placing bid for 1 YES @ 0.50...");
  try {
    const dbClient = createPredictionDeepBookClient({
      client: txClient,
      address,
      balanceManagerId: managerId,
      market: {
        poolKey,
        poolId,
        baseCoinType: yesCoinType as `${string}::${string}::${string}`,
        quoteCoinType: DUSDC_TYPE,
        baseScalar: 1_000_000,
        quoteScalar: 1_000_000,
      },
    });
    const orderTx = buildDeepBookPlaceLimitOrderTx(dbClient, {
      poolKey,
      clientOrderId: String(Date.now()),
      price: 0.5,
      quantity: 1,
      isBid: true,
    });
    const r = await executeTransaction(txClient, orderTx, signer);
    record("clob_place_order", true, `digest ${r.digest.slice(0, 12)}…`);
  } catch (err) {
    record(
      "clob_place_order",
      false,
      err instanceof Error ? err.message : String(err),
    );
  }
}

async function main() {
  console.log("=== SuiPredict-AI Smoke Test ===\n");

  const client = createClient();
  const signer = await getSigner();
  const address = signer.getPublicKey().toSuiAddress();
  console.log(`Signer: ${address}`);

  await legacyPredictFlow(signer, client);
  await clobFlow(signer, client);

  // Summary
  console.log("\n=== Summary ===");
  const hardFails = results.filter((r) => !r.ok);
  for (const r of results) {
    const tag = r.ok && r.detail.startsWith("WARN:") ? "warn" : r.ok ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.name}: ${r.detail}`);
  }
  console.log(
    `\n${results.length - hardFails.length}/${results.length} steps passed (${hardFails.length} hard failures)`,
  );

  if (hardFails.length > 0) {
    console.error(`\nSmoke test FAILED: ${hardFails.length} hard failure(s).`);
    process.exit(1);
  }
  console.log("\nSmoke test complete.");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
