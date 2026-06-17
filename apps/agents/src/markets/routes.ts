import type { IncomingMessage, ServerResponse } from "node:http";
import {
  getMarket,
  getOrderBook,
  getPortfolio,
  getTrades,
  getVaultSummaryFromEnv,
  listChainOrders,
  listMarkets,
} from "./store.js";
import { corsFor } from "../http-cors.js";
import {
  fetchMatchSchedule,
  loadWorldCupConfig,
} from "../agents/world-cup-fetcher.js";
import {
  ELO,
  predictDrawProbability,
  predictYesProbability,
  teamStrengthTier,
} from "../agents/world-cup-maker.js";
import { upcomingWcMarkets } from "../agents/world-cup-resolver.js";
import {
  cacheStats,
  clearExtractionCache,
  extractFromUrl,
  type ExtractionSchema,
} from "../agents/llm-extractor.js";
import { recentExtractions } from "../agents/web-extractor.js";

function json(res: ServerResponse, status: number, body: unknown, sideEffecting = false) {
  // R35 audit fix: every markets response previously set "*" CORS.
  // The markets routes are read-only (list / detail / order book /
  // portfolio / vault summary), so the side-effecting flag is
  // false by default. Pass `sideEffecting=true` from any future
  // mutation endpoint. The shared helper applies the same
  // env-driven allowlist as gamification/routes.ts.
  res.writeHead(status, {
    "Content-Type": "application/json",
    ...corsFor(sideEffecting),
  });
  res.end(JSON.stringify(body));
}

