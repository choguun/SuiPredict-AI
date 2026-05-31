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
      className={`rounded-lg border border-white/10 bg-[#11141d]/90 p-4 shadow-sm shadow-black/20 ${className}`}
    >
      {title && (
        <h2 className="mb-3 text-xs font-semibold uppercase text-zinc-500">
          {title}
        </h2>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs font-medium uppercase text-zinc-500">{label}</p>
      <p className="truncate text-xl font-semibold text-white sm:text-2xl">{value}</p>
    </div>
  );
}

export function Badge({
  children,
  variant = "default",
  className = "",
}: {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning";
  className?: string;
}) {
  const colors = {
    default: "border border-white/10 bg-white/[0.06] text-zinc-300",
    success: "border border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    warning: "border border-amber-500/25 bg-amber-500/10 text-amber-300",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${colors[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
