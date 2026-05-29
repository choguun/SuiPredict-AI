"use client";

import { createDAppKit } from "@mysten/dapp-kit-react";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  AGENT_POLICY_PACKAGE_ID,
  PREDICT_PACKAGE_ID,
} from "@suipredict/sdk";

export const dAppKit = createDAppKit({
  networks: ["testnet"],
  defaultNetwork: "testnet",
  createClient(network) {
    return new SuiGrpcClient({
      network,
      baseUrl: "https://fullnode.testnet.sui.io:443",
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