export function handleMarketsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  if (req.method === "OPTIONS") {
    // Markets routes are read-only, so the preflight response uses
    // the open CORS. The shared helper still applies the allowlist
    // when ALLOWED_ORIGIN is set; this matches the no-side-effects
    // policy for /health, /decisions, /agents/manifest in
    // index.ts.
    //
    // R56 audit fix: also advertise POST/PUT/DELETE/PATCH in
    // Allow-Methods. A future contributor adding a
    // `POST /markets/:id/cancel` (e.g. a maker-bot cancel
    // endpoint) without updating this preflight would
    // silently have the browser block the request. Better
    // to advertise the full method set up front so a
    // preflight-pass / actual-block race never happens.
    // The `corsFor(true)` keep the allowlist restriction
    // consistent with the side-effecting methods we
    // permit here.
    res.writeHead(204, {
      ...corsFor(true),
      "Access-Control-Allow-Methods":
        "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    });
    res.end();
    return true;
  }

  if (req.method !== "GET") return false;

  if (url.pathname === "/markets") {
    // R63 audit fix: the previous handler used
    // `Number.isInteger(limit) && Number.isInteger(offset)` to
    // decide between the paginated and the un-paginated branch.
    // `Number(null) === 0` and `Number.isInteger(0) === true`,
    // so an un-parameterised `GET /markets` (no `?limit=` and no
    // `?offset=`) took the paginated branch with
    // `(limit=0, offset=0)` and called `listMarkets(0, 0)` —
    // SQLite's `LIMIT 0` returns 0 rows, so the home page's
    // `await listMarkets()` and the markets list's server-side
    // fetch both rendered the empty state, even when 47+ WC
    // markets existed. Route the no-params case through
    // `listMarkets()` (the un-paginated branch) by checking that
    // the raw query-string value is actually a positive integer
    // (not a coerced 0 from a missing param).
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    if (rawLimit !== null && rawOffset !== null) {
      const limit = Number(rawLimit);
      const offset = Number(rawOffset);
      if (
        Number.isInteger(limit) &&
        Number.isInteger(offset) &&
        limit > 0 &&
        offset >= 0
      ) {
        json(res, 200, listMarkets(limit, offset));
      } else {
        json(res, 400, {
          error: "limit must be a positive integer; offset must be a non-negative integer",
        });
      }
    } else if (rawLimit === null && rawOffset === null) {
      json(res, 200, listMarkets());
    } else {
      // One set, the other missing — reject so the caller knows
      // the param shape is wrong (vs. silently falling through
      // to the un-paginated branch and returning 50+ rows when
      // they expected a slice).
      json(res, 400, {
        error: "limit and offset must be provided together",
      });
    }
    return true;
  }

  if (url.pathname === "/vault/summary") {
    json(res, 200, getVaultSummaryFromEnv());
    return true;
  }

  const marketMatch = url.pathname.match(/^\/markets\/([^/]+)(\/book|\/orders|\/trades)?$/);
  if (marketMatch) {
    const [, id, sub] = marketMatch;
    const market = getMarket(id!);
    if (!market) {
      json(res, 404, { error: "market not found" });
      return true;
    }
    if (sub === "/book") {
      json(res, 200, getOrderBook(id!));
      return true;
    }
    if (sub === "/orders") {
      // R48 audit fix: cap the limit param so a malicious or naive
      // client can't request `limit=1e9` and hold the agents
      // worker on a 100k-row scan. Mirror the gamification
      // leaderboard route which caps at 500. Reject non-finite /
      // negative values.
      const raw = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 500)
        : 50;
      json(res, 200, { orders: listChainOrders(id!, limit) });
      return true;
    }
    if (sub === "/trades") {
      // R32 sweep fix: surface a JSON array of
      // recent trades for the market. The
      // SQLite `trades` table was being
      // populated by the resolver (and the
      // position-indexer) but the route
      // regex didn't recognize `/trades`,
      // so `/markets/<id>/trades` returned
      // a 404 with an empty body. The
      // market detail page didn't call
      // this endpoint (no UI), but
      // `docs/architecture.md` advertised
      // it as a public read endpoint, and
      // third-party tooling (e.g. the
      // audit bots in
      // `apps/agents/scripts/`) was
      // hitting it. Cap the limit at 200
      // (matches the order-book default).
      const raw = Number(url.searchParams.get("limit") ?? 50);
      const limit = Number.isFinite(raw) && raw > 0
        ? Math.min(raw, 200)
        : 50;
      json(res, 200, { trades: getTrades(id!, limit) });
      return true;
    }
    json(res, 200, market);
    return true;
  }

  const portfolioMatch = url.pathname.match(/^\/portfolio\/(0x[a-fA-F0-9]{64})$/);
  if (portfolioMatch) {
    const limit = Number(url.searchParams.get("limit"));
    const offset = Number(url.searchParams.get("offset"));
    if (Number.isInteger(limit) && Number.isInteger(offset)) {
      json(res, 200, getPortfolio(portfolioMatch[1]!, limit, offset));
    } else {
      json(res, 200, getPortfolio(portfolioMatch[1]!));
    }
    return true;
  }

  // World Cup 2026 endpoints (read-only, side-effecting=false)
  if (url.pathname === "/wc/groups") {
    loadWorldCupConfig()
      .then((groups) => json(res, 200, { groups }))
      .catch((err) =>
        json(res, 500, {
          error: "wc-fetcher unavailable",
          detail: err instanceof Error ? err.message : String(err),
          groups: [],
        }),
      );
    return true;
  }
  if (url.pathname === "/wc/schedule") {
    fetchMatchSchedule()
      .then((matches) => {
        // R57 audit fix: validate the `since` / `until` query
        // params. `Number("abc")` returns NaN and the filter
        // comparison `m.kickoffMs >= NaN` is always false,
        // silently producing an empty list. A missing
        // param or a negative number should fall back to the
        // default. Bound `until` to a sane horizon (10y) so
        // a typo'd `until=99999999999999` doesn't scan a
        // quadratic range on the agent.
        const rawSince = Number(url.searchParams.get("since") ?? 0);
        const rawUntil = Number(
          url.searchParams.get("until") ?? Date.now() + 365 * 86_400_000,
        );
        const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
        const until =
          Number.isFinite(rawUntil) && rawUntil > since
            ? Math.min(rawUntil, Date.now() + 10 * 365 * 86_400_000)
            : Date.now() + 365 * 86_400_000;
        const filtered = matches.filter(
          (m) => m.kickoffMs >= since && m.kickoffMs <= until,
        );
        json(res, 200, { matches: filtered });
      })
      .catch((err) =>
        json(res, 500, {
          error: "wc-fetcher unavailable",
          detail: err instanceof Error ? err.message : String(err),
          matches: [],
        }),
      );
    return true;
  }
  if (url.pathname === "/wc/upcoming") {
    // R57 audit fix: same NaN guard as `/wc/schedule`. Clamp
    // the window to [1min, 30d] so a typo'd
    // `windowMs=999999999` doesn't crash the indexer.
    const rawWindow = Number(
      url.searchParams.get("windowMs") ?? 24 * 60 * 60 * 1000,
    );
    const window = Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.min(Math.max(rawWindow, 60_000), 30 * 86_400_000)
      : 24 * 60 * 60 * 1000;
    json(res, 200, { upcoming: upcomingWcMarkets(window) });
    return true;
  }
  // LLM web-extractor endpoints
  if (url.pathname === "/wc/extract") {
    // One-shot extraction. Useful for ad-hoc investigations
    // ("did this friendly match really happen?") and for
    // debugging the LLM path.
    const targetUrl = url.searchParams.get("url");
    const schema = url.searchParams.get("schema") as ExtractionSchema | null;
    const bypass = url.searchParams.get("bypassCache") === "1";
    if (!targetUrl || !schema) {
      json(res, 400, {
        error: "missing required query params",
        required: ["url", "schema"],
        allowed_schemas: [
          "WcGroupTeams",
          "WcMatchResult",
          "WcFixture",
          "WcGroupStandings",
          "WcTopScorers",
          "Freeform",
        ],
      });
      return true;
    }
    // R58 audit fix: validate the URL is http(s) and on a
    // known WC-relevant host. SSRF protection — a malicious
    // caller could otherwise point the extractor at an
    // internal address (e.g. http://169.254.169.254/ AWS
    // metadata) and the agents service would forward the
    // response to OpenAI.
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      json(res, 400, { error: "url is not a valid URL" });
      return true;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      json(res, 400, { error: "only http(s) URLs are allowed" });
      return true;
    }
    const hostname = parsed.hostname.toLowerCase();
    const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.|169\.254\.|::1$|fe80:|fc|fd)/.test(
      hostname,
    );
    if (isPrivate) {
      json(res, 400, { error: "private/internal hostnames are blocked" });
      return true;
    }
    extractFromUrl(targetUrl, schema, { bypassCache: bypass })
      .then((result) => {
        if (!result) {
          json(res, 503, {
            error: "extraction failed (no key, fetch error, or invalid JSON)",
            url: targetUrl,
            schema,
          });
          return;
        }
        json(res, 200, result);
      })
      .catch((err) => {
        json(res, 500, {
          error: "extractor threw",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
    return true;
  }
  if (url.pathname === "/wc/sources") {
    // List the LLM-extraction events the WebExtractor
    // agent has written. The web /agents page uses this to
    // surface "cross-source verified" badges on resolved
    // markets.
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 50), 1),
      200,
    );
    json(res, 200, {
      events: recentExtractions(limit),
      cache_size: 0, // populated by the lru cache wrapper if used
    });
    return true;
  }
  if (url.pathname === "/wc/extract/cache") {
    // R58.H9 audit fix: plain GET returns the cache
    // contents + stats (size, max, hits, misses). The
    // pre-fix handler only matched `?action=clear` and
    // fell through to 404 for an unparameterised GET,
    // so a `curl /wc/extract/cache` to inspect the
    // LLM cache returned 404 even though the comment
    // implied the route existed for read access too.
    if (url.searchParams.get("action") === "clear") {
      const n = clearExtractionCache();
      json(res, 200, { cleared: n });
      return true;
    }
    const limit = Math.min(
      Math.max(Number(url.searchParams.get("limit") ?? 50), 1),
      500,
    );
    const rows = recentExtractions(limit);
    json(res, 200, {
      stats: cacheStats(),
      rows,
      limit,
    });
    return true;
  }
  if (url.pathname === "/wc/team-analysis") {
    // R-WC-2: per-team analysis feed for the
    // `WcTeamAnalysisCard` rendered behind every
    // World Cup market card on `/markets`. Returns
    // two parallel arrays:
    //   - `teams`:  48 rows keyed by ISO 3-letter
    //               code, one per qualified team.
    //               Includes Elo, tier, group /
    //               draw position, and the team's
    //               predicted win probability vs
    //               an "average opponent" baseline
    //               (Elo 1600).
    //   - `matches`: 72 rows keyed by match id
    //                (e.g. "A1vA3"), each with the
    //                head-to-head home / draw / away
    //                probabilities and the favorite
    //                side.
    //
    // The web client caches this response in
    // localStorage for 1h. The schedule and Elo
    // values are static for the duration of the
    // tournament (they only change on a re-draw),
    // so a 1h TTL is plenty.
    (async () => {
      try {
        const groups = await loadWorldCupConfig();
        const matches = await fetchMatchSchedule();
        const allTeams = groups.flatMap((g) =>
          g.teams.map((t) => ({
            ...t,
            group: g.letter,
            elo: ELO[t.code] ?? 1600,
          })),
        );
        // Rank teams globally by Elo desc. Ties
        // broken alphabetically (deterministic).
        const ranked = [...allTeams].sort((a, b) => {
          if (b.elo !== a.elo) return b.elo - a.elo;
          return a.code.localeCompare(b.code);
        });
        const rankByCode = new Map<string, number>();
        ranked.forEach((t, i) => rankByCode.set(t.code, i + 1));
        // Average opponent baseline = 1600 Elo.
        const winProbVsAvg = (elo: number): number => {
          const p = 1 / (1 + Math.pow(10, (1600 - elo) / 400));
          return Math.min(0.99, Math.max(0.01, p));
        };
        const teams = allTeams
          .map((t) => ({
            code: t.code,
            name: t.name,
            flag: t.flag,
            confederation: t.confederation,
            pot: t.pot,
            drawPosition: t.drawPosition,
            group: t.group,
            elo: t.elo,
            tier: teamStrengthTier(t.elo),
            rank: rankByCode.get(t.code) ?? 48,
            winProbVsAvg: winProbVsAvg(t.elo),
          }))
          // Stable order: by group letter, then by
          // draw position. A user scrolling the
          // "all 48 teams" view sees Group A's 4
          // teams, then Group B's, etc.
          .sort((a, b) => {
            if (a.group !== b.group) return a.group.localeCompare(b.group);
            return a.drawPosition.localeCompare(b.drawPosition);
          });
        // Build the per-match rows. We re-use the
        // maker's predictYesProbability for the
        // home side, then derive draw + away from
        // the same log5 decomposition.
        const matchRows = matches.map((m) => {
          const pYesHome = predictYesProbability(m);
          const pDraw = predictDrawProbability(m);
          // Invert the yes-prob to recover the
          // P(home | no draw) share, then split
          // back into P(home) + P(draw) + P(away)
          // = 1.
          const pHomeGivenNoDraw = pYesHome * (1 - pDraw) + pDraw / 2;
          const pHome = pHomeGivenNoDraw * (1 - pDraw);
          const pAway = (1 - pHomeGivenNoDraw) * (1 - pDraw);
          const eloDiff =
            (ELO[m.homeTeamCode] ?? 1600) -
            (ELO[m.awayTeamCode] ?? 1600);
          // R-WC-2: "toss-up" zone is a 5% window
          // around 50/50. The maker's quote at
          // kickoff is also 50/50 inside this band
          // (a flat half-spread on both sides), so
          // the favorite pill matches the book
          // signal.
          const favorite: "home" | "away" | "toss-up" =
            Math.abs(pHome - pAway) < 0.05
              ? "toss-up"
              : pHome > pAway
                ? "home"
                : "away";
          return {
            id: m.id,
            group: m.group,
            matchday: m.matchday,
            kickoffMs: m.kickoffMs,
            homeCode: m.homeTeamCode,
            awayCode: m.awayTeamCode,
            homeName: m.homeName,
            homeFlag: m.homeFlag,
            homeElo: ELO[m.homeTeamCode] ?? 1600,
            homeTier: teamStrengthTier(ELO[m.homeTeamCode] ?? 1600),
            awayName: m.awayName,
            awayFlag: m.awayFlag,
            awayElo: ELO[m.awayTeamCode] ?? 1600,
            awayTier: teamStrengthTier(ELO[m.awayTeamCode] ?? 1600),
            homeWinProb: pHome,
            drawProb: pDraw,
            awayWinProb: pAway,
            favorite,
            eloDiff,
          };
        });
        json(res, 200, {
          generatedAtMs: Date.now(),
          teams,
          matches: matchRows,
        });
      } catch (err) {
        json(res, 500, {
          error: "wc team-analysis failed",
          detail: err instanceof Error ? err.message : String(err),
          teams: [],
          matches: [],
        });
      }
    })();
    return true;
  }

  return false;
}
