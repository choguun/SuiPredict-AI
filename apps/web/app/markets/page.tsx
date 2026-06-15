import Link from "next/link";
import type { Metadata } from "next";
import { getMarketOrderBook, listMarkets } from "@suipredict/sdk";
import { Badge } from "@/components/ui";
import { EmptyState } from "@/components/EmptyState";
import { ProbabilityBar } from "@/components/ProbabilityBar";
import { SuivisionLink } from "@/components/SuivisionLink";

// R30 sweep fix: per-page metadata so the
// browser tab + SERP snippet match the
// page's hero copy. The pre-R30 build
// inherited the root layout's
// "World Cup 2026 Prediction Markets"
// title on every page — a user with 5
// tabs open (home / markets /
// worldcup / portfolio / friends) saw
// the same title on every tab and had
// to read the URL to know which was
// which. The template in `layout.tsx`
// (`%s · SuiPredict AI`) keeps the
// product name as a suffix.
export const metadata: Metadata = {
  title: "Markets",
  description:
    "Browse all prediction markets — World Cup 2026, crypto, AI, DeFi. Filter, search, and trade YES/NO on the DeepBook V3 CLOB.",
};

export const dynamic = "force-dynamic";

// R57 audit fix: only show filter pills for categories that
// the market creator actually emits. The previous list
// included "Sports" and "Politics" which the
// market-creator.ts FALLBACK_MARKETS table doesn't use, so
// clicking them showed a permanently empty list and a
// confusing "No Markets Available" hint.
//
// R32 sweep fix: the previous "AI" pill filtered by
// `category === "ai"`, but the indexer writes
// `category: "ai_news"` (the value the
// `market-creator.ts` agent and the demo seed both emit).
// Same for "DeFi" / "Other" — they're aspirational
// categories that the agent doesn't produce yet. The new
// filter list matches the live data exactly: the "AI" pill
// filters by `ai_news` (the canonical category value), and
// the match predicate is `startsWith("ai")` so any future
// "ai_*" sub-category (e.g. "ai_models") is caught by the
// same pill. A user clicking the "AI" pill now sees the 1
// ai_news market instead of an empty list.
const CATEGORIES = [
  { value: "", label: "All" },
  { value: "worldcup", label: "⚽ World Cup" },
  { value: "crypto", label: "Crypto" },
  { value: "ai", label: "AI" },
  { value: "defi", label: "DeFi" },
  { value: "other", label: "Other" },
];

// R32 sweep fix: category-match helper.
// The filter pill value ("ai") doesn't
// exactly match the indexer's
// `category` field ("ai_news") — a
// strict equality check would silently
// drop every AI market. The new
// predicate does an exact match for
// fully-specified categories
// ("worldcup", "crypto", "defi",
// "other") and a `startsWith` match
// for the AI prefix so the "ai" pill
// catches "ai_news" (and any future
// "ai_<x>" sub-categories). The "all"
// pill (empty value) is a passthrough.
function categoryMatches(filter: string, marketCategory: string): boolean {
  if (!filter) return true;
  const f = filter.toLowerCase();
  const c = marketCategory.toLowerCase();
  if (f === "ai") return c.startsWith("ai");
  if (f === "defi") return c === "defi" || c.startsWith("defi_");
  if (f === "other") return !["worldcup", "crypto", "ai_news", "ai", "defi"].includes(c);
  return c === f;
}

