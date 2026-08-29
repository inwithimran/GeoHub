// ============================================================
// FIREBASE-MESSAGING-SW.JS — background push handler.
// Must live at the SITE ROOT (same folder as index.html) with
// exactly this filename — Firebase Cloud Messaging looks for it
// there by default. Handles notifications that arrive while
// GeoHub isn't open in any tab (app closed / phone locked).
// ============================================================
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

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
    icon: "/icons/geohub-192.png", // optional — add this file, or remove this line
    badge: "/icons/geohub-badge.png", // optional — add this file, or remove this line
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
