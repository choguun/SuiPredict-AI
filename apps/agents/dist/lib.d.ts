import { createClient, pickAtmStrike, type SuiClient } from "@suipredict/sdk";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
export declare function getSharedJsonRpcClient(): SuiJsonRpcClient;
export declare function resetSharedJsonRpcClient(): void;
export declare function safeInt(v: string | undefined, fallback: number, min?: number, max?: number): number;
export declare function safeFloat(v: string | undefined, fallback: number, min?: number, max?: number): number;
export declare function safeBigInt(v: string | undefined, fallback: bigint): bigint;
export interface AgentContext {
    signer: Ed25519Keypair;
    managerId: string;
    policyId?: string;
    maxBudgetUsdc: number;
}
export interface AgentResult {
    action: string;
    reasoning: string;
    confidence?: number;
    txDigest?: string;
}
export declare function callLlm(prompt: string): Promise<string | null>;
export declare function recordResult(agent: string, result: AgentResult): AgentResult;
export { createClient, pickAtmStrike };
export declare function getSharedClient(): SuiClient;
export declare function closeSharedClient(): Promise<void>;
export declare function retryQuery<T>(tag: string, fn: () => Promise<T>, maxRetry?: number): Promise<T>;
//# sourceMappingURL=lib.d.ts.map