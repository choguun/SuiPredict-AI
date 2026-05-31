"use client";

import { useState, useMemo } from "react";
import { ProbabilityBar } from "@/components/ProbabilityBar";

const MOCK_MARKETS = [
  { id: "1", question: "Will BTC close above $65,000 today?", yesProbability: 0.65 },
  { id: "2", question: "Will ETH close above $3,500 today?", yesProbability: 0.42 },
  { id: "3", question: "Will any major AI funding (> $50M) be announced today?", yesProbability: 0.81 },
  { id: "4", question: "Will Total Crypto Market Cap increase today?", yesProbability: 0.55 },
  { id: "5", question: "Will OpenAI release a new model update today?", yesProbability: 0.23 },
];

export function DailyPredictionCard() {
  const [activeMarketIds, setActiveMarketIds] = useState<string[]>(["1", "2", "3"]);
  const [selections, setSelections] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const activeMarkets = useMemo(() => {
    return MOCK_MARKETS.filter(m => activeMarketIds.includes(m.id));
  }, [activeMarketIds]);

  const activeSelectionsCount = activeMarketIds.filter(id => selections[id] !== undefined).length;
  const isComplete = activeMarketIds.length > 0 && activeSelectionsCount === activeMarketIds.length;

  const handleAddMarket = () => {
    const nextAvailable = MOCK_MARKETS.find(m => !activeMarketIds.includes(m.id));
    if (nextAvailable) {
      setActiveMarketIds([...activeMarketIds, nextAvailable.id]);
    }
  };

  const handleRemoveMarket = (id: string) => {
    setActiveMarketIds(activeMarketIds.filter(marketId => marketId !== id));
    // Optionally clean up selection for removed market
    const newSelections = { ...selections };
    delete newSelections[id];
    setSelections(newSelections);
  };

  const handleSubmit = async () => {
    if (!isComplete) return;
    setSubmitting(true);
    setTimeout(() => {
      setSubmitting(false);
      setSubmitted(true);
    }, 1500);
  };

  if (submitted) {
    return (
      <div className="relative flex h-full min-h-[300px] flex-col items-center justify-center overflow-hidden rounded-2xl border border-emerald-500/30 bg-[#11141d] p-8 text-center shadow-2xl shadow-emerald-900/20 transition-all">
        <div className="absolute inset-0 bg-emerald-500/5 -z-10" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-64 w-64 rounded-full bg-emerald-500/20 blur-[80px] -z-10" />
        <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/20 text-4xl shadow-[0_0_30px_rgba(16,185,129,0.3)]">
          🎉
        </div>
        <h2 className="text-2xl font-extrabold text-transparent bg-clip-text bg-gradient-to-br from-emerald-300 to-teal-500 mb-2">Predictions Locked!</h2>
        <p className="max-w-xs text-sm leading-relaxed text-emerald-200/70">
          Your daily predictions have been recorded. Come back tomorrow to keep your streak alive and claim your yield boost.
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 shadow-xl shadow-black/50 transition-all hover:border-violet-500/30 hover:shadow-violet-900/20">
      <div className="absolute -left-20 -bottom-20 h-64 w-64 rounded-full bg-violet-600/10 blur-[80px] -z-10" />
      
      <div className="mb-6 flex justify-between items-start gap-4">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-1">Your Daily Parlay</h2>
          <p className="text-sm text-zinc-400">
            Build your parlay. Predict {activeMarketIds.length} binary markets correctly to maintain your streak and earn up to <span className="font-semibold text-emerald-400">30% APY boost</span>!
          </p>
        </div>
        {activeMarketIds.length < MOCK_MARKETS.length && (
          <button
            onClick={handleAddMarket}
            className="shrink-0 flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/10"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            Add Leg
          </button>
        )}
      </div>

      <div className="flex-1 space-y-3">
        {activeMarkets.length === 0 && (
          <div className="rounded-xl border border-dashed border-white/10 p-8 text-center text-zinc-500 text-sm">
            No markets in your parlay. Add one to get started.
          </div>
        )}
        {activeMarkets.map((market, idx) => {
          const selected = selections[market.id];
          return (
            <div
              key={market.id}
              className={`relative group flex flex-col gap-4 rounded-xl border p-4 transition-all sm:flex-row sm:items-center sm:justify-between ${
                selected !== undefined
                  ? "border-white/10 bg-white/[0.04]"
                  : "border-white/5 bg-white/[0.02] hover:border-cyan-500/30 hover:bg-[#151924]"
              }`}
            >
              <div className="flex flex-1 flex-col gap-3 pr-8 sm:pr-0">
                <div className="flex items-start gap-4">
                  <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-colors ${
                    selected !== undefined ? "bg-white/20 text-white" : "bg-white/10 text-zinc-500 group-hover:bg-cyan-500/20 group-hover:text-cyan-400"
                  }`}>
                    {idx + 1}
                  </div>
                  <div className="flex w-full flex-col gap-2.5">
                    <p className={`text-sm font-medium transition-colors ${selected !== undefined ? "text-zinc-300" : "text-white"}`}>
                      {market.question}
                    </p>
                    <div className="flex items-center gap-3">
                      <ProbabilityBar yesProbability={market.yesProbability} className="h-1.5 opacity-60 group-hover:opacity-100 transition-opacity" />
                      <span className="shrink-0 text-[10px] font-bold tracking-wider text-zinc-500 uppercase">{Math.round(market.yesProbability * 100)}% YES</span>
                    </div>
                  </div>
                </div>
              </div>
              
              <button
                onClick={() => handleRemoveMarket(market.id)}
                className="absolute right-3 top-3 sm:relative sm:right-auto sm:top-auto sm:ml-2 flex h-6 w-6 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-rose-500/20 hover:text-rose-400 sm:order-last"
                title="Remove Leg"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>

              <div className="flex shrink-0 gap-2 items-center w-full sm:w-auto mt-2 sm:mt-0">
                <button
                  onClick={() => setSelections((s) => ({ ...s, [market.id]: true }))}
                  className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2.5 text-xs font-bold transition-all ${
                    selected === true
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.2)] scale-105"
                      : "bg-black/40 text-zinc-500 hover:bg-white/10 hover:text-white border border-white/5"
                  }`}
                >
                  YES
                </button>
                <button
                  onClick={() => setSelections((s) => ({ ...s, [market.id]: false }))}
                  className={`flex-1 sm:flex-none sm:w-20 rounded-lg px-3 py-2.5 text-xs font-bold transition-all ${
                    selected === false
                      ? "bg-rose-500/20 text-rose-300 border border-rose-500/40 shadow-[0_0_15px_rgba(244,63,94,0.2)] scale-105"
                      : "bg-black/40 text-zinc-500 hover:bg-white/10 hover:text-white border border-white/5"
                  }`}
                >
                  NO
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border-t border-white/5 pt-6">
        <button
          onClick={handleSubmit}
          disabled={!isComplete || submitting || activeMarketIds.length === 0}
          className="w-full rounded-xl bg-gradient-to-r from-violet-600 to-cyan-600 py-3.5 text-sm font-bold text-white shadow-lg shadow-cyan-900/30 transition-all hover:scale-[1.02] disabled:opacity-50 disabled:scale-100 disabled:shadow-none"
        >
          {submitting ? "Submitting..." : `Lock In Predictions (${activeSelectionsCount}/${activeMarketIds.length})`}
        </button>
      </div>
    </div>
  );
}
