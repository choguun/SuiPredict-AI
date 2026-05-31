export function ProbabilityBar({
  yesProbability,
  className = "",
}: {
  yesProbability: number; // 0.0 to 1.0
  className?: string;
}) {
  const yesPercent = Math.min(100, Math.max(0, yesProbability * 100));
  const noPercent = 100 - yesPercent;

  return (
    <div className={`w-full overflow-hidden rounded-full bg-black/40 flex ${className}`}>
      {yesPercent > 0 && (
        <div 
          className="h-full bg-emerald-500/80 transition-all duration-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" 
          style={{ width: `${yesPercent}%` }} 
        />
      )}
      {noPercent > 0 && (
        <div 
          className="h-full bg-rose-500/80 transition-all duration-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]" 
          style={{ width: `${noPercent}%` }} 
        />
      )}
    </div>
  );
}
