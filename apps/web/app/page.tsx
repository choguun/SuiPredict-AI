import Link from "next/link";
import {
  findNearestActiveOracle,
  getSpotPrice,
  getStatus,
  getVaultSummary,
} from "@suipredict/sdk";
import { Badge, Card, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const [status, vault, oracle] = await Promise.all([
    getStatus().catch(() => ({ status: "offline" })),
    getVaultSummary().catch(() => null),
    findNearestActiveOracle().catch(() => null),
  ]);

  let spot: number | null = null;
  if (oracle) {
    spot = await getSpotPrice(oracle.oracle_id).catch(() => null);
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <Badge variant="success">DeepBook Predict · Testnet</Badge>
        <h1 className="text-4xl font-bold tracking-tight md:text-5xl">
          Autonomous prediction markets
          <span className="block text-cyan-400">powered by AI agents</span>
        </h1>
        <p className="max-w-2xl text-lg text-zinc-400">
          SuiPredict-AI integrates DeepBook Predict with four specialized agents:
          market strategist, PLP manager, redeem keeper, and risk monitor — all
          governed by on-chain policy objects.
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Link
            href="/trade"
            className="rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-medium text-zinc-950 hover:bg-cyan-400"
          >
            Start Trading
          </Link>
          <Link
            href="/agents"
            className="rounded-lg border border-zinc-700 px-5 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800"
          >
            View Agents
          </Link>
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <Stat label="Predict Server" value={status.status} />
        </Card>
        <Card>
          <Stat
            label="Vault Value"
            value={
              vault
                ? `$${(vault.vault_value / 1e6).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
                : "—"
            }
          />
        </Card>
        <Card>
          <Stat
            label="Utilization"
            value={
              vault ? `${((vault.utilization ?? 0) * 100).toFixed(1)}%` : "—"
            }
          />
        </Card>
        <Card>
          <Stat
            label="BTC Spot"
            value={spot ? `$${spot.toLocaleString()}` : "—"}
          />
        </Card>
      </div>

      {oracle && (
        <Card title="Nearest Active Oracle">
          <div className="grid gap-3 sm:grid-cols-3">
            <Stat label="Asset" value={oracle.underlying_asset} />
            <Stat
              label="Expiry"
              value={new Date(oracle.expiry).toLocaleString()}
            />
            <Stat label="Status" value={oracle.status} />
          </div>
        </Card>
      )}
    </div>
  );
}
