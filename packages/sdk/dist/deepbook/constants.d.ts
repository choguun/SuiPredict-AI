/** DeepBook V3 testnet constants */
export declare const DEEPBOOK_PACKAGE_ID: string;
export declare const DEEPBOOK_REGISTRY_ID: string;
export declare function resolveDeepbookPackageId(): string;
export declare function resolveDeepbookRegistryId(): string;
export { DBUSDC_TYPE } from "../markets/constants.js";
/**
 * DEEP coin type. Two flavors exist on testnet:
 *   - Mysten Labs `0x36dbef…::deep::DEEP` (the default)
 *   - Self-hosted `DEEP` deployed by `scripts/deploy/deploy-self-hosted-v2.py`
 * The self-hosted token is what `market-creator` actually uses to seed
 * the DeepBook pool. If the env var is set, prefer it; otherwise fall
 * back to the Mysten Labs address. The market-creator's DEEP-coin
 * filter uses this constant — set `NEXT_PUBLIC_DEEP_TYPE` to the
 * self-hosted address in your web .env.local to make market creation
 * work on a self-hosted deploy.
 */
export declare const DEEP_TYPE: string;
export declare function resolveDeepType(): string;
export declare const VLP_TYPE: string;
export declare const POOL_SUI_DBUSDC = "SUI_DBUSDC";
export declare const POOL_DEEP_DBUSDC = "DEEP_DBUSDC";
export declare const POOL_CREATION_FEE_DEEP = 500000000n;
//# sourceMappingURL=constants.d.ts.map