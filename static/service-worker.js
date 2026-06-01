/* Shrutiscakes service worker
 *
 * Strategy:
 *   - Precache the app shell (CSS, key images, manifest) at install
 *   - Network-first for HTML so customers always see fresh content,
 *     fall back to cache when offline
 *   - Cache-first for static assets so repeat visits load instantly
 *
 * Bump CACHE_VERSION any time you change static assets to bust the cache.
 */
const CACHE_VERSION = "shrutiscakes-v3";
const APP_SHELL = [
    "/",
    "/menu",
    "/gallery",
    "/static/css/style.css",
    "/static/images/logo.jpeg",
    "/static/images/icon-192.png",
    "/static/images/icon-512.png",
    "/static/manifest.json",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_VERSION).then((cache) => {
            // Use addAll's tolerant variant: requests we can't fetch (e.g. admin) just get skipped.
            return Promise.all(
                APP_SHELL.map((url) =>
                    cache.add(url).catch((err) => console.warn("[sw] skip", url, err))
                )
            );
        })
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const req = event.request;

    // Only handle GETs; never cache POSTs (orders!) or admin pages.
    if (req.method !== "GET") return;
    const url = new URL(req.url);
    if (url.pathname.startsWith("/admin")) return;
    if (url.pathname.startsWith("/order") && req.method === "POST") return;

    const isHTML = req.headers.get("accept")?.includes("text/html");

    if (isHTML) {
        // Network-first for pages so menu/products feel up-to-date.
        event.respondWith(
            fetch(req)
                .then((resp) => {
                    const copy = resp.clone();
                    caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
                    return resp;
                })
                .catch(() => caches.match(req).then((r) => r || caches.match("/")))
        );
        return;
    }

    // Cache-first for everything else (CSS, images, manifest).
    event.respondWith(
        caches.match(req).then((cached) => {
            if (cached) return cached;
            return fetch(req).then((resp) => {
                if (!resp || resp.status !== 200 || resp.type !== "basic") return resp;
                const copy = resp.clone();
                caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
                return resp;
            });
        })
    );
});
