export function Tooltip({
  content,
  children,
}: {
  content: string | React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="group relative inline-flex">
      {children}
      <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 -translate-x-1/2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <div className="w-max max-w-xs rounded-md border border-white/10 bg-black/90 px-3 py-2 text-xs text-white shadow-xl backdrop-blur-md">
          {content}
        </div>
        <div className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-8 border-transparent border-t-black/90" />
      </div>
    </div>
  );
}
