"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPortfolio, listMarkets, type PortfolioPosition } from "@suipredict/sdk";
import { Card } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { useRouter } from "next/navigation";

export default function PortfolioPage() {
  const account = useCurrentAccount();
  const router = useRouter();
  const [positions, setPositions] = useState<PortfolioPosition[]>([]);
  const [markets, setMarkets] = useState(0);

  useEffect(() => {
    listMarkets().then((m) => setMarkets(m.length)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!account) return;
    getPortfolio(account.address)
      .then(setPositions)
      .catch(() => setPositions([]));
    const t = setInterval(() => {
      getPortfolio(account.address).then(setPositions).catch(() => {});
    }, 8000);
    return () => clearInterval(t);
  }, [account]);

  if (!account) {
    return (
      <EmptyState
        title="Wallet Disconnected"
        description="Connect your Sui wallet to view your active prediction positions."
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Portfolio</h1>
        <p className="text-zinc-400">
          YES/NO balances across {markets} markets. Redeem winners on resolved
          markets from the market page.
        </p>
      </div>

      {positions.length === 0 ? (
        <EmptyState
          title="No Open Positions"
          description="You don't have any active YES/NO positions. Start trading to build your portfolio."
          actionLabel="Browse Markets"
          onAction={() => router.push("/markets")}
        />
      ) : (
        <div className="grid gap-4">
          {positions.map((p) => (
            <Card key={p.market_id}>
              <div className="flex justify-between gap-4">
                <div>
                  <Link
                    href={`/markets/${encodeURIComponent(p.market_id)}`}
                    className="font-semibold text-cyan-400 hover:underline"
                  >
                    {p.title}
                  </Link>
                  <p className="text-sm text-zinc-500 mt-1">Status: {p.status}</p>
                </div>
                <div className="text-right text-sm">
                  <p>YES: {(p.yes / 1e6).toFixed(4)}</p>
                  <p>NO: {(p.no / 1e6).toFixed(4)}</p>
                  {p.outcome && (
                    <p className="text-emerald-400">Winner: {p.outcome}</p>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
