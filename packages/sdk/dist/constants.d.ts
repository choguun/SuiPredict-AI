/** DeepBook Predict testnet deployment — predict-testnet-4-16 branch */
export declare const NETWORK: "testnet";
declare function resolvePredictServerUrl(): string;
export declare const PREDICT_SERVER_URL: string;
export { resolvePredictServerUrl };
export declare const PREDICT_PACKAGE_ID: string;
export declare const PREDICT_REGISTRY_ID: string;
export declare const PREDICT_OBJECT_ID: string;
export declare const DUSDC_PACKAGE_ID: string;
export declare const DUSDC_TYPE: string;
export declare const PLP_TYPE: string;
export declare const DUSDC_TREASURY_CAP_ID: string;
export declare function resolveDusdcTreasuryCapId(): string;
export declare function resolvePredictPackageId(): string;
export declare function resolvePredictRegistryId(): string;
export declare function resolvePredictObjectId(): string;
export declare function resolveDusdcPackageId(): string;
export declare function resolveAgentPolicyPackageId(): string;
export declare function resolveFeeVaultId(): string;
export declare function resolveReferralTreasuryAddress(): string;
export declare const CLOCK_OBJECT_ID = "0x6";
export declare const PRICE_SCALE = 1000000000n;
export declare const DUSDC_SCALE = 1000000n;
/**
 * Published `agent_policy` package ID (the package that also contains
 * `streak_system`, `prize_pool`, `prediction_market`, `types`).
 *
 * Set via env at deploy time:
 *   AGENT_POLICY_PACKAGE_ID=0x...
 *
 * The default below is the *currently-deployed* testnet address from
 * `packages/contracts/Published.toml`. If the env var is unset and
 * you've re-published the package, update this default (and re-run
 * the agents bootstrap to write `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID`
 * to `apps/web/.env.local`).
 */
export declare const AGENT_POLICY_PACKAGE_ID: string;
export declare const SUI_GRPC_URL: string;
export declare const SUI_NETWORK: "testnet" | "mainnet" | "devnet";
export declare function dollarsToStrike(dollars: number | bigint): bigint;
export declare function dollarsToDusdc(dollars: number | bigint): bigint;
export declare function strikeToDollars(strike: bigint): number;
export declare function dusdcToDollars(amount: bigint): number;
//# sourceMappingURL=constants.d.ts.map