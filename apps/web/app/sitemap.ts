import type { MetadataRoute } from "next";
import { listMarkets } from "@suipredict/sdk";

/**
 * Sitemap for the production web bundle.
 *
 * R33 sweep fix: the previous build had
 * no sitemap — a production deploy to
 * Vercel (or any other host) had no
 * machine-readable index of the public
 * routes. Google's crawler would have
 * to discover the markets list page by
 * following the home page link, and
 * individual market pages were
 * invisible to the indexer (no way
 * for crawlers to find them without a
 * full DOM walk of the home / markets
 * list / worldcup page). Adding a
 * dynamic sitemap that lists the home
 * page + the static routes + every
 * currently-active market id fixes
 * the SEO gap and gives the agents'
 * own "indexer" service a canonical
 * URL list to cross-reference.
 *
 * The sitemap is generated at request
 * time with `revalidate: 600` (10
 * minutes) so a freshly-created
 * market surfaces in the sitemap
 * within 10 minutes of its
 * `upsertMarket()` write. The Next.js
 * App Router caches the response for
 * 10 minutes; an aggressive operator
 * who wants a tighter loop can drop
 * the `revalidate` value.
 *
 * Routes included:
 *   - `/`            — home (changefreq: hourly)
 *   - `/markets`     — markets list (hourly)
 *   - `/worldcup`    — WC dashboard (hourly)
 *   - `/leaderboard` — leaderboard (daily)
 *   - `/vault`       — vault landing (daily)
 *   - `/parlay`      — parlay builder (daily)
 *   - `/portfolio`   — portfolio landing (daily)
 *   - `/friends`     — friends list (daily)
 *   - `/agents`      — agent dashboard (daily)
 *   - `/settings`    — settings (monthly)
 *   - `/auth`        — auth callback (monthly)
 *   - `/dispute/<id>` — dispute page (noindex)
 *   - `/markets/<id>` — per-market (per-market)
 *   - `/worldcup/group/<letter>` — per-group (weekly)
 *
 * Noindex: `/dispute/<id>`, `/auth`,
 * `/admin` — these are user-state
 * routes, not content pages.
 */
export const revalidate = 600;

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://suipredict.ai";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const routes: MetadataRoute.Sitemap = [
    {
      url: `${BASE}/`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 1.0,
    },
    {
      url: `${BASE}/markets`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${BASE}/worldcup`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.9,
    },
    {
      url: `${BASE}/leaderboard`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE}/vault`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${BASE}/parlay`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.7,
    },
    {
      url: `${BASE}/portfolio`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/friends`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/agents`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.6,
    },
    {
      url: `${BASE}/settings`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];

  // World Cup group pages. The 12 groups
  // (A-L) get a weekly cadence — the
  // schedule only changes once a week
  // mid-tournament, and the same page
  // serves the new fixtures.
  for (const letter of ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L"]) {
    routes.push({
      url: `${BASE}/worldcup/group/${letter}`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    });
  }

  // Per-market URLs. The agents service
  // is the source of truth; the sitemap
  // surfaces every active + resolved
  // market so the search-engine crawler
  // can index the page title + description.
  // `listMarkets()` returns the cached
  // SQLite mirror (RTT ~5ms on testnet)
  // and is wrapped in a try/catch so a
  // 5xx on the agents side never breaks
  // the sitemap render — an empty
  // `marketsUrls` array is fine; the
  // static routes still ship.
  let marketsUrls: MetadataRoute.Sitemap = [];
  try {
    const markets = await listMarkets();
    marketsUrls = markets.map((m) => ({
      url: `${BASE}/markets/${encodeURIComponent(m.id)}`,
      lastModified: now,
      changeFrequency: "hourly",
      priority: 0.8,
    }));
  } catch {
    // Best-effort: a transient agents outage
    // shouldn't take down the sitemap. The
    // 10-minute revalidate will retry on
    // the next request.
    marketsUrls = [];
  }

  return [...routes, ...marketsUrls];
}
