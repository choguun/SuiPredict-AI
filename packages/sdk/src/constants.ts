/** DeepBook Predict testnet deployment — predict-testnet-4-16 branch */

export const NETWORK = "testnet" as const;

// R43 audit fix: `PREDICT_SERVER_URL` was hardcoded to the
// testnet URL. A mainnet deploy of the agents service (or the
// web's `app/legacy/predict/*` pages) would still hit the
// testnet predict-server for every spot-price / oracle read,
// returning testnet spot prices that don't match the on-chain
// mainnet state. Resolve the URL from `SUI_NETWORK` at module
// load, parallel to `resolveSuiGrpcUrl`, with an explicit env
// override (`NEXT_PUBLIC_PREDICT_SERVER_URL` /
// `PREDICT_SERVER_URL`) for the rare case where Mysten moves
// the URL. The web's dapp-kit inlines NEXT_PUBLIC_* at build
// time so the resolve also pulls from the bare
// `PREDICT_SERVER_URL` for the agents service.
function resolvePredictServerUrl(): string {
  const explicit =
    process.env.NEXT_PUBLIC_PREDICT_SERVER_URL ??
    process.env.PREDICT_SERVER_URL;
  if (explicit) return explicit.trim();
  const network = (process.env.SUI_NETWORK ?? "testnet").toLowerCase();
  if (network === "mainnet") return "https://predict-server.mainnet.mystenlabs.com";
  if (network === "devnet") return "https://predict-server.devnet.mystenlabs.com";
  return "https://predict-server.testnet.mystenlabs.com";
}

export const PREDICT_SERVER_URL = resolvePredictServerUrl();

// R42 audit fix: `PREDICT_PACKAGE_ID` is the DeepBook Predict
// upstream package — it lives on a Mysten-managed testnet
// address with no mainnet equivalent. The web/agents bundles
// had this hardcoded to the testnet address, so on a mainnet
// deploy every `predict::*` PTB (legacy mint / redeem paths
// the web falls back to under
// `apps/web/app/legacy/predict/`) would route to a non-existent
// package and abort with `package object not found`. The R40
// `assertMainnetHasExplicitIds` guard catches the related
// `AGENT_POLICY_PACKAGE_ID` / `DUSDC_PACKAGE_ID` cases but
// doesn't know about `PREDICT_PACKAGE_ID`. Extend the guard
// to refuse a mainnet build unless the operator supplies an
// override env var (`NEXT_PUBLIC_PREDICT_PACKAGE_ID`).
export const PREDICT_PACKAGE_ID =
  (process.env.NEXT_PUBLIC_PREDICT_PACKAGE_ID ??
    process.env.PREDICT_PACKAGE_ID ??
    "0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138"
  ).trim();

// R46 audit fix: `PREDICT_REGISTRY_ID` was a hardcoded testnet
// address with no env override. A mainnet deploy would silently
// route every legacy `predict::registry` PTB to a non-existent
// shared object and abort with `shared object not found` at
// runtime — the R40 mainnet guard didn't know about it.
// Resolve from `NEXT_PUBLIC_PREDICT_REGISTRY_ID` with a
// hardcoded testnet default for devnet/testnet/localnet.
export const PREDICT_REGISTRY_ID = (
  process.env.NEXT_PUBLIC_PREDICT_REGISTRY_ID ??
  process.env.PREDICT_REGISTRY_ID ??
  "0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64"
).trim();

// R47 audit fix: `PREDICT_OBJECT_ID` was a hardcoded testnet
// address with no env override. R42 added the equivalent
// guard for `PREDICT_PACKAGE_ID` and R46 added it for
// `PREDICT_REGISTRY_ID`, but missed this third constant.
// The web's `app/legacy/predict/*` pages route every
// `predict::mint` / `redeem` / `supply` / `withdraw`
// PTB through `tx.object(PREDICT_OBJECT_ID)`; a mainnet
// deploy without an explicit override would route them
// to a non-existent shared object and abort with
// `shared object not found`. Resolve from
// `NEXT_PUBLIC_PREDICT_OBJECT_ID` with a hardcoded
// testnet default; the mainnet guard below also lists
// the env var so a misconfigured mainnet build crashes
// early.
export const PREDICT_OBJECT_ID = (
  process.env.NEXT_PUBLIC_PREDICT_OBJECT_ID ??
  process.env.PREDICT_OBJECT_ID ??
  "0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a"
).trim();

