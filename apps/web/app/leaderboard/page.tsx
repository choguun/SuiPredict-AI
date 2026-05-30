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
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200">Leaderboard</h1>
        <p className="mt-2 text-zinc-400">
          Top traders by volume on DeepBook Predict testnet
        </p>
      </div>

      <Card title="Rankings" className="border-white/10">
        {ranked.length === 0 ? (
          <p className="text-sm text-zinc-500">No indexed trades yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-zinc-400">
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">#</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Manager</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Mints</th>
                  <th className="pb-3 pr-4 font-semibold uppercase tracking-wider text-xs">Redeems</th>
                  <th className="pb-3 font-semibold uppercase tracking-wider text-xs">Volume</th>
                </tr>
              </thead>
              <tbody>
                {ranked.map((row, i) => (
                  <tr key={row.id} className="border-b border-white/5 transition-colors hover:bg-white/5">
                    <td className="py-3 pr-4 text-zinc-500">{i + 1}</td>
                    <td className="py-3 pr-4 font-mono text-xs text-cyan-400">
                      {row.id.slice(0, 10)}...
                    </td>
                    <td className="py-3 pr-4 text-zinc-300">{row.mints}</td>
                    <td className="py-3 pr-4 text-zinc-300">{row.redeems}</td>
                    <td className="py-3 text-white font-medium">${row.volume.toFixed(2)}</td>
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
