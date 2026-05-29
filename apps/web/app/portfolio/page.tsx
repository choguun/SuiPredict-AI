"use client";

import { useCurrentAccount } from "@mysten/dapp-kit-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { getPortfolio, listMarkets, type PortfolioPosition } from "@suipredict/sdk";
import { Card } from "@/components/ui";

export default function PortfolioPage() {
  const account = useCurrentAccount();
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
      <Card>
        <p className="text-zinc-400">Connect wallet to view portfolio.</p>
      </Card>
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
        <Card>
          <p className="text-zinc-400">
            No positions yet. Split collateral on a market or place orders.
          </p>
          <Link href="/markets" className="mt-3 inline-block text-cyan-400 text-sm">
            Browse markets →
          </Link>
        </Card>
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
