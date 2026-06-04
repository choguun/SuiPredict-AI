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
  process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID ??
  process.env.DUSDC_PACKAGE_ID ??
  "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705";

// R40 audit fix: when `SUI_NETWORK=mainnet` and none of the
// package-id env vars are set, every PTB built from this SDK
// would silently submit against the bundled testnet default
// and abort with `package object not found`. The web's
// `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID` is inlined at build
// time, so a misconfigured CI build of the web bundle is
// indistinguishable from a working one. Throw at module load
// so a misconfigured mainnet deploy crashes early with a
// readable error, matching the existing throw in
// `prize-client.ts:DEFAULT_DISTRIBUTION_BPS`.
function assertMainnetHasExplicitIds(): void {
  if (resolveSuiNetwork() !== "mainnet") return;
  const idVars = [
    "NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID",
    "AGENT_POLICY_PACKAGE_ID",
    "NEXT_PUBLIC_MARKET_PACKAGE_ID",
    "MARKET_PACKAGE_ID",
  ];
  if (!idVars.some((v) => process.env[v])) {
    throw new Error(
      "[sdk] SUI_NETWORK=mainnet but no AGENT_POLICY_PACKAGE_ID (or " +
        "MARKET_PACKAGE_ID) env var is set. Refusing to silently route " +
        "every PTB to the bundled testnet address. Set the env var and " +
        "rebuild.",
    );
  }
  if (!process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID && !process.env.DUSDC_PACKAGE_ID) {
    throw new Error(
      "[sdk] SUI_NETWORK=mainnet but no DUSDC_PACKAGE_ID env var is set. " +
        "Refusing to silently mint against the bundled testnet dUSDC type. " +
        "Set the env var and rebuild.",
    );
  }
}

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
 * The default below is the *currently-deployed* testnet address from
 * `packages/contracts/Published.toml`. If the env var is unset and
 * you've re-published the package, update this default (and re-run
 * the agents bootstrap to write `NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID`
 * to `apps/web/.env.local`).
 */
export const AGENT_POLICY_PACKAGE_ID =
  process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ??
  process.env.AGENT_POLICY_PACKAGE_ID ??
  process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
  process.env.MARKET_PACKAGE_ID ??
  "0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf";

// R39 audit fix: the URL used to be hardcoded to testnet, which
// meant a mainnet deploy (where the agents service reads
// `SUI_NETWORK=mainnet` for the JSON-RPC client) was silently
// submitting every on-chain tx — fund_pool, fund_parlay_pool,
// place_order, prize-admin, etc. — to the testnet cluster.
// Now we resolve the URL from `SUI_NETWORK` at module load; the
// web/agents build inlines the same env var on the read path
// (see `lib/dapp-kit.ts` for the web side). The fallback to
// testnet preserves the pre-R39 default for local dev.
function resolveSuiGrpcUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_SUI_RPC_URL ?? process.env.SUI_RPC_URL;
  if (explicit) return explicit;
  const network = (process.env.SUI_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") return "https://fullnode.mainnet.sui.io:443";
  if (network === "devnet") return "https://fullnode.devnet.sui.io:443";
  return "https://fullnode.testnet.sui.io:443";
}

export const SUI_GRPC_URL = resolveSuiGrpcUrl();

function resolveSuiNetwork(): "testnet" | "mainnet" | "devnet" {
  const n = (process.env.SUI_NETWORK ?? "testnet").toLowerCase();
  if (n === "mainnet" || n === "devnet" || n === "testnet") return n;
  return "testnet";
}

export const SUI_NETWORK: "testnet" | "mainnet" | "devnet" = resolveSuiNetwork();

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

// R40 audit fix: invoke the mainnet guard on module load. The
// guard reads `process.env`, which is fully populated by the
// time the SDK is imported (the web's Next.js inlines
// NEXT_PUBLIC_* at build time; the agents service loads .env
// via `dotenv/config` before importing the SDK). A failure
// here is loud and crashes the build / agent boot —
// preferable to silently misrouting mainnet PTBs to a testnet
// package.
assertMainnetHasExplicitIds();
