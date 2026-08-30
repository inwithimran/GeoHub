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

// ---------- App-shell caching (installability + offline) ----------
const CACHE_NAME = "geohub-shell-v1";
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icons/geohub-192.png",
  "/icons/geohub-512.png"
];

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

// Network-first for same-origin navigation/asset requests, falling back to
// cache when offline; everything cross-origin (Firebase, fonts, Tailwind
// CDN, Cloudinary) is left to the network untouched.
self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match("/index.html")))
  );
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
