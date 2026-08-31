// ============================================================
// FIREBASE-MESSAGING-SW.JS — background push handler + PWA cache.
// Must live at the SITE ROOT (same folder as index.html) with
// exactly this filename — Firebase Cloud Messaging looks for it
// there by default. Handles notifications that arrive while
// GeoHub isn't open in any tab (app closed / phone locked), and
// doubles as the app's one and only service worker: it also
// caches the app shell so GeoHub installs as a PWA and opens
// instantly (and mostly works offline) on repeat visits. Kept as
// a single file (rather than a separate sw.js) so there's only
// ever one service worker controlling the page.
// ============================================================
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// ---------- App-shell caching (installability + offline + fast repeat loads) ----------
// v2: switched the fetch strategy below from plain network-first (which
// waited on the network on literally every load, cache or not — so a
// reload 90 seconds after the last visit was just as slow as the very
// first one) to a 10-minute freshness window. Bumping the cache name
// drops any old, un-timestamped v1 entries instead of trying to reuse
// them under the new scheme.
const CACHE_NAME = "geohub-shell-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/geohub-192.png",
  "/icons/geohub-512.png"
];
// How long a cached same-origin response is considered "fresh enough to
// use instantly, no network round-trip." Re-entering the site or hitting
// reload within this window is what should feel instant; outside it, a
// real (slower) network preload is expected again — same as first visit.
const FRESH_WINDOW_MS = 10 * 60 * 1000;
// Custom header we stamp onto every cached response ourselves so we can
// tell how old a cache entry is later — the Cache API doesn't expose an
// insertion time on its own.
const CACHE_TIME_HEADER = "x-geohub-cached-at";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

/** Clone `response`, stamp it with the current time, and store it — so its
 *  age can be checked on the next fetch without a separate lookup table. */
async function cachePut(cache, request, response) {
  try {
    const body = await response.clone().arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set(CACHE_TIME_HEADER, String(Date.now()));
    await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  } catch (_) {
    // Best-effort — a failed cache write just means this entry stays stale
    // (or missing) and falls back to the network path next time, same as
    // it would have with no caching at all.
  }
}

/** Milliseconds since `response` was cached, or Infinity if we can't tell
 *  (e.g. a v1 entry from before this header existed) — treated as stale. */
function cacheAgeMs(response) {
  const stamp = response && response.headers.get(CACHE_TIME_HEADER);
  return stamp ? Date.now() - Number(stamp) : Infinity;
}

// Same-origin GET requests (app shell HTML/CSS/JS, icons, manifest) use a
// 10-minute freshness window instead of always waiting on the network:
//   - Cached AND younger than FRESH_WINDOW_MS -> serve the cache instantly
//     (this is the fast repeat-visit/reload path), then quietly refresh
//     the cache in the background so it stays current.
//   - Cache missing or older than the window -> behave like a real first
//     load: wait on the network (refreshing the cache + its timestamp),
//     and only fall back to a stale cache (or the app shell) if offline.
// Everything cross-origin (Firebase, fonts, Tailwind CDN, Cloudinary) is
// left to the network untouched, same as before.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    if (cached && cacheAgeMs(cached) < FRESH_WINDOW_MS) {
      event.waitUntil(fetch(request).then((res) => cachePut(cache, request, res)).catch(() => {}));
      return cached;
    }

    try {
      const fresh = await fetch(request);
      event.waitUntil(cachePut(cache, request, fresh));
      return fresh;
    } catch (_) {
      return (await cache.match(request)) || (await caches.match("/index.html"));
    }
  })());
});

// Keep this in sync with js/firebase-config.js — service workers can't use
// ES module imports, so the config is duplicated here.
firebase.initializeApp({
  apiKey: "AIzaSyANw4D4Y-Be7R3Jctg5uNKnRa2AtG8dHGs",
  authDomain: "geohub-geo-env.firebaseapp.com",
  projectId: "geohub-geo-env",
  storageBucket: "geohub-geo-env.firebasestorage.app",
  messagingSenderId: "219912104826",
  appId: "1:219912104826:web:bc47576804468d343b44c3"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.data?.title || "GeoHub";
  const options = {
    body: payload.data?.body || "",
    icon: "/icons/geohub-192.png",
    badge: "/icons/geohub-badge.png",
    data: { url: payload.data?.url || "/" }
  };
  self.registration.showNotification(title, options);
});

// Tapping the notification focuses an existing GeoHub tab if one is open,
// otherwise opens a new one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
