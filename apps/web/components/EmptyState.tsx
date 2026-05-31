export function EmptyState({
  title,
  description,
  actionLabel,
  onAction,
}: {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-white/5 bg-black/20 p-8 text-center backdrop-blur-md">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-zinc-500">
        <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m3.75 9v6m3-3H9m1.5-12H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
        </svg>
      </div>
      <h3 className="mb-1 text-lg font-medium text-white">{title}</h3>
      <p className="mb-5 max-w-sm text-sm text-zinc-400">{description}</p>
      {actionLabel && onAction && (
        <button
          onClick={onAction}
          className="rounded-lg bg-gradient-to-r from-violet-600 to-cyan-600 px-5 py-2.5 text-sm font-medium text-white shadow-lg shadow-cyan-900/20 transition-all hover:scale-[1.02] hover:shadow-cyan-900/40"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
