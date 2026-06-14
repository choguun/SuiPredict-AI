import type { MetadataRoute } from "next";

/**
 * robots.txt for the production web
 * bundle. Default-allow the public
 * routes and explicit-disallow the
 * user-state ones (auth callback,
 * dispute form, admin panel).
 *
 * R33 sweep fix: the previous build
 * had no robots.txt at all — a
 * production deploy served the
 * default empty robots.txt which
 * crawlers interpreted as "allow
 * everything". The auth callback at
 * /auth and the admin panel at
 * /admin should never be indexed:
 * the auth callback has no real
 * content (a `meta refresh` to the
 * home page after zkLogin), and the
 * admin panel is meant to be a
 * bookmarked surface for the
 * operator only. The dispute form
 * at `/dispute/<id>` is also
 * disallow'd because a 3rd-party
 * could craft a URL that opens a
 * dispute submission for an
 * arbitrary market id, and we don't
 * want crawlers to surface that
 * surface in search.
 *
 * The sitemap is pointed at via the
 * `Sitemap:` directive so the major
 * crawlers (Google, Bing, Yandex,
 * Baidu) discover it within one
 * crawl cycle. The robots file is
 * served with `revalidate: 86400` so
 * the operator can change the
 * disallow list without redeploying.
 */
export const revalidate = 86_400;

const BASE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://suipredict.ai";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: [
          "/",
          "/markets",
          "/worldcup",
          "/leaderboard",
          "/vault",
          "/parlay",
          "/portfolio",
          "/friends",
          "/agents",
          "/settings",
        ],
        disallow: [
          "/auth",
          "/admin",
          "/dispute/",
          "/api/",
          "/_next/",
          "/marketOrders/",
          "/orders/",
        ],
      },
      // Googlebot: same rules but
      // explicit-allow the per-market
      // and per-group routes (the
      // wildcard allow above already
      // covers them, but listing them
      // explicitly is the SEO audit
      // checklist recommendation).
      {
        userAgent: "Googlebot",
        allow: [
          "/",
          "/markets",
          "/markets/*",
          "/worldcup",
          "/worldcup/group/*",
          "/leaderboard",
          "/vault",
          "/parlay",
          "/portfolio",
          "/friends",
          "/agents",
          "/settings",
        ],
        disallow: [
          "/auth",
          "/admin",
          "/dispute/",
          "/api/",
        ],
      },
    ],
    sitemap: `${BASE}/sitemap.xml`,
    host: BASE,
  };
}
