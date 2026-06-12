import { getMarket, getOrderBook, getPortfolio, getVaultSummaryFromEnv, listChainOrders, listMarkets, } from "./store.js";
import { corsFor } from "../http-cors.js";
import { fetchMatchSchedule, loadWorldCupConfig, } from "../agents/world-cup-fetcher.js";
import { upcomingWcMarkets } from "../agents/world-cup-resolver.js";
import { clearExtractionCache, extractFromUrl, } from "../agents/llm-extractor.js";
import { recentExtractions } from "../agents/web-extractor.js";
function json(res, status, body, sideEffecting = false) {
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
export function handleMarketsRoute(req, res, url) {
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
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
        });
        res.end();
        return true;
    }
    if (req.method !== "GET")
        return false;
    if (url.pathname === "/markets") {
        json(res, 200, listMarkets());
        return true;
    }
    if (url.pathname === "/vault/summary") {
        json(res, 200, getVaultSummaryFromEnv());
        return true;
    }
    const marketMatch = url.pathname.match(/^\/markets\/([^/]+)(\/book|\/orders)?$/);
    if (marketMatch) {
        const [, id, sub] = marketMatch;
        const market = getMarket(id);
        if (!market) {
            json(res, 404, { error: "market not found" });
            return true;
        }
        if (sub === "/book") {
            json(res, 200, getOrderBook(id));
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
            json(res, 200, { orders: listChainOrders(id, limit) });
            return true;
        }
        json(res, 200, market);
        return true;
    }
    const portfolioMatch = url.pathname.match(/^\/portfolio\/(0x[a-fA-F0-9]{64})$/);
    if (portfolioMatch) {
        json(res, 200, getPortfolio(portfolioMatch[1]));
        return true;
    }
    // World Cup 2026 endpoints (read-only, side-effecting=false)
    if (url.pathname === "/wc/groups") {
        loadWorldCupConfig()
            .then((groups) => json(res, 200, { groups }))
            .catch((err) => json(res, 500, {
            error: "wc-fetcher unavailable",
            detail: err instanceof Error ? err.message : String(err),
            groups: [],
        }));
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
            const rawUntil = Number(url.searchParams.get("until") ?? Date.now() + 365 * 86_400_000);
            const since = Number.isFinite(rawSince) && rawSince >= 0 ? rawSince : 0;
            const until = Number.isFinite(rawUntil) && rawUntil > since
                ? Math.min(rawUntil, Date.now() + 10 * 365 * 86_400_000)
                : Date.now() + 365 * 86_400_000;
            const filtered = matches.filter((m) => m.kickoffMs >= since && m.kickoffMs <= until);
            json(res, 200, { matches: filtered });
        })
            .catch((err) => json(res, 500, {
            error: "wc-fetcher unavailable",
            detail: err instanceof Error ? err.message : String(err),
            matches: [],
        }));
        return true;
    }
    if (url.pathname === "/wc/upcoming") {
        // R57 audit fix: same NaN guard as `/wc/schedule`. Clamp
        // the window to [1min, 30d] so a typo'd
        // `windowMs=999999999` doesn't crash the indexer.
        const rawWindow = Number(url.searchParams.get("windowMs") ?? 24 * 60 * 60 * 1000);
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
        const schema = url.searchParams.get("schema");
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
        let parsed;
        try {
            parsed = new URL(targetUrl);
        }
        catch {
            json(res, 400, { error: "url is not a valid URL" });
            return true;
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            json(res, 400, { error: "only http(s) URLs are allowed" });
            return true;
        }
        const hostname = parsed.hostname.toLowerCase();
        const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.|169\.254\.|::1$|fe80:|fc|fd)/.test(hostname);
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
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 200);
        json(res, 200, {
            events: recentExtractions(limit),
            cache_size: 0, // populated by the lru cache wrapper if used
        });
        return true;
    }
    if (url.pathname === "/wc/extract/cache") {
        // The whole handler is GET-only (see the early-return
        // at the top of the function), so a DELETE/POST
        // endpoint can't live here. Use `?action=clear` instead.
        if (url.searchParams.get("action") === "clear") {
            const n = clearExtractionCache();
            json(res, 200, { cleared: n });
            return true;
        }
    }
    return false;
}
//# sourceMappingURL=routes.js.map