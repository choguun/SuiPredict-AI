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
const SUI_NETWORK = (process.env.NEXT_PUBLIC_SUI_NETWORK ??
  process.env.SUI_NETWORK ??
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
  autoConnect: true,
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
