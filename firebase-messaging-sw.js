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

const CACHE_NAME = "geohub-shell-v2";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/geohub-192.png",
  "/icons/geohub-512.png"
];
const FRESH_WINDOW_MS = 10 * 60 * 1000;
const CACHE_TIME_HEADER = "x-geohub-cached-at";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        APP_SHELL.map((url) =>
          fetch(url).then((res) => cachePut(cache, url, res)).catch(() => {})
        )
      )
    ).catch(() => {})
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

async function cachePut(cache, request, response) {
  try {
    const body = await response.clone().arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set(CACHE_TIME_HEADER, String(Date.now()));
    await cache.put(request, new Response(body, { status: response.status, statusText: response.statusText, headers }));
  } catch (_) {
  }
}

function cacheAgeMs(response) {
  const stamp = response && response.headers.get(CACHE_TIME_HEADER);
  return stamp ? Date.now() - Number(stamp) : Infinity;
}

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
