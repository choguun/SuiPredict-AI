// apps/web/public/sw.js
// =============================================================================
// Minimal service worker for the SuiPredict-AI web app.
//
// UAT-FN-17 fix: the README claims "Next.js 15 PWA" but the
// pre-fix build had no service worker registered. A user going
// offline (subway between stops, plane mode, dead wifi zone)
// would see the browser's raw `chrome-error://chromewebdata/`
// page with an empty dark body. This SW is a hand-rolled
// alternative to `@ducanh2912/next-pwa` (which the
// pre-existing R48 audit disabled because its Workbox
// `NetworkFirst` cache served stale HTML for up to 24h).
//
// The goals here are deliberately narrow:
//   1. Survive an offline reload by serving `offline.html`
//      for navigation requests when the network is unreachable.
//   2. Pass through all other requests with no caching.
//   3. Skip caching static assets (JS chunks, fonts, images)
//      so a stale build is never served.
//
// This is NOT a full PWA: there's no `manifest.json` install
// flow, no push notifications, no background sync. The
// README claim of "PWA" should be replaced with "offline
// shell" (or "offline fallback page") to match the
// narrower scope. UAT-FN-17 follow-up suggestion: update
// README accordingly.
//
// The `__SW_VERSION__` placeholder is replaced by the
// build script in `scripts/build-sw.mjs` (or by the
// timestamp at install time if no build script is run).
// Bumping the version forces the new SW to take over
// from any previously-installed one and clears the
// old cache.
// =============================================================================

const SW_VERSION = "__SW_VERSION__";
const CACHE_NAME = `suipredict-shell-${SW_VERSION}`;
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  // Pre-cache the offline shell so a first-time offline
  // reload (the user has never visited the app while
  // online) can still render something useful. The
  // cache.add() call uses `fetch` internally, so it
  // must complete before the SW can serve the
  // pre-cached response.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // `cache.add` rejects on a non-2xx response. Wrap
      // in try/catch so a missing `offline.html` (e.g.
      // during a partial deploy) doesn't fail the SW
      // install — the runtime navigation handler falls
      // back to a synthesized response below.
      try {
        await cache.add(new Request(OFFLINE_URL, { cache: "reload" }));
      } catch {
        // offline.html missing; runtime fallback applies.
      }
      // Activate the new SW immediately. The default
      // behaviour is to wait until all clients are
      // closed, which is rarely what the operator wants
      // after a deploy.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  // Drop any old caches (e.g. the Workbox cache the R48
  // audit found serving 24h-stale HTML). The cache name
  // includes the version, so changing the version is
  // enough to evict everything.
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((n) => n !== CACHE_NAME)
          .map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  // Only handle GET. POST/PUT/DELETE go straight to the
  // network (and would fail offline without a separate
  // sync queue, which is out of scope for the offline
  // shell).
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Same-origin only. Cross-origin requests (RPC,
  // SuiVision, Sui fullnode, fonts.googleapis) are
  // left alone so we don't introduce a stale-cache
  // bug on a third-party CDN.
  if (url.origin !== self.location.origin) return;

  // Navigation requests: try the network first, fall
  // back to the pre-cached offline shell on failure.
  // This is the only path that uses the cache — the
  // SW never serves a cached HTML for a successful
  // network response, so there's no stale-HTML
  // exposure (the bug the R48 audit fixed on the
  // legacy Workbox SW).
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          return fresh;
        } catch {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(OFFLINE_URL);
          if (cached) return cached;
          // Synthesize a minimal offline response if
          // the pre-cache failed at install time.
          return new Response(
            "<!doctype html><html><body style=\"background:#050508;color:#fff;font-family:system-ui;padding:24px\"><h1>You're offline</h1><p>Reconnect and retry.</p></body></html>",
            { status: 503, headers: { "content-type": "text/html" } },
          );
        }
      })(),
    );
    return;
  }

  // Everything else (JS, CSS, images, fonts, API
  // calls): pass through with no caching. API
  // responses must never be cached — the agents
  // service is the source of truth for live data.
});
