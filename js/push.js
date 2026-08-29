// ============================================================
// PUSH.JS — registers this browser/device for push notifications
// via Firebase Cloud Messaging, so a student gets a real phone/
// browser notification the moment someone posts on the Wall,
// shares a note, or a new notice goes up — even while GeoHub
// isn't open. This file only handles the CLIENT side (permission
// + token registration + foreground display); the SERVER side
// that actually sends the push is a Vercel serverless function at
// /api/send-push.js (triggered from js/push-trigger.js right after
// a successful write) — see VERCEL_SETUP.md for the one-time setup.
// ============================================================
import { app, auth, db, VAPID_KEY } from "./firebase-config.js";
import {
  getMessaging, getToken, isSupported, onMessage
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { showToast } from "./ui-utils.js";

let initialized = false;

/**
 * Ask for notification permission (if not already answered), register a
 * service worker, get an FCM token, and save it on the student's profile
 * so the Cloud Function knows where to deliver pushes. Safe to call every
 * login — it's a no-op after the first successful run in this browser, and
 * quietly does nothing if the browser doesn't support push (e.g. iOS Safari
 * outside of an installed home-screen app) or the VAPID key hasn't been
 * configured yet.
 */
export async function initPush() {
  if (initialized) return;
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (!VAPID_KEY || VAPID_KEY.startsWith("PASTE_")) return; // not configured yet — skip quietly
  if (!(await isSupported().catch(() => false))) return;

  initialized = true;

  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);

    // Foreground messages (app open in this tab): FCM doesn't auto-show a
    // system notification for these, so surface it as an in-app toast.
    onMessage(messaging, (payload) => {
      const title = payload.notification?.title || "GeoHub";
      const body = payload.notification?.body || "";
      showToast(`${title}${body ? " — " + body : ""}`);
    });

    let permission = Notification.permission;
    if (permission === "default") {
      permission = await Notification.requestPermission();
    }
    if (permission !== "granted") return;

    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (token && auth.currentUser) {
      await setDoc(
        doc(db, "users", auth.currentUser.uid, "fcmTokens", token),
        { createdAt: serverTimestamp(), userAgent: navigator.userAgent },
        { merge: true }
      );
    }
  } catch (err) {
    // Push is a nice-to-have, never block or interrupt the rest of the app for it.
    console.warn("Push notifications not available:", err.message);
  }
}

/** Remove this device's token on logout so it stops receiving pushes for an account it's no longer signed into. */
export async function unregisterPushToken() {
  try {
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    if (!registration) return;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration }).catch(() => null);
    if (token && auth.currentUser) {
      await setDoc(doc(db, "users", auth.currentUser.uid, "fcmTokens", token), { revoked: true, revokedAt: serverTimestamp() }, { merge: true });
    }
  } catch { /* best-effort cleanup only */ }
}
