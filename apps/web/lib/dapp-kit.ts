"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  AGENT_POLICY_PACKAGE_ID,
  PREDICT_PACKAGE_ID,
} from "@suipredict/sdk";

// R34 audit fix: the dAppKit config was hard-coded to testnet, so
// `useCurrentClient()` (used by every page) returned a testnet
// client even on a mainnet deploy. A mainnet operator would see
// every transaction fail with "package object not found" or worse
// — silent type-mismatch aborts. Read the network from the env so
// the client tracks SUI_NETWORK like the rest of the stack.
//
// The env keys match the root `.env.example` and the agents-side
// `SUI_NETWORK` so a single value drives both the agents service
// and the web client. Falling back to testnet preserves the
// pre-R34 default for local dev; a production deploy is expected
// to set NEXT_PUBLIC_SUI_NETWORK explicitly.
//
// R38 audit fix: the previous code also read `process.env.SUI_NETWORK`
// (no NEXT_PUBLIC_ prefix) as a fallback. Only NEXT_PUBLIC_* vars
// are inlined into the browser bundle by Next.js — the bare
// `SUI_NETWORK` would always be `undefined` in the web runtime, so
// the fallback was dead code that gave the false impression of
// supporting a non-prefixed env. Drop it.
const SUI_NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ??
  "testnet") as "testnet" | "mainnet" | "devnet";
const FULLNODE_URL =
  process.env.NEXT_PUBLIC_SUI_RPC_URL ??
  (SUI_NETWORK === "mainnet"
    ? "https://fullnode.mainnet.sui.io:443"
    : SUI_NETWORK === "devnet"
      ? "https://fullnode.devnet.sui.io:443"
      : "https://fullnode.testnet.sui.io:443");

export const dAppKit = createDAppKit({
  networks: [SUI_NETWORK],
  defaultNetwork: SUI_NETWORK,
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: FULLNODE_URL,
    });
  },
  // R48 audit fix: opt out of autoConnect. A user who clicks
  // "Disconnect" and refreshes the page was previously
  // auto-reconnected because the wallet extension's own session
  // is still alive (only the local dapp-kit cookie is cleared by
  // `disconnectWallet`), and `autoConnect: true` re-establishes
  // the connection on the next mount. The disconnect was
  // effectively a no-op across reloads — exactly the opposite of
  // what the user asked for. A user-initiated reconnect is the
  // expected UX: open the wallet extension, click the
  // ConnectWallet button, and re-authorize. If a future flow
  // wants a silent re-prompt we can wire it via an explicit
  // `dappKit.connectWallet({ silent: true })` after a debounce
  // against a stored address.
  autoConnect: false,
});

export const PACKAGE_IDS = {
  predict: PREDICT_PACKAGE_ID,
  agentPolicy: AGENT_POLICY_PACKAGE_ID,
};

declare module "@mysten/dapp-kit-react" {
  interface Register {
    dAppKit: typeof dAppKit;
  }
}
