/** DeepBook V3 testnet constants */
export const DEEPBOOK_PACKAGE_ID =
  "0x22be4cade64bf2d02412c7e8d0e8beea2f78828b948118d46735315409371a3c";

export const DEEPBOOK_REGISTRY_ID =
  "0x7c256edbda983a2cd6f946655f4bf3f00a41043993781f8674a7046e8c0e11d1";

export const DBUSDC_TYPE =
  "0xf7152c05930480cd740d7311b5b8b45c6f488e3a53a11c3f74a6fac36a52e0d7::DBUSDC::DBUSDC";

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
export const DEEP_TYPE =
  process.env.NEXT_PUBLIC_DEEP_TYPE ??
  process.env.DEEP_TYPE ??
  "0x36dbef866a1d62bf7328989a10fb2f07d769f4ee587c0de4a0a256e57e0a58a8::deep::DEEP";

const AGENT_PKG =
  process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ??
  process.env.AGENT_POLICY_PACKAGE_ID ??
  "0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf";

export const VLP_TYPE = `${AGENT_PKG}::vlp::VLP`;

export const POOL_SUI_DBUSDC = "SUI_DBUSDC";
export const POOL_DEEP_DBUSDC = "DEEP_DBUSDC";

export const POOL_CREATION_FEE_DEEP = 500_000_000n;