export const DUSDC_PACKAGE_ID =
  (process.env.NEXT_PUBLIC_DUSDC_PACKAGE_ID ??
    process.env.DUSDC_PACKAGE_ID ??
    "0xe9a73a6f4457f6ecad6260a37a200745a8009e9ee1a235ab91f8d3c030d3a705"
  ).trim();

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
//
// R41 audit fix: trim whitespace off the env value. A `.env`
// line with trailing whitespace (common when a value is pasted
// from a docs page) silently produces a type tag like
// `<0x…::dusdc::DUSDC >` with a space, which the agents
// indexer event-filter treats as a different event type and
// matches zero on-chain events. The agents' R40 bootstrap
// derivation also trims, but the SDK's own DUSDC_TYPE /
// AGENT_POLICY_PACKAGE_ID are read directly by web pages and
// by PTB builders — trim once at the source.
function assertMainnetHasExplicitIds(): void {
  if (resolveSuiNetwork() !== "mainnet") return;
  const idVars = [
    "NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID",
    "AGENT_POLICY_PACKAGE_ID",
    "NEXT_PUBLIC_MARKET_PACKAGE_ID",
    "MARKET_PACKAGE_ID",
    // R42 audit fix: the legacy `predict::*` PTB builders
    // (used by the web's `app/legacy/predict/*` pages) submit
    // against `PREDICT_PACKAGE_ID`. On mainnet, the bundled
    // testnet address has no counterpart, so a mainnet build
    // that only set `AGENT_POLICY_PACKAGE_ID` would still
    // route legacy mint/redeem calls to a non-existent
    // package. Require an explicit override on mainnet.
    "NEXT_PUBLIC_PREDICT_PACKAGE_ID",
    "PREDICT_PACKAGE_ID",
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
  // R43 audit fix: the post-R40 stack added several env-driven
  // object ids (`FEE_VAULT_ID`, `REFERRAL_TREASURY_ADDRESS`,
  // `STREAK_REGISTRY_ID`, `PROFILE_REGISTRY_ID`) that the
  // bundles now require on mainnet. A mainnet build that
  // provided `AGENT_POLICY_PACKAGE_ID` and `DUSDC_PACKAGE_ID`
  // but omitted these would still silently route every
  // mint/redeem to the zero-id sentinel and abort with
  // `EPackageObjectNotFound` (the SDK falls back to
  // `0x000…000` for unset ids, see FEE_VAULT_ID /
  // REFERRAL_TREASURY_ADDRESS). Refuse to load on mainnet
  // unless the operator wires the full set.
  const additionalIds = [
    "NEXT_PUBLIC_FEE_VAULT_ID",
    "FEE_VAULT_ID",
    "NEXT_PUBLIC_REFERRAL_TREASURY_ADDRESS",
    "REFERRAL_TREASURY_ADDRESS",
    "NEXT_PUBLIC_STREAK_REGISTRY_ID",
    "STREAK_REGISTRY_ID",
    "NEXT_PUBLIC_PROFILE_REGISTRY_ID",
    "PROFILE_REGISTRY_ID",
  ];
  for (const v of additionalIds) {
    if (!process.env[v]) {
      throw new Error(
        `[sdk] SUI_NETWORK=mainnet but ${v} env var is not set. ` +
          "Refusing to silently use a zero-id fallback. Set the env " +
          "var and rebuild.",
      );
    }
  }
  // R46 audit fix: add the post-R40 mint / registry ids that
  // the bundles now reference. `DUSDC_TREASURY_CAP_ID` is the
  // `dusdc::DUSDC` TreasuryCap that the bootstrap mints
  // against; `PREDICT_REGISTRY_ID` is the `predict::Registry`
  // shared object the legacy `app/legacy/predict/*` pages read.
  // A mainnet build that provided everything above but omitted
  // these would still silently submit against the bundled
  // testnet default and abort with `object not found` on the
  // first mint / registry call. Throw at module load.
  const r46Ids = [
    "NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID",
    "DUSDC_TREASURY_CAP_ID",
    "NEXT_PUBLIC_PREDICT_REGISTRY_ID",
    "PREDICT_REGISTRY_ID",
  ];
  for (const v of r46Ids) {
    if (!process.env[v]) {
      throw new Error(
        `[sdk] SUI_NETWORK=mainnet but ${v} env var is not set. ` +
          "Refusing to silently use the bundled testnet default. Set " +
          "the env var and rebuild.",
      );
    }
  }
  // R47 audit fix: add the post-R46 ids the bundles now
  // reference. `PREDICT_OBJECT_ID` is the `predict::Predict`
  // shared object the legacy mint/redeem/supply/withdraw
  // PTBs read (it carries the policy table the
  // `predict::*` Move functions mutate). The pair
  // `DEEPBOOK_PACKAGE_ID` / `DEEPBOOK_REGISTRY_ID` is
  // used by every `create_market` and balance-manager
  // call. A mainnet build that provided everything
  // above but omitted these would silently route the
  // legacy `app/legacy/predict/*` traffic and the
  // DeepBook pool traffic to the bundled testnet
  // address and abort with `object not found` /
  // `package object not found` on the first
  // PTB. Throw at module load.
  const r47Ids = [
    "NEXT_PUBLIC_PREDICT_OBJECT_ID",
    "PREDICT_OBJECT_ID",
    "NEXT_PUBLIC_DEEPBOOK_PACKAGE_ID",
    "DEEPBOOK_PACKAGE_ID",
    "NEXT_PUBLIC_DEEPBOOK_REGISTRY_ID",
    "DEEPBOOK_REGISTRY_ID",
  ];
  for (const v of r47Ids) {
    if (!process.env[v]) {
      throw new Error(
        `[sdk] SUI_NETWORK=mainnet but ${v} env var is not set. ` +
          "Refusing to silently use the bundled testnet default. Set " +
          "the env var and rebuild.",
      );
    }
  }
  // R49 audit fix: `INDEXER_URL` / `NEXT_PUBLIC_AGENTS_URL` are
  // the URL the SDK's `markets/indexer-client.ts` hits for
  // every list/get/order-book call. They default to
  // `http://localhost:3001` and were the only env-driven value
  // with no mainnet guard — a mainnet deploy that forgot to
  // set either would silently try to hit the local dev server,
  // hang on TCP, and surface as a generic
  // "indexer /markets: fetch failed" in the browser. Mirror
  // the r47Ids pattern.
  if (
    !process.env.INDEXER_URL &&
    !process.env.NEXT_PUBLIC_AGENTS_URL
  ) {
    throw new Error(
      "[sdk] SUI_NETWORK=mainnet but neither INDEXER_URL nor " +
        "NEXT_PUBLIC_AGENTS_URL is set. Refusing to silently fall " +
        "back to http://localhost:3001. Set the env var and rebuild.",
    );
  }
}

export const DUSDC_TYPE = `${DUSDC_PACKAGE_ID}::dusdc::DUSDC`;

export const PLP_TYPE = `${PREDICT_PACKAGE_ID}::plp::PLP`;

// R46 audit fix: `DUSDC_TREASURY_CAP_ID` was a hardcoded testnet
// address with no env override. The dUSDC `treasury_cap` is a
// one-time-published object that the bootstrap mints against;
// a mainnet deploy that only set the package id would silently
// try to access a non-existent cap and abort with `object not
// found` on the first mint call. Resolve from
// `NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID` with a hardcoded testnet
// default for devnet/testnet/localnet.
export const DUSDC_TREASURY_CAP_ID = (
  process.env.NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID ??
  process.env.DUSDC_TREASURY_CAP_ID ??
  "0x64f8a47a0af0a3b14db3a7ce89aa206ff77a9c6b5ac0eaef6db2ea46da3ced94"
).trim();

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
  (process.env.NEXT_PUBLIC_AGENT_POLICY_PACKAGE_ID ??
    process.env.AGENT_POLICY_PACKAGE_ID ??
    process.env.NEXT_PUBLIC_MARKET_PACKAGE_ID ??
    process.env.MARKET_PACKAGE_ID ??
    "0xb1777f167c29dbf1d0bf6e014157b3afd377608703d4935106989a0bb2be3ebf"
  ).trim();

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
