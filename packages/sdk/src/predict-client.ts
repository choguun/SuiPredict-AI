import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import {
  AGENT_POLICY_PACKAGE_ID,
  CLOCK_OBJECT_ID,
  DUSDC_TREASURY_CAP_ID,
  DUSDC_TYPE,
  PLP_TYPE,
  PREDICT_OBJECT_ID,
  PREDICT_PACKAGE_ID,
  SUI_GRPC_URL,
  SUI_NETWORK,
  dollarsToDusdc,
  dollarsToStrike,
} from "./constants.js";
import type { Direction, MintParams, RedeemParams } from "./types.js";
import { getManagerForOwner } from "./predict-server.js";

export type SuiClient = SuiGrpcClient;

export interface TxResult {
  digest: string;
  effects?: unknown;
  events?: unknown;
}

export function createClient(): SuiClient {
  // R39 audit fix: was hardcoded to `"testnet"`. Now reads
  // `SUI_NETWORK` from the env (resolved in `constants.ts`),
  // so a mainnet deploy no longer silently submits every
  // agent tx — fund_pool, fund_parlay_pool, place_order,
  // prize-admin, etc. — to the testnet cluster. The
  // `SUI_GRPC_URL` constant follows the same env.
  return new SuiGrpcClient({
    network: SUI_NETWORK,
    baseUrl: SUI_GRPC_URL,
  });
}

export function keypairFromPrivateKey(privateKey: string): Ed25519Keypair {
  if (privateKey.startsWith("suiprivkey")) {
    return Ed25519Keypair.fromSecretKey(privateKey);
  }
  const hex = privateKey.startsWith("0x") ? privateKey.slice(2) : privateKey;
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(hex, "hex")));
}

export async function executeTransaction(
  client: SuiClient,
  tx: Transaction,
  signer: Ed25519Keypair,
): Promise<TxResult> {
  tx.setSender(signer.getPublicKey().toSuiAddress());
  const result = await client.signAndExecuteTransaction({
    transaction: tx,
    signer,
  });

  if (result.$kind === "FailedTransaction") {
    throw new Error(
      `Transaction failed: ${result.FailedTransaction.status.error?.message ?? "unknown"}`,
    );
  }

  const finalized = await client.waitForTransaction({
    digest: result.Transaction.digest,
    include: { effects: true, events: true },
  });

  if (finalized.$kind === "FailedTransaction") {
    throw new Error(
      `Transaction failed: ${finalized.FailedTransaction.status.error?.message ?? "unknown"}`,
    );
  }

  return {
    digest: finalized.Transaction.digest,
    effects: finalized.Transaction.effects,
    events: finalized.Transaction.events,
  };
}

export function buildCreateManagerTx(): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::create_manager`,
    arguments: [],
  });
  return tx;
}

export async function createPredictManager(
  client: SuiClient,
  signer: Ed25519Keypair,
): Promise<string> {
  const address = signer.getPublicKey().toSuiAddress();
  const existing = await getManagerForOwner(address);
  if (existing) return existing;

  await executeTransaction(client, buildCreateManagerTx(), signer);

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = await getManagerForOwner(address);
    if (id) return id;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("PredictManager not found after creation (indexer lag?)");
}

function buildMarketKey(
  tx: Transaction,
  oracleId: string,
  expiry: bigint,
  strike: bigint,
  direction: Direction,
) {
  const keyFn = direction === "up" ? "up" : "down";
  return tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::market_key::${keyFn}`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(expiry), tx.pure.u64(strike)],
  });
}

export async function mergeAndSplitDusdc(
  tx: Transaction,
  client: SuiClient,
  owner: string,
  amount: bigint,
) {
  const { objects } = await client.core.listCoins({ owner, coinType: DUSDC_TYPE });
  if (objects.length === 0) {
    throw new Error(`No DUSDC found for ${owner}`);
  }
  const total = objects.reduce((s, c) => s + BigInt(c.balance), 0n);
  if (total < amount) {
    throw new Error(
      `Insufficient DUSDC: have ${Number(total) / 1e6}, need ${Number(amount) / 1e6}`,
    );
  }
  const primary = tx.object(objects[0]!.objectId);
  if (objects.length > 1) {
    tx.mergeCoins(
      primary,
      objects.slice(1).map((c) => tx.object(c.objectId)),
    );
  }
  const [coin] = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return coin;
}