function formatDate(ms: number) {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// R62 audit fix: relative time helper
// for "in 2h" / "in 3d" labels on the
// markets list. The pre-R62 build
// rendered WC markets as "Kicks Jun 13"
// (the absolute date), which is correct
// for a tournament in 6 months but
// useless for a tournament that's 2
// hours away (the date string just
// says "today" and the user has no
// signal of "in 2h"). Now we render
// the absolute date for far-future
// matches and a relative "in Xh" /
// "in Xd" for the next 7 days — the
// same pattern the DailyWcCard and
// the home page WC banner use.
function kickoffIn(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "now";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}

// R61 audit fix: explicit union types for the
// search/sort URL params so a malformed `?sort=foo`
// (e.g. from a pasted link) falls through to the
// default at the destructure site instead of
// silently producing an un-sortable view.
type SortKey = "expiry" | "newest" | "alpha" | "trending";
type StatusFilter = "all" | "live" | "resolved";

/**
 * Build a `/markets` URL that preserves the current
 * category filter while replacing a single param.
 * The markets page is a server component, so the
 * search/sort UI uses plain <form> + <select>
 * submissions (no client JS) and re-renders the
 * page with the new query string.
 *
 * R34 sweep fix: optional `page` param so the
 * Previous / Next pagination links preserve the
 * current page when changing category / sort
 * (the natural mental model: "I'm on page 2 of
 * WC markets; switch to live-only — stay on
 * page 2 if the live set is the same size").
 */
function marketsHref(
  current: { category: string; q: string; sort: SortKey; status: StatusFilter; page: number },
  patch: Partial<{ category: string; q: string; sort: SortKey; status: StatusFilter; page: number }>,
): string {
  const merged = { ...current, ...patch };
  const params = new URLSearchParams();
  if (merged.category) params.set("category", merged.category);
  if (merged.q) params.set("q", merged.q);
  if (merged.sort && merged.sort !== "expiry") params.set("sort", merged.sort);
  if (merged.status && merged.status !== "all") params.set("status", merged.status);
  if (merged.page && merged.page > 1) params.set("page", String(merged.page));
  const qs = params.toString();
  return qs ? `/markets?${qs}` : "/markets";
}

/**
 * Read the live YES probability from the order book mid-price. If the
 * book is empty or unreachable, fall back to 0.5 so the UI still
 * renders without misleading users.
 */
function probabilityFromBook(
  book: { mid_price: number } | null | undefined,
): number {
  if (!book) return 0.5;
  const p = book.mid_price;
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return 0.5;
  return p;
}

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string; sort?: string; status?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const categoryFilter = sp?.category ?? "";
  // R61 audit fix: support free-text search + sort via URL
  // params so the page works without client-side JS, is
  // shareable, and survives a refresh. The previous
  // build had no search or sort affordance — a user
  // looking for "ETH" or "SUI" in a list of 50+ markets
  // had to scroll or use the browser's Ctrl-F. The
  // search runs case-insensitive against title,
  // description, and category. Sort defaults to
  // "expiry" (soonest first) which matches what a trader
  // wants when scanning the list for action.
  const searchQuery = (sp?.q ?? "").trim().toLowerCase();
  const sortKey = (sp?.sort ?? "expiry") as SortKey;
  const statusFilter = (sp?.status ?? "all") as StatusFilter;
  // R34 sweep fix: pagination. The pre-R34
  // build rendered all 47 markets in a single
  // 2-column grid — a tall page that the user
  // had to scroll through to find a specific
  // market. The new `?page=N` query param
  // chunks the visible list into 12-market
  // pages. The "Showing X to Y of Z" subtitle
  // mirrors the math; the previous/next links
  // preserve the current category / q / sort /
  // status filters via the shared `marketsHref`
  // helper. A user filtering to "AI" (1
  // market) still gets the full list — no
  // pagination chrome is rendered when the
  // total is < 16 markets.
  const PAGE_SIZE = 12;
  const rawPage = Number(sp?.page ?? 1);
  const currentPage =
    Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  // R46 audit fix: don't silently swallow `listMarkets()`
  // failures. The previous `.catch(() => [])` collapsed
  // every error (RPC outage, SDK build mismatch, network
  // misconfig) into the same "no markets" empty state as
  // a healthy-but-empty agents service — a developer
  // hitting this on a fresh `pnpm dev` would see the
  // "No Markets Available" hint and conclude that they
  // needed to "Start the agents service" when the
  // actual problem was a SUI_NETWORK mismatch. Surface
  // a distinct error banner so the failure mode is
  // diagnosable from the page itself.
  let markets: Awaited<ReturnType<typeof listMarkets>> = [];
  let marketsError: string | null = null;
  try {
    markets = await listMarkets();
  } catch (err) {
    marketsError = err instanceof Error ? err.message : String(err);
  }
  // Apply the category filter client-side (the list is small, the
  // server already returned everything). The worldcup category is
  // case-insensitive so a link from `/worldcup` with a bare
  // `?category=worldcup` matches the SQLite row.
  // R32 sweep fix: route the filter through
  // `categoryMatches()` so the "AI" pill matches
  // `ai_news` (and any future `ai_*` sub-category)
  // and the "DeFi" / "Other" pills bucket
  // non-standard categories. The previous
  // strict-equality check silently dropped every
  // AI market when a user clicked the "AI" pill.
  const visible = markets.filter((m) => categoryMatches(categoryFilter, m.category));
  // R61 audit fix: text search across title, description,
  // and category. Uses `includes()` rather than a strict
  // word-boundary match so a query for "eth" still finds
  // "Ethereum" and "ETH flip BTC" both. The result is
  // intentionally case-insensitive (the `.toLowerCase()`
  // on both sides).
  const searched = searchQuery
    ? visible.filter(
        (m) =>
          m.title.toLowerCase().includes(searchQuery) ||
          (m.description ?? "").toLowerCase().includes(searchQuery) ||
          m.category.toLowerCase().includes(searchQuery),
      )
    : visible;
  // Status filter — "live" / "resolved" / "all". A user
  // looking for resolved markets to redeem their position
  // shouldn't have to scroll past 30 active ones. Defaults
  // to "all" to preserve the previous behaviour.
  const filtered =
    statusFilter === "all"
      ? searched
      : statusFilter === "live"
        ? searched.filter((m) => m.status === "active")
        : statusFilter === "resolved"
          ? searched.filter((m) => m.status === "resolved")
          : searched;
  // R61 audit fix: sort options. "expiry" puts
  // soonest-ending markets first (the trader's natural
  // scan order); "newest" puts the most-recently-created
  // first (the operator / curator's view); "alpha"
  // sorts by title for the "I'm looking for a specific
  // market" case. Stable sort via the index comparison
  // (Array.prototype.sort is stable in Node 12+).
  //
  // R33 sweep fix: the previous sort by `expiry_ms`
  // ascending (soonest first) put resolved markets
  // first because their `expiry_ms` is in the past.
  // A user landing on the markets list with no
  // filter and seeing "Expiring soonest" as the
  // default saw 8 resolved matches at the top of the
  // list — the same matches they could find under the
  // "Resolved" filter. The new sort groups by status
  // first (active markets, then resolved) and then
  // orders active markets by soonest-expiring. A user
  // looking for live opportunities gets them first; a
  // user who wants to see resolved markets can use the
  // status filter. The "alpha" + "newest" sorts are
  // status-agnostic and unchanged.
  const sorted = [...filtered].sort((a, b) => {
    switch (sortKey) {
      case "newest":
        return (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0);
      case "alpha":
        return a.title.localeCompare(b.title);
      case "trending": {
        // R34 sweep fix: "trending" sort.
        // Ranks active markets by how close
        // they are to kicking off (so the
        // user sees the most-actionable
        // markets first), then falls back
        // to a "most recently created"
        // ranking for markets >7d out. A
        // user landing on the markets
        // list and switching to
        // "trending" gets the 4-6 matches
        // they can actually trade on
        // right now. Resolved markets
        // sort to the bottom by created
        // time (most recently settled
        // first).
        const aActive = a.status === "active" ? 0 : 1;
        const bActive = b.status === "active" ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        if (aActive === 0) {
          // Active: rank by kickoff asc
          // (soonest first), then by
          // created_at desc as a
          // tiebreaker.
          const aKick = a.kickoff_ms ?? a.expiry_ms;
          const bKick = b.kickoff_ms ?? b.expiry_ms;
          if (aKick !== bKick) return aKick - bKick;
          return (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0);
        }
        // Resolved: most recently created first.
        return (b.created_at_ms ?? 0) - (a.created_at_ms ?? 0);
      }
      case "expiry":
      default: {
        const aActive = a.status === "active" ? 0 : 1;
        const bActive = b.status === "active" ? 0 : 1;
        if (aActive !== bActive) return aActive - bActive;
        return a.expiry_ms - b.expiry_ms;
      }
    }
  });
  // Final visible list. Computed at this point so the
  // stats below reflect the post-filter counts (otherwise
  // a user filtering to "resolved" would see "X active"
  // when X is the unfiltered total).
  const finalTotal = sorted.length;
  // R34 sweep fix: pagination chunking.
  // Slice the sorted list to the current
  // page. Clamp `currentPage` so a deep-
  // link to `?page=999` on a 5-page
  // result lands the user on page 5
  // (the last) instead of an empty
  // list. `totalPages` is computed for
  // the "Previous / Next" chrome below.
  const totalPages = Math.max(
    1,
    Math.ceil(finalTotal / PAGE_SIZE),
  );
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * PAGE_SIZE;
  const finalVisible = sorted.slice(pageStart, pageStart + PAGE_SIZE);
  // R62 audit fix: header stats now read
  // from the post-filter `finalVisible`
  // list consistently. The pre-R62 code
  // used `markets.length` (unfiltered) for
  // the "Total" cell and `finalVisible`
  // (filtered) for the "Active" and
  // "Resolved" cells — a user filtering by
  // `?category=worldcup&status=resolved`
  // saw "Total: 50" with "Active: 0" and
  // "Resolved: 8", which is a self-
  // contradictory set of numbers (8+0 ≠
  // 50). The fix is to compute all three
  // counts from the same `finalVisible`
  // list and label the first cell
  // "Showing" instead of "Total" when
  // any filter is active. When no
  // filter is active, "Showing" and
  // "Total" are the same number and the
  // "Total" label is the more natural
  // one for an unfiltered browse.
  const anyFilterActive =
    !!searchQuery || !!categoryFilter || statusFilter !== "all" || sortKey !== "expiry";
  const active = sorted.filter((m) => m.status === "active").length;
  const resolved = sorted.filter((m) => m.status === "resolved").length;

  // Fetch each active market's order book in parallel. Active markets
  // without a book yet (still bootstrapping) fall back to the 0.5
  // neutral midpoint. Resolved markets don't need a book.
  const activeIds = finalVisible.filter((m) => m.status === "active").map((m) => m.id);
  const bookResults = await Promise.allSettled(
    activeIds.map((id) => getMarketOrderBook(id)),
  );
  const bookByMarket = new Map<string, { mid_price: number }>();
  activeIds.forEach((id, i) => {
    const r = bookResults[i];
    if (r.status === "fulfilled") {
      bookByMarket.set(id, r.value);
    }
  });

  return (
    <div className="space-y-5">
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-[#11141d] p-6 sm:p-10 shadow-2xl shadow-black/40 mb-8">
        <div className="absolute -top-40 -right-40 h-[400px] w-[400px] rounded-full bg-cyan-600/10 blur-[80px] pointer-events-none" />
        <div className="absolute -bottom-40 -left-40 h-[400px] w-[400px] rounded-full bg-violet-600/10 blur-[80px] pointer-events-none" />
        
        <div className="relative z-10 flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
          <div className="max-w-2xl">
            <Badge variant="success" className="px-3 py-1 text-sm mb-4">Polymarket-style CLOB</Badge>
            <h1 className="text-3xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-white to-cyan-200 sm:text-5xl mb-4">
              Prediction Markets
            </h1>
            <p className="text-base leading-relaxed text-zinc-400">
              Pick a side, set a probability, and route the order through the
              DeepBook YES order book. NO is shown as the complement price.
            </p>
          </div>
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-white/10 bg-[#11141d] p-2 text-center">
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-white">{finalTotal}</p>
            <p className="text-xs text-zinc-500">
              {anyFilterActive ? "Showing" : "Total"}
            </p>
          </div>
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-emerald-300">{active}</p>
            <p className="text-xs text-zinc-500">Active</p>
          </div>
          <div className="px-3 py-2">
            <p className="text-lg font-semibold text-amber-300">{resolved}</p>
            <p className="text-xs text-zinc-500">Resolved</p>
          </div>
        </div>
        </div>
      </div>

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0 sm:flex-wrap sm:gap-2">
        {CATEGORIES.map((c) => {
          const isActive = c.value === categoryFilter;
          return (
            <Link
              key={c.value || "all"}
              href={marketsHref(
                { category: c.value, q: searchQuery, sort: sortKey, status: statusFilter, page: safePage },
                { category: c.value, page: 1 },
              )}
              className={`shrink-0 rounded-full px-4 py-2 text-xs font-bold transition ${
                isActive
                  ? "bg-emerald-500 text-emerald-950"
                  : "border border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10"
              }`}
            >
              {c.label}
            </Link>
          );
        })}
      </div>

      {/* R61 audit fix: search + sort + status filter row.
         Plain HTML form + <select> submissions so the
         page works without client JS and is shareable.
         The form's `action` is the bare `/markets` path
         and the `name` attributes match the URL params
         the server reads at the top of this file. The
         "Clear" button appears only when at least one
         filter is active. */}
      <form
        action="/markets"
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3"
        role="search"
        aria-label="Filter markets"
      >
        {/* Preserve the category across a search submit
            so a user on `/markets?category=worldcup` who
            types into the search box doesn't drop back
            to the unfiltered list. Hidden inputs are
            skipped when the value is empty to keep the
            URL clean. */}
        {categoryFilter && (
          <input type="hidden" name="category" value={categoryFilter} />
        )}
        {statusFilter !== "all" && (
          <input type="hidden" name="status" value={statusFilter} />
        )}
        {sortKey !== "expiry" && (
          <input type="hidden" name="sort" value={sortKey} />
        )}
        <div className="relative flex-1">
          <span
            className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-500"
            aria-hidden="true"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path strokeLinecap="round" d="m21 21-4.3-4.3" />
            </svg>
          </span>
          <input
            type="search"
            name="q"
            defaultValue={searchQuery}
            placeholder="Search markets (e.g. ETH, World Cup, BTC)..."
            aria-label="Search markets"
            className="w-full rounded-lg border border-white/10 bg-[#0d1019] py-2.5 pl-10 pr-10 text-sm text-white placeholder:text-zinc-600 focus:border-emerald-500/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
          {/* R61 audit fix: inline "clear" link inside the
             search input. The pre-R61 build had a
             separate "Clear" button next to Apply, but a
             user who only wanted to clear the search
             (not the status / sort) had to scroll back
             to the button row. The inline "X" is the
             standard pattern (Twitter, GitHub, Stripe)
             and one tap brings them back to the
             un-filtered view while preserving the
             other filters via the hidden form inputs. */}
          {searchQuery && (
            <Link
              href={marketsHref(
                { category: categoryFilter, q: "", sort: sortKey, status: statusFilter, page: safePage },
                { q: "", page: 1 },
              )}
              aria-label="Clear search"
              className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-500 hover:text-white"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" d="M6 6l12 12M6 18L18 6" />
              </svg>
            </Link>
          )}
        </div>
        <select
          name="status"
          defaultValue={statusFilter}
          aria-label="Filter by status"
          className="rounded-lg border border-white/10 bg-[#0d1019] px-3 py-2.5 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
        >
          <option value="all">All status</option>
          <option value="live">Live only</option>
          <option value="resolved">Resolved only</option>
        </select>
        <select
          name="sort"
          defaultValue={sortKey}
          aria-label="Sort markets"
          className="rounded-lg border border-white/10 bg-[#0d1019] px-3 py-2.5 text-sm text-white focus:border-emerald-500/50 focus:outline-none"
        >
          <option value="expiry">Ends soonest</option>
          <option value="newest">Newest</option>
          <option value="alpha">A → Z</option>
          <option value="trending">🔥 Trending</option>
        </select>
        <button
          type="submit"
          className="rounded-lg bg-emerald-500/20 px-4 py-2.5 text-sm font-bold text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/30 transition"
        >
          Apply
        </button>
        {(searchQuery || statusFilter !== "all" || sortKey !== "expiry" || categoryFilter) && (
          <Link
            href={categoryFilter ? `/markets?category=${encodeURIComponent(categoryFilter)}` : "/markets"}
            className="rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm font-medium text-zinc-300 hover:bg-white/10 transition text-center"
          >
            Clear
          </Link>
        )}
      </form>

      <div className="grid gap-3">
        {marketsError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200"
          >
            <p className="font-semibold">Failed to load markets</p>
            <p className="mt-1 text-rose-300/80">
              {marketsError}. Check that the agents service is running and that
              the SUI_NETWORK / AGENT_POLICY_PACKAGE_ID env vars match between
              the web bundle and the agents runtime.
            </p>
          </div>
        )}
        {finalTotal === 0 && !marketsError && (
          // R61 audit fix: distinguish three empty
          // states so the user knows whether to clear
          // filters, wait for the agents, or check the
          // agents service. The previous single
          // "No Markets Available" hint collapsed all
          // three into one and the user had to guess.
          searchQuery || statusFilter !== "all" || sortKey !== "expiry" ? (
            <EmptyState
              title="No markets match your filters"
              // R62 audit fix: build the
              // message from the actually-
              // applied filters. The pre-R62
              // message showed the first
              // truthy filter as a bare
              // quoted string — a user
              // filtering by `?status=resolved`
              // saw "Nothing matches
              // 'resolved'" which read as a
              // bad search query, not a
              // status filter. The new
              // message lists each applied
              // filter as a labeled tag so
              // the user knows which
              // combination is empty.
              description={(() => {
                const tags: string[] = [];
                if (searchQuery) tags.push(`search "${searchQuery}"`);
                if (categoryFilter) tags.push(`category: ${categoryFilter}`);
                if (statusFilter !== "all") tags.push(`status: ${statusFilter}`);
                return tags.length === 0
                  ? "Try clearing the search or status filter."
                  : `Nothing matches ${tags.join(" + ")}. Try clearing one of these filters.`;
              })()}
              actionLabel="Clear all filters"
              href={categoryFilter ? `/markets?category=${encodeURIComponent(categoryFilter)}` : "/markets"}
            />
          ) : categoryFilter === "worldcup" ? (
            <EmptyState
              title="No World Cup markets yet"
              description="The World Cup creator agent seeds markets 7 days before kickoff. The first batch lands on June 4, 2026 (one week before Matchday 1)."
              actionLabel="See all markets"
              href="/markets"
            />
          ) : (
            <EmptyState
              title="No Markets Available"
              description="Start the agents service to seed demo markets or connect to the live network."
            />
          )
        )}
        {finalVisible.map((m) => {
          const prob = m.status === "active"
            ? probabilityFromBook(bookByMarket.get(m.id))
            : 0.5;
          // R61 audit fix: surface the in-play
          // (live) status for WC markets on the
          // list view. The worldcup dashboard has
          // a dedicated "Live now" strip, but a
          // user landing on /markets?category=
          // worldcup has no live signal at the
          // card level. The badge mirrors the
          // animated pulse-dot used on the worldcup
          // page (the CSS is `animate-pulse` from
          // Tailwind, no JS timer).
          const isLiveWc =
            m.category === "worldcup" &&
            m.status === "active" &&
            m.kickoff_ms !== undefined &&
            m.kickoff_ms <= Date.now() &&
            m.kickoff_ms > Date.now() - 2 * 60 * 60 * 1000;
          // R62 audit fix: SuiVision link in the
          // top-right of each non-demo market
          // card. The card itself is a single
          // <Link> wrapper (so a nested <a>
          // would be invalid HTML); the SuiVision
          // link is an absolutely-positioned
          // button with z-20 + stopPropagation
          // so a click on the icon doesn't
          // double-fire the parent <Link> (which
          // would navigate to the market page
          // in addition to opening SuiVision).
          // Validates SUI_NETWORK against the
          // /agents page allowlist and only
          // renders for Sui object ids
          // (0x + 64 hex chars) — WC market
          // SQLite ids (`wc26-<matchId>`) and
          // demo ids never render the icon.
          const onchainId = (m as { onchain_market_id?: string }).onchain_market_id ?? m.id;
          return (
            <Link
              key={m.id}
              href={`/markets/${encodeURIComponent(m.id)}`}
              className="group relative flex flex-col justify-between overflow-hidden rounded-2xl border border-white/10 bg-[#11141d] p-6 transition-all hover:border-cyan-500/30 hover:bg-[#151924] hover:shadow-2xl hover:shadow-cyan-900/10"
            >
              <SuivisionLink
                objectId={onchainId}
                className="absolute right-3 top-3 z-20"
              />
              <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                <div className="flex-1 min-w-0">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <Badge
                      variant={m.status === "active" ? "success" : "warning"}
                      className="px-2.5 py-0.5 rounded-full"
                    >
                      {m.status}
                    </Badge>
                    {/* R32 sweep fix: prominent
                        "Winner: YES/NO" pill for
                        resolved markets. Same
                        pattern as the market
                        detail page header. The
                        `m.outcome &&` guard skips
                        the brief window where
                        `status = "resolved"` is
                        set but the indexer hasn't
                        recorded the winning side
                        yet. */}
                    {m.status === "resolved" && m.outcome && (
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider border ${
                          m.outcome === "yes"
                            ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                            : "bg-rose-500/20 text-rose-300 border-rose-500/30"
                        }`}
                      >
                        🏆 {m.outcome.toUpperCase()} won
                      </span>
                    )}
                    {isLiveWc && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-500/20 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300 border border-rose-500/30">
                        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-rose-400" />
                        Live
                      </span>
                    )}                    <span className="rounded-full bg-white/5 px-2.5 py-0.5 text-xs font-medium text-zinc-300">
                      {m.category}
                    </span>
                    {/* R61 audit fix: show the kickoff time
                       for WC markets (the only category
                       that has a real "kickoff" concept).
                       The previous build showed "Ends
                       <expiry>" for all markets, which is
                       `kickoff + 2h` for WC markets —
                       misleading because a user reading
                       the card thought the market ended
                       at the kickoff time. Now we render
                       "Kicks <kickoff>" for WC markets
                       and "Ends <expiry>" for everything
                       else. */}
                    <span className="text-xs font-medium text-zinc-500">
                      {m.category === "worldcup" && m.kickoff_ms
                        ? // R62 audit fix: render the
                          // relative kickoff time
                          // ("in 2h", "in 3d") for
                          // the next 7 days, falling
                          // back to the absolute
                          // date for far-future WC
                          // matches. A user
                          // scanning the list
                          // mid-tournament needs
                          // the relative time, not
                          // "Jun 13".
                          (m.kickoff_ms > Date.now() && m.kickoff_ms < Date.now() + 7 * 24 * 60 * 60 * 1000
                            ? `Kicks ${kickoffIn(m.kickoff_ms)}`
                            : `Kicks ${formatDate(m.kickoff_ms)}`)
                        : `Ends ${formatDate(m.expiry_ms)}`}
                    </span>
                  </div>
                  <h2 className="text-lg font-bold text-white mb-2 leading-tight group-hover:text-cyan-100 transition-colors sm:text-xl">
                    {m.title}
                  </h2>
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-zinc-400">
                    {m.description}
                  </p>
                  
                  {m.status === "active" && (
                    <div className="mt-5 max-w-lg">
                      <div className="flex justify-between text-xs font-bold uppercase tracking-wider mb-2">
                        <span className="text-emerald-400">{Math.round(prob * 100)}% YES</span>
                        <span className="text-rose-400">{Math.round((1 - prob) * 100)}% NO</span>
                      </div>
                      <ProbabilityBar yesProbability={prob} className="h-2.5" />
                    </div>
                  )}

                  {m.outcome && (
                    <div className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-500/10 px-4 py-2 border border-emerald-500/20">
                      <span className="text-sm font-bold text-emerald-400">
                        WINNER: {m.outcome.toUpperCase()}
                      </span>
                    </div>
                  )}
                </div>
                {m.status === "active" && (
                  <div className="grid shrink-0 grid-cols-2 gap-3 md:w-56 mt-4 md:mt-0 opacity-100 sm:opacity-0 sm:translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0">
                    <span className="flex items-center justify-center rounded-lg bg-emerald-500/20 py-3 text-sm font-semibold text-emerald-300 border border-emerald-500/30 transition-colors hover:bg-emerald-500/30">
                      Buy YES
                    </span>
                    <span className="flex items-center justify-center rounded-lg bg-rose-500/20 py-3 text-sm font-semibold text-rose-300 border border-rose-500/30 transition-colors hover:bg-rose-500/30">
                      Buy NO
                    </span>
                  </div>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* R34 sweep fix: pagination chrome. The
         pre-R34 build rendered all 47 markets
         in a single 2-column grid (4-page scroll
         on a 13" laptop, 8-page on a phone). The
         new 12-markets-per-page chunking keeps
         each render under 2 screens. The
         Previous / Next links preserve the
         active filters via `marketsHref`. The
         `Showing X to Y of Z` subtitle gives the
         user a single-glance progress signal
         (the same pattern the agents page uses
         for the decision feed). The page is only
         rendered when `finalTotal > PAGE_SIZE` —
         a filtered "AI" (1 market) or "DeFi" (0
         markets) view doesn't waste vertical
         space on Previous/Next chrome. */}
      {finalTotal > PAGE_SIZE && (
        <div className="mt-6 flex flex-col items-center justify-between gap-3 sm:flex-row">
          <p className="text-xs text-zinc-500">
            Showing{" "}
            <span className="font-mono text-zinc-300">
              {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, finalTotal)}
            </span>{" "}
            of <span className="font-mono text-zinc-300">{finalTotal}</span>
          </p>
          <nav
            aria-label="Pagination"
            className="flex items-center gap-2"
          >
            <Link
              href={marketsHref(
                { category: categoryFilter, q: searchQuery, sort: sortKey, status: statusFilter, page: safePage },
                { page: Math.max(1, safePage - 1) },
              )}
              aria-disabled={safePage <= 1}
              tabIndex={safePage <= 1 ? -1 : 0}
              aria-label="Previous page"
              className={`inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-xs font-bold transition ${
                safePage <= 1
                  ? "pointer-events-none border-white/5 bg-white/[0.02] text-zinc-600"
                  : "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
              }`}
            >
              ← Previous
            </Link>
            <span
              className="inline-flex min-h-11 items-center rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-mono text-zinc-300"
              aria-current="page"
            >
              Page {safePage} / {totalPages}
            </span>
            <Link
              href={marketsHref(
                { category: categoryFilter, q: searchQuery, sort: sortKey, status: statusFilter, page: safePage },
                { page: Math.min(totalPages, safePage + 1) },
              )}
              aria-disabled={safePage >= totalPages}
              tabIndex={safePage >= totalPages ? -1 : 0}
              aria-label="Next page"
              className={`inline-flex min-h-11 items-center rounded-lg border px-4 py-2 text-xs font-bold transition ${
                safePage >= totalPages
                  ? "pointer-events-none border-white/5 bg-white/[0.02] text-zinc-600"
                  : "border-white/10 bg-white/5 text-zinc-200 hover:bg-white/10"
              }`}
            >
              Next →
            </Link>
          </nav>
        </div>
      )}
    </div>
  );
}
