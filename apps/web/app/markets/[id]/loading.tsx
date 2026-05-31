export default function MarketDetailLoading() {
  return (
    <div className="space-y-5 animate-pulse">
      <div className="h-5 w-32 rounded-lg bg-white/5" />
      
      <div className="rounded-lg border border-white/10 bg-[#11141d] p-5 sm:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="w-full">
            <div className="mb-3 flex gap-2">
              <div className="h-6 w-16 rounded-full bg-white/5" />
              <div className="h-6 w-24 rounded-full bg-white/5" />
            </div>
            <div className="h-10 w-2/3 rounded-lg bg-white/5" />
            <div className="mt-3 h-16 w-full rounded-lg bg-white/5" />
          </div>
          <div className="grid min-w-full grid-cols-2 gap-2 sm:min-w-72">
            <div className="h-24 rounded-lg bg-white/5" />
            <div className="h-24 rounded-lg bg-white/5" />
          </div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="order-2 h-96 rounded-lg border border-white/10 bg-white/[0.02] lg:order-1" />
        <div className="order-1 h-[400px] rounded-lg border border-white/10 bg-white/[0.02] lg:order-2" />
      </div>
    </div>
  );
}
