import { getMintedPositions, getRedeemedPositions } from "@suipredict/sdk";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function LeaderboardPage() {
  const [minted, redeemed] = await Promise.all([
    getMintedPositions(30).catch(() => []),
    getRedeemedPositions(30).catch(() => []),
  ]);

  const byManager = new Map<
    string,
    { mints: number; redeems: number; volume: number }
  >();

  for (const m of minted) {
    const cur = byManager.get(m.manager_id) ?? {
      mints: 0,
      redeems: 0,
      volume: 0,
    };
    cur.mints += 1;
    cur.volume += m.cost / 1e6;
    byManager.set(m.manager_id, cur);
  }
  for (const r of redeemed) {
    const cur = byManager.get(r.manager_id) ?? {
      mints: 0,
      redeems: 0,
      volume: 0,
    };
    cur.redeems += 1;
    cur.volume += r.payout / 1e6;
    byManager.set(r.manager_id, cur);
  }

  const ranked = [...byManager.entries()]
    .map(([id, stats]) => ({ id, ...stats, streak: stats.mints }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 20);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Leaderboard</h1>
        <p className="text-zinc-400">
          Top traders by volume on DeepBook Predict testnet
        </p>
      </div>

      <Card title="Rankings">
        {ranked.length === 0 ? (
          <p className="text-sm text-zinc-500">No indexed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-zinc-500">
                  <th className="pb-2 pr-4">#</th>
                  <th className="pb-2 pr-4">Manager</th>
                  <th className="pb-2 pr-4">Mints</th>
                  <th className="pb-2 pr-4">Redeems</th>
                  <th className="pb-2">Volume</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, i) => (
                  <tr key={row.id} className="border-b border-zinc-800/50">
                    <td className="py-2 pr-4 text-zinc-500">{i + 1}</td>
                    <td className="py-2 pr-4 font-mono text-xs text-cyan-400">
                      {row.id.slice(0, 10)}...
                    </td>
                    <td className="py-2 pr-4">{row.mints}</td>
                    <td className="py-2 pr-4">{row.redeems}</td>
                    <td className="py-2">${row.volume.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
