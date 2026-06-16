export function Card({
  title,
  children,
  className = "",
  id,
}: {
  // React.ReactNode (not just string) so callers can drop inline
  // controls like a Refresh button into the title row. All current
  // call sites still pass a plain string, which is a valid ReactNode.
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  // R62 audit fix: forward an optional
  // `id` so callers can target the card
  // for `scrollIntoView` from
  // "How do I exit?" CTAs. The markets/[id]
  // page's `mergeCollateral` handler
  // references `#trade-card` and the
  // element is the wrapping <div> below
  // (the existing title + children
  // render). Accepting `id` keeps the
  // component primitive while letting
  // the call sites avoid wrapping the
  // card in an extra <div id=...>.
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`relative overflow-hidden rounded-2xl border border-white/10 bg-panel-strong p-5 sm:p-6 shadow-xl shadow-black/40 ${className}`}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.04] to-transparent pointer-events-none" />
      <div className="relative z-10">
        {title && (
          <h2 className="mb-4 text-xs font-bold uppercase tracking-widest text-zinc-500">
            {title}
          </h2>
        )}
        {children}
      </div>
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
