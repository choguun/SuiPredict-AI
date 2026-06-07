import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import type { MintParams, RedeemParams } from "./types.js";
export type SuiClient = SuiGrpcClient;
export interface TxResult {
    digest: string;
    effects?: unknown;
    events?: unknown;
}
export declare function createClient(): SuiClient;
export declare function getSharedClient(): SuiClient;
export declare function resetSharedClient(): void;
/**
 * R54 audit fix: typed `closeClient` wrapper. The agents'
 * `lib.ts` previously did `(client as any).close?.()` because
 * `SuiClient = SuiGrpcClient` doesn't declare `close()` in its
 * public type — the `as any` cast is fragile and bypasses type
 * safety. A future `@mysten/sui` SDK bump that renames `close()`
 * to `destroy()` would break the agents' shutdown handler
 * silently. The single typed escape hatch lives here; callers
 * stay free of `as any`.
 */
export declare function closeClient(c: SuiClient): Promise<void>;
export declare function keypairFromPrivateKey(privateKey: string): Ed25519Keypair;
export declare function executeTransaction(client: SuiClient, tx: Transaction, signer: Ed25519Keypair, options?: {
    maxRetry?: number;
}): Promise<TxResult>;
export declare function buildCreateManagerTx(): Transaction;
export declare function createPredictManager(client: SuiClient, signer: Ed25519Keypair): Promise<string>;
export declare function mergeAndSplitDusdc(tx: Transaction, client: SuiClient, owner: string, amount: bigint): Promise<{
    NestedResult: [number, number];
    $kind: "NestedResult";
}>;
export declare function buildDepositTx(tx: Transaction, managerId: string, depositCoin: any): void;
export declare function buildMintTx(params: MintParams): Transaction;
export declare function mintPositionWithTopup(client: SuiClient, signer: Ed25519Keypair, params: MintParams): Promise<TxResult>;
export declare function buildRedeemTx(params: RedeemParams): Transaction;
export declare function redeemPosition(client: SuiClient, signer: Ed25519Keypair, params: RedeemParams): Promise<TxResult>;
export declare function supplyPLP(client: SuiClient, signer: Ed25519Keypair, amountDollars: number): Promise<TxResult>;
export declare function withdrawPLP(client: SuiClient, signer: Ed25519Keypair, plpCoinId: string, amountDollars: number): Promise<TxResult>;
export declare function buildCreatePolicyTx(agentAddress: string, maxBudgetDollars: number, expiryMs: bigint, packageId?: string): Transaction;
export declare function buildRevokePolicyTx(policyId: string, packageId?: string): Transaction;
export declare function buildPausePolicyTx(policyId: string, packageId?: string): Transaction;
/**
 * Build `unpause` transaction. Owner-only counterpart to
 * `buildPausePolicyTx` — the on-chain `unpause` asserts
 * `ctx.sender() == policy.owner` (pause also allows the agent,
 * unpause does not). Aborts with `ENotOwner` for any non-owner caller.
 */
export declare function buildUnpausePolicyTx(policyId: string, packageId?: string): Transaction;
export declare function buildAuthorizeSpendTx(policyId: string, amountDollars: number, packageId?: string): Transaction;
export declare function buildLogActionTx(policyId: string, action: string, packageId?: string): Transaction;
export declare function getDusdcBalance(client: SuiClient, owner: string): Promise<bigint>;
export declare function getPlpCoins(client: SuiClient, owner: string): Promise<any[]>;
export declare function getPolicyState(client: SuiClient, policyId: string, packageId?: string): Promise<import("./types.js").AgentPolicyState | null>;
export declare function extractCreatedObjectId(client: SuiClient, digest: string, structSuffix: string): Promise<string | null>;
export declare function mintDusdcFromTreasury(client: SuiClient, signer: Ed25519Keypair, amountDollars: number): Promise<TxResult>;
//# sourceMappingURL=predict-client.d.ts.map