export default function GlobalLoading() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-10 w-48 rounded-lg bg-white/5" />
      <div className="h-6 w-96 rounded-lg bg-white/5" />
      
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mt-8">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-lg border border-white/5 bg-white/[0.02]" />
        ))}
      </div>
      
      <div className="mt-8 h-[400px] rounded-lg border border-white/5 bg-white/[0.02]" />
    </div>
  );
}
