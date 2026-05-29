export function Card({
  title,
  children,
  className = "",
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border border-white/10 bg-white/5 p-5 backdrop-blur-md shadow-inner transition hover:border-white/20 ${className}`}
    >
      {title && (
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-400">
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wider text-zinc-400/80 mb-1">{label}</p>
      <p className="text-2xl font-bold text-white drop-shadow-md">{value}</p>
    </div>
  );
}

export function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning";
}) {
  const colors = {
    default: "border border-white/10 bg-white/5 text-zinc-300 shadow-inner",
    success: "border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 shadow-[0_0_15px_rgba(16,185,129,0.15)]",
    warning: "border border-amber-500/30 bg-amber-500/10 text-amber-300 shadow-[0_0_15px_rgba(245,158,11,0.15)]",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide ${colors[variant]}`}
    >
      {children}
    </span>
  );
}
