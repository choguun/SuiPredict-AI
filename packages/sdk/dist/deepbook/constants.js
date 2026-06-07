/** DeepBook V3 testnet constants */
// R47 audit fix: both `DEEPBOOK_PACKAGE_ID` and
// `DEEPBOOK_REGISTRY_ID` were hardcoded testnet addresses
// with no env override. R46 added the equivalent guard
// for `DUSDC_TREASURY_CAP_ID` / `PREDICT_REGISTRY_ID` but
// missed this pair. A mainnet deploy with a different
// DeepBook package / registry would silently route every
// `create_market` PTB (which uses `DEEPBOOK_REGISTRY_ID`
// as a `tx.object()`) and every balance-manager call
// (which uses `DEEPBOOK_PACKAGE_ID` as a `moveCall`
// target) to the testnet address and abort with
// `package object not found`. Resolve from
// `NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID` /
// `NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID` with a hardcoded
// testnet default for devnet/testnet/localnet. The
// mainnet guard in `constants.ts:assertMainnetHasExplicitIds`
// also lists both env vars so a misconfigured mainnet
// build crashes early with a readable error.
export const DEEPBOOK_PACKAGE_ID = (process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID ??
    process.env.DEEPBOOK_PACKAGE_ID ??
    "").trim();
export const DEEPBOOK_REGISTRY_ID = (process.env.NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID ??
    process.env.DEEPBOOK_REGISTRY_ID ??
    "").trim();
// R55 audit fix: call-time getters parallel to the consts above.
// Mirrors `resolveDusdcTreasuryCapId()` in `constants.ts` (R54).
// The agents' `bootstrap-env.ts` hot-patches these env vars
// after the SDK is imported; reading via the getter picks up
// the new value on the next call.
export function resolveDeepbookPackageId() {
    return (process.env.NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID ??
        process.env.DEEPBOOK_PACKAGE_ID ??
        "").trim();
}
export function resolveDeepbookRegistryId() {
    return (process.env.NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID ??
        process.env.DEEPBOOK_REGISTRY_ID ??
        "").trim();
}
// R57.11 audit fix: re-export from the canonical source in
// `markets/constants.ts` so a future redployment of the dUSDC
// contract only needs one edit.
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
// R47 audit fix: `.trim()` the env-chain. R41 added
// `.trim()` to `DUSDC_PACKAGE_ID` / `AGENT_POLICY_PACKAGE_ID`
// in `constants.ts` but missed the `DEEP_TYPE` chain
// here. A whitespace-suffixed `NEXT_PUBLIC_DEEP_TYPE=…\n`
// would propagate into `DBUSDC_TYPE` comparisons and
// the agents indexer's event-type filter would silently
// match zero on-chain events.
export const DEEP_TYPE = (process.env.NEXT_PUBLIC_DEEP_TYPE ??
    process.env.DEEP_TYPE ??
    "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP").trim();
// R55 audit fix: call-time getter for `DEEP_TYPE`. The const
// above is frozen at SDK import; a self-hosted DEEP migration
// (the docs explicitly call out a different env value for
// self-hosted deploys) would not take effect until restart.
export function resolveDeepType() {
    return (process.env.NEXT_PUBLIC_DEEP_TYPE ??
        process.env.DEEP_TYPE ??
        "0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP").trim();
}
// R47 audit fix: `.trim()` the AGENT_PKG env-chain. R41
// added `.trim()` to the `DUSDC_PACKAGE_ID` /
// `AGENT_POLICY_PACKAGE_ID` constants in
// `constants.ts` but missed the `AGENT_PKG` shadow
// here. `VLP_TYPE` is built from `AGENT_PKG`, so a
// whitespace-pasted env var produces a VLP type like
// `<0x…0xb177  ::vlp::VLP>` (trailing space) which
// the vault deposit/redeem type lookups would fail
// to match against the on-chain `TypeTag`.
const AGENT_PKG = (process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ??
    process.env.AGENT_POLICY_PACKAGE_ID ??
    "0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf").trim();
export const VLP_TYPE = `${AGENT_PKG}::vlp::VLP`;
export const POOL_SUI_DBUSDC = "SUI_DBUSDC";
export const POOL_DEEP_DBUSDC = "DEEP_DBUSDC";
export const POOL_CREATION_FEE_DEEP = 500000000n;
//# sourceMappingURL=constants.js.map