export function buildDepositTx(
  tx: Transaction,
  managerId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  depositCoin: any,
) {
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict_manager::deposit`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(managerId), depositCoin],
  });
}

export function buildMintTx(params: MintParams): Transaction {
  const tx = new Transaction();
  const strike = dollarsToStrike(params.strikeDollars);
  const quantity = dollarsToDusdc(params.quantityDollars);
  const key = buildMarketKey(
    tx,
    params.oracleId,
    params.expiry,
    strike,
    params.direction,
  );
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export async function mintPositionWithTopup(
  client: SuiClient,
  signer: Ed25519Keypair,
  params: MintParams,
) {
  const tx = new Transaction();
  const address = signer.getPublicKey().toSuiAddress();

  if (!params.skipTopup && params.topupDollars && params.topupDollars > 0) {
    const topup = dollarsToDusdc(params.topupDollars);
    const depositCoin = await mergeAndSplitDusdc(tx, client, address, topup);
    buildDepositTx(tx, params.managerId, depositCoin);
  }

  const strike = dollarsToStrike(params.strikeDollars);
  const quantity = dollarsToDusdc(params.quantityDollars);
  const key = buildMarketKey(
    tx,
    params.oracleId,
    params.expiry,
    strike,
    params.direction,
  );
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::mint`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });

  return executeTransaction(client, tx, signer);
}

export function buildRedeemTx(params: RedeemParams): Transaction {
  const tx = new Transaction();
  const strike = dollarsToStrike(params.strikeDollars);
  const quantity = dollarsToDusdc(params.quantityDollars);
  const key = buildMarketKey(
    tx,
    params.oracleId,
    params.expiry,
    strike,
    params.direction,
  );
  const target = params.permissionless
    ? `${PREDICT_PACKAGE_ID}::predict::redeem_permissionless`
    : `${PREDICT_PACKAGE_ID}::predict::redeem`;
  tx.moveCall({
    target,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      tx.object(params.managerId),
      tx.object(params.oracleId),
      key,
      tx.pure.u64(quantity),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export async function redeemPosition(
  client: SuiClient,
  signer: Ed25519Keypair,
  params: RedeemParams,
) {
  return executeTransaction(client, buildRedeemTx(params), signer);
}

export async function supplyPLP(
  client: SuiClient,
  signer: Ed25519Keypair,
  amountDollars: number,
) {
  const tx = new Transaction();
  const address = signer.getPublicKey().toSuiAddress();
  const amount = dollarsToDusdc(amountDollars);
  const supplyCoin = await mergeAndSplitDusdc(tx, client, address, amount);
  const lpCoin = tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::supply`,
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(PREDICT_OBJECT_ID), supplyCoin, tx.object(CLOCK_OBJECT_ID)],
  });
  tx.transferObjects([lpCoin], tx.pure.address(address));
  return executeTransaction(client, tx, signer);
}

export async function withdrawPLP(
  client: SuiClient,
  signer: Ed25519Keypair,
  plpCoinId: string,
  amountDollars: number,
) {
  const tx = new Transaction();
  const address = signer.getPublicKey().toSuiAddress();
  const amount = dollarsToDusdc(amountDollars);
  const plpCoin = tx.object(plpCoinId);
  const [withdrawCoin] = tx.splitCoins(plpCoin, [tx.pure.u64(amount)]);
  tx.moveCall({
    target: `${PREDICT_PACKAGE_ID}::predict::withdraw`,
    typeArguments: [DUSDC_TYPE],
    arguments: [
      tx.object(PREDICT_OBJECT_ID),
      withdrawCoin,
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  tx.transferObjects([plpCoin], tx.pure.address(address));
  return executeTransaction(client, tx, signer);
}

export function buildCreatePolicyTx(
  agentAddress: string,
  maxBudgetDollars: number,
  expiryMs: bigint,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  if (!packageId) {
    throw new Error("AGENT_POLICY_PACKAGE_ID not set");
  }
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::create_policy`,
    arguments: [
      tx.pure.address(agentAddress),
      tx.pure.u64(dollarsToDusdc(maxBudgetDollars)),
      tx.pure.u64(expiryMs),
    ],
  });
  return tx;
}

export function buildRevokePolicyTx(
  policyId: string,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::revoke`,
    arguments: [tx.object(policyId)],
  });
  return tx;
}

export function buildPausePolicyTx(
  policyId: string,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::pause`,
    arguments: [tx.object(policyId)],
  });
  return tx;
}

