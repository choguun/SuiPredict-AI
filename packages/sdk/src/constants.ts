/** DeepBook Predict testnet deployment — predict-testnet-4-16 branch */

export const NETWORK = "testnet" as const;

export const PREDICT_SERVER_URL =
  "https://predict-server.testnet.mystenlabs.com";

export const PREDICT_PACKAGE_ID =
  "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138";

export const PREDICT_REGISTRY_ID =
  "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64";

export const PREDICT_OBJECT_ID =
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a";

export const DUSDC_PACKAGE_ID =
  process.env.DUSDC_PACKAGE_ID ??
  "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705";

export const DUSDC_TYPE = `${DUSDC_PACKAGE_ID}::dusdc::DUSDC`;

export const PLP_TYPE = `${PREDICT_PACKAGE_ID}::plp::PLP`;

export const DUSDC_TREASURY_CAP_ID =
  "0x64f8a47a0af0a3b14db3a7ce89aa206ff77a9c6b5ac0eaef6db2ea46da3ced94";

export const CLOCK_OBJECT_ID = "0x6";

export const PRICE_SCALE = 1_000_000_000n;
export const DUSDC_SCALE = 1_000_000n;

/**
 * Published `agent_policy` package ID (the package that also contains
 * `streak_system`, `prize_pool`, `prediction_market`, `types`).
 *
 * Set via env at deploy time:
 *   AGENT_POLICY_PACKAGE_ID=0x...
 *
 * The default below is a *legacy* testnet address from a prior publish
 * and is **not** guaranteed to contain the gamification modules
 * (`streak_system`, `prize_pool`, `redeem_with_streak`,
 * `dispute_market`). Run `pnpm --filter @suipredict/agents bootstrap`
 * to publish a fresh package and overwrite this via env.
 */
export const AGENT_POLICY_PACKAGE_ID =
  process.env.AGENT_POLICY_PACKAGE_ID ??
  "0x7377808da2e3d48282268c56e332ac282adca02db3a4d924505fa139067ff4e8";

export const SUI_GRPC_URL = "https://fullnode.testnet.sui.io:443";

export function dollarsToStrike(dollars: number | bigint): bigint {
  return BigInt(dollars) * PRICE_SCALE;
}

export function dollarsToDusdc(dollars: number | bigint): bigint {
  return BigInt(dollars) * DUSDC_SCALE;
}

export function strikeToDollars(strike: bigint): number {
  return Number(strike / PRICE_SCALE);
}

export function dusdcToDollars(amount: bigint): number {
  return Number(amount) / Number(DUSDC_SCALE);
}
