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

let foregroundHandlerWired = false;
let tokenSavedThisSession = false;

export async function initPush({ requestPermission = false } = {}) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (!VAPID_KEY || VAPID_KEY.startsWith("PASTE_")) return;
  if (!(await isSupported().catch(() => false))) return;
  if (Notification.permission === "denied") return;
  if (Notification.permission === "default" && !requestPermission) return;
  if (tokenSavedThisSession) return;

  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);

    if (!foregroundHandlerWired) {
      foregroundHandlerWired = true;
      onMessage(messaging, (payload) => {
        const title = payload.data?.title || "GeoHub";
        const body = payload.data?.body || "";
        showToast(`${title}${body ? " — " + body : ""}`);
      });
    }

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
      tokenSavedThisSession = true;
    }
  } catch (err) {
    console.warn("Push notifications not available:", err.message);
  }
}

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
  } catch { }
}
