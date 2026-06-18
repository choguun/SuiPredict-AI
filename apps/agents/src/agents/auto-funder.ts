/**
 * Auto Funder (R-WC-1.8)
 *
 * Keeps the agent wallet topped up with **DUSDC** so the
 * MarketMaker never burns through its `AgentPolicy` budget and
 * stalls, and so the pool-provisioner has fresh DUSDC to pay
 * the maker BM-deposit leg of every quote cycle.
 *
 * DEEP has no in-agent mint path on this deployment — the Sui
 * system `DEEP` (0x7b86477f…::deep::DEEP) is owned by the Sui
 * Foundation's genesis account, not by this project's
 * `DUSDC_TREASURY_CAP_ID`. When DEEP drops below the
 * configured floor, the auto-funder surfaces a single clear
 * `noop` decision with the operator-actionable funding URL.
 * Same UX shape as the wc-creator's `NEEDS FUNDING` branch
 * (apps/agents/src/agents/world-cup-creator.ts:362-370).
 *
 * Cadence: every 10 minutes, faster than the
 * provisioner's 15-minute cycle so DEEP shortfalls are caught
 * before the provisioner's own balance gate fires).
 *
 * Defaults:
 *   - floor:      100 USDC (1e8 raw at 6 decimals)
 *   - topup:    10,000 USDC (1e10 raw)
 *   - deep floor: 500 DEEP (5e8 raw at 6 decimals)
 *
 * Overridable via AUTO_FUNDER_MIN_DUSDC_ATOMS,
 * AUTO_FUNDER_TOPUP_DUSDC_ATOMS, and AUTO_FUNDER_MIN_DEEP_ATOMS.
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import {
  executeTransaction,
  DUSDC_TYPE,
  DEEP_TYPE,
  listAllCoins,
} from "@suipredict/sdk";
import { getSharedClient, recordResult, safeInt } from "../lib.js";
import type { AgentContext, AgentResult } from "../lib.js";

const DEFAULT_MIN_DUSDC_ATOMS = 100_000_000n;     // 100 USDC
const DEFAULT_TOPUP_DUSDC_ATOMS = 10_000_000_000n; // 10,000 USDC
const DEFAULT_MIN_DEEP_ATOMS = 500_000_000n;       // 500 DEEP

export async function runAutoFunder(
  ctx: AgentContext,
): Promise<AgentResult> {
  const agentAddr = ctx.signer.getPublicKey().toSuiAddress();
  const client = getSharedClient();
  const RPC =
    process.env.SUI_RPC_URL ??
    (process.env.SUI_NETWORK === "mainnet"
      ? "https://fullnode.mainnet.sui.io:443"
      : process.env.SUI_NETWORK === "devnet"
        ? "https://fullnode.devnet.sui.io:443"
        : "https://fullnode.testnet.sui.io:443");
  const gClient = new SuiGrpcClient({ network: "testnet", baseUrl: RPC });

  // 1. Read current balances.
  const [dusdcCoins, deepCoins, suiRes] = await Promise.all([
    listAllCoins(client, agentAddr, DUSDC_TYPE).catch(() => []),
    listAllCoins(client, agentAddr, DEEP_TYPE).catch(() => []),
    client.getBalance({ owner: agentAddr }).catch(() => null),
  ]);
  const totalDusdc = dusdcCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  const totalDeep = deepCoins.reduce((s, c) => s + BigInt(c.balance), 0n);
  // R-WC-1.8 fix: SuiGrpcClient's `getBalance` returns
  // a nested `{ balance: { balance: string, ... } }`
  // shape (the gRPC `Balance` message). The legacy
  // JSON-RPC client returns a flat `{ totalBalance: string }`.
  // Normalize both shapes — pre-fix this read
  // `totalBalance` and always got 0 from the gRPC
  // client, which made the wallet-funding gate
  // permanently trip "NEEDS FUNDING: have 0.00 SUI"
  // even after the operator topped up the wallet.
  const totalSui = (() => {
    if (!suiRes) return 0n;
    const j = suiRes as unknown as {
      totalBalance?: string | bigint;
      balance?: { balance?: string | bigint };
    };
    const nested = j.balance?.balance;
    const flat = j.totalBalance;
    const raw = nested ?? flat;
    return BigInt((raw as string | bigint | undefined)?.toString() ?? "0");
  })();

  const minDusdc = BigInt(safeInt(process.env.AUTO_FUNDER_MIN_DUSDC_ATOMS, Number(DEFAULT_MIN_DUSDC_ATOMS), 0, 1e18));
  const topupDusdc = BigInt(safeInt(process.env.AUTO_FUNDER_TOPUP_DUSDC_ATOMS, Number(DEFAULT_TOPUP_DUSDC_ATOMS), 0, 1e18));
  const minDeep = BigInt(safeInt(process.env.AUTO_FUNDER_MIN_DEEP_ATOMS, Number(DEFAULT_MIN_DEEP_ATOMS), 0, 1e15));

  // 2. Surface DEEP shortfall (no on-chain mint path for Sui system DEEP).
  if (totalDeep < minDeep) {
    return recordResult("AutoFunder", {
      action: "noop",
      reasoning:
        `NEEDS FUNDING: agent wallet has ${(Number(totalDeep) / 1e6).toFixed(2)} DEEP, ` +
        `need ${(Number(minDeep) / 1e6).toFixed(2)} for pool-creation fee + maker gas budget. ` +
        `Fund ${agentAddr} with the testnet DEEP swap at ` +
        `https://deepbookv3-portal.onrender.com/ (the canonical Sui system DEEP ` +
        `0x7b86477fb48be71179877784f75c44d260e15e429bce8da658a0ebf7aa48ae7b::deep::DEEP — ` +
        `same package the DeepBook pool module uses). ` +
        `The pool-provisioner agent is held until DEEP lands.`,
      confidence: 99,
    });
  }

  // 3. Auto-mint DUSDC if below floor.
  const treasuryCapId =
    process.env.DUSDC_TREASURY_CAP_ID ?? process.env.NEXT_PUBLIC_DUSDC_TREASURY_CAP_ID;
  if (totalDusdc >= minDusdc) {
    // Both DUSDC and DEEP above their floors — nothing to do.
    return recordResult("AutoFunder", {
      action: "skip",
      reasoning:
        `DUSDC=${(Number(totalDusdc) / 1e6).toFixed(2)} USDC (floor ${(Number(minDusdc) / 1e6).toFixed(2)}), ` +
        `DEEP=${(Number(totalDeep) / 1e6).toFixed(2)} DEEP (floor ${(Number(minDeep) / 1e6).toFixed(2)}), ` +
        `SUI=${(Number(totalSui) / 1e9).toFixed(2)} SUI. No topup needed.`,
    });
  }
  if (!treasuryCapId) {
    return recordResult("AutoFunder", {
      action: "noop",
      reasoning:
        `NEEDS FUNDING: DUSDC=${(Number(totalDusdc) / 1e6).toFixed(2)} USDC (below floor ${(Number(minDusdc) / 1e6).toFixed(2)}) ` +
        `and the auto-mint path is disabled because DUSDC_TREASURY_CAP_ID is unset. ` +
        `Either set DUSDC_TREASURY_CAP_ID (run bootstrap-gamification) or fund ${agentAddr} via the /faucet/dusdc HTTP endpoint.`,
      confidence: 99,
    });
  }

  // 4. Mint DUSDC to the agent wallet.
  const mintTx = new Transaction();
  mintTx.moveCall({
    target: "0x2::coin::mint_and_transfer",
    typeArguments: [DUSDC_TYPE],
    arguments: [
      mintTx.object(treasuryCapId),
      mintTx.pure.u64(topupDusdc),
      mintTx.pure.address(agentAddr),
    ],
  });

  try {
    const result = await executeTransaction(gClient, mintTx, ctx.signer);
    return recordResult("AutoFunder", {
      action: "auto_funded",
      reasoning:
        `minted ${(Number(topupDusdc) / 1e6).toFixed(2)} USDC → wallet ${agentAddr}; ` +
        `DUSDC was ${(Number(totalDusdc) / 1e6).toFixed(2)}, now ${(Number(totalDusdc + topupDusdc) / 1e6).toFixed(2)}. ` +
        `DEEP=${(Number(totalDeep) / 1e6).toFixed(2)} (sufficient). ` +
        `Digest: ${result.digest}.`,
      txDigest: result.digest,
      confidence: 100,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return recordResult("AutoFunder", {
      action: "noop",
      reasoning:
        `DUSDC=${(Number(totalDusdc) / 1e6).toFixed(2)} USDC (below floor) but the auto-mint tx failed: ${msg.slice(0, 200)}. ` +
        `The agent policy may be out of budget, or the DUSDC_TREASURY_CAP_ID is stale. ` +
        `Run \`pnpm --filter @suipredict/agents bootstrap\` to refresh the cap, or set AGENT_PRIVATE_KEY + run \`create-fresh-policy.ts\`.`,
      confidence: 95,
    });
  }
}
