import { app, auth, db, VAPID_KEY } from "./firebase-config.js";
import {
  getMessaging, getToken, isSupported, onMessage
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";
import {
  doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { showToast } from "./ui-utils.js";
import { isDmThreadOpenWith, isClassChatOpen } from "./messages.js";

const CapFirebaseMessaging = window.Capacitor?.Plugins?.FirebaseMessaging;
const isNativeApp = window.Capacitor?.isNativePlatform?.() === true;

let foregroundHandlerWired = false;
let tokenSavedThisSession = false;

function isAlreadyViewingThread(data) {
  if (document.visibilityState !== "visible") return false;
  if (data?.type === "dm") return isDmThreadOpenWith(data.senderUid);
  if (data?.type === "classChat") return isClassChatOpen();
  return false;
}

async function saveToken(token) {
  if (!token || !auth.currentUser) return;
  await setDoc(
    doc(db, "users", auth.currentUser.uid, "fcmTokens", token),
    { createdAt: serverTimestamp(), userAgent: navigator.userAgent },
    { merge: true }
  );
  tokenSavedThisSession = true;
}

async function initNativePush({ requestPermission }) {
  if (!CapFirebaseMessaging || tokenSavedThisSession) return;

  if (!foregroundHandlerWired) {
    foregroundHandlerWired = true;
    CapFirebaseMessaging.addListener("notificationReceived", (event) => {
      if (isAlreadyViewingThread(event.notification?.data)) return;
      const title = event.notification?.data?.title || event.notification?.title || "GeoHub";
      const body = event.notification?.data?.body || event.notification?.body || "";
      showToast(`${title}${body ? " — " + body : ""}`);
    });
    CapFirebaseMessaging.addListener("tokenReceived", (event) => {
      if (event.token) saveToken(event.token);
    });
  }

  let status = await CapFirebaseMessaging.checkPermissions();
  if (status.receive === "prompt" || status.receive === "prompt-with-rationale") {
    if (!requestPermission) return;
    status = await CapFirebaseMessaging.requestPermissions();
  }
  if (status.receive !== "granted") return;

  const { token } = await CapFirebaseMessaging.getToken();
  await saveToken(token);
}

async function initWebPush({ requestPermission }) {
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
        if (isAlreadyViewingThread(payload.data)) return;
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
    await saveToken(token);
  } catch (err) {
    console.warn("Push notifications not available:", err.message);
  }
}

export async function initPush({ requestPermission = false } = {}) {
  if (isNativeApp) {
    await initNativePush({ requestPermission }).catch((err) => console.warn("Native push not available:", err.message));
  } else {
    await initWebPush({ requestPermission });
  }
}

export function registerNotificationTapHandler(onTap) {
  if (isNativeApp) {
    if (CapFirebaseMessaging) {
      CapFirebaseMessaging.addListener("notificationActionPerformed", (event) => {
        const url = event.notification?.data?.url;
        if (url) onTap(url);
      });
    }
    window.addEventListener("geohubNotificationTap", (event) => {
      if (event.detail) onTap(event.detail);
    });
    return;
  }
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type === "geohub-notification-click" && event.data.url) {
      onTap(event.data.url);
    }
  });
}

export async function unregisterPushToken() {
  try {
    if (isNativeApp) {
      if (!CapFirebaseMessaging) return;
      const { token } = await CapFirebaseMessaging.getToken().catch(() => ({ token: null }));
      if (token && auth.currentUser) {
        await setDoc(doc(db, "users", auth.currentUser.uid, "fcmTokens", token), { revoked: true, revokedAt: serverTimestamp() }, { merge: true });
      }
      return;
    }
    if (!("serviceWorker" in navigator)) return;
    const registration = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
    if (!registration) return;
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration }).catch(() => null);
    if (token && auth.currentUser) {
      await setDoc(doc(db, "users", auth.currentUser.uid, "fcmTokens", token), { revoked: true, revokedAt: serverTimestamp() }, { merge: true });
    }
  } catch {
  }
}