/**
 * Build `unpause` transaction. Owner-only counterpart to
 * `buildPausePolicyTx` — the on-chain `unpause` asserts
 * `ctx.sender() == policy.owner` (pause also allows the agent,
 * unpause does not). Aborts with `ENotOwner` for any non-owner caller.
 */
export function buildUnpausePolicyTx(
  policyId: string,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::unpause`,
    arguments: [tx.object(policyId)],
  });
  return tx;
}

export function buildAuthorizeSpendTx(
  policyId: string,
  amountDollars: number,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::authorize_spend`,
    arguments: [
      tx.object(policyId),
      tx.pure.u64(dollarsToDusdc(amountDollars)),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export function buildLogActionTx(
  policyId: string,
  action: string,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::agent_policy::log_action`,
    arguments: [
      tx.object(policyId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(action))),
      tx.object(CLOCK_OBJECT_ID),
    ],
  });
  return tx;
}

export async function getDusdcBalance(
  client: SuiClient,
  owner: string,
): Promise<bigint> {
  const { objects } = await client.core.listCoins({ owner, coinType: DUSDC_TYPE });
  return objects.reduce((sum, c) => sum + BigInt(c.balance), 0n);
}

export async function getPlpCoins(client: SuiClient, owner: string) {
  const { objects } = await client.core.listCoins({ owner, coinType: PLP_TYPE });
  return objects;
}

export async function getPolicyState(
  client: SuiClient,
  policyId: string,
  packageId = AGENT_POLICY_PACKAGE_ID,
): Promise<import("./types.js").AgentPolicyState | null> {
  try {
    const { object } = await client.core.getObject({
      objectId: policyId,
      include: { json: true },
    });
    const fields = object.json;
    if (!fields || !object.type.includes(`${packageId}::agent_policy::AgentPolicy`)) {
      return null;
    }
    return {
      policy_id: policyId,
      owner: fields.owner as string,
      agent: fields.agent as string,
      max_budget: Number(fields.max_budget),
      spent: Number(fields.spent),
      expires_at: Number(fields.expires_at),
      revoked: fields.revoked as boolean,
      paused: fields.paused as boolean,
    };
  } catch {
    return null;
  }
}

export async function extractCreatedObjectId(
  client: SuiClient,
  digest: string,
  structSuffix: string,
): Promise<string | null> {
  const result = await client.waitForTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });
  if (result.$kind !== "Transaction") return null;
  const effects = result.Transaction.effects;
  const types = result.Transaction.objectTypes ?? {};
  if (!effects) return null;

  for (const change of effects.changedObjects) {
    if (
      change.idOperation === "Created" &&
      types[change.objectId]?.includes(structSuffix)
    ) {
      return change.objectId;
    }
  }
  return null;
}

export async function mintDusdcFromTreasury(
  client: SuiClient,
  signer: Ed25519Keypair,
  amountDollars: number,
) {
  const tx = new Transaction();
  const address = signer.getPublicKey().toSuiAddress();
  const amount = dollarsToDusdc(amountDollars);
  const coin = tx.moveCall({
    target: "0x2::coin::mint",
    typeArguments: [DUSDC_TYPE],
    arguments: [tx.object(DUSDC_TREASURY_CAP_ID), tx.pure.u64(amount)],
  });
  tx.transferObjects([coin], tx.pure.address(address));
  return executeTransaction(client, tx, signer);
}
