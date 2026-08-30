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
// Tracks whether we've already gotten a token saved successfully in THIS
// browser session, so a routine re-run (e.g. every login) doesn't redo the
// token fetch/write for no reason. This is intentionally NOT set on a
// failed/skipped attempt — see the bug this replaced, below.
let tokenSavedThisSession = false;

/**
 * Ask for notification permission (if not already answered), register a
 * service worker, get an FCM token, and save it on the student's profile
 * so the send-push API route knows where to deliver pushes. Quietly does
 * nothing if the browser doesn't support push (e.g. iOS Safari outside of
 * an installed home-screen app) or the VAPID key hasn't been configured yet.
 *
 * Pass { requestPermission: true } when this call is directly triggered by
 * the person (e.g. flipping the "Push notifications" switch in Settings).
 * Without that flag — i.e. the automatic call on every login — this will
 * silently register the token if permission is already "granted" from a
 * previous visit, but will NOT itself pop the permission prompt. That's
 * deliberate, not a missing feature: Chrome (and others) downgrade a
 * Notification.requestPermission() call that isn't tied to a user gesture
 * to a quiet, easy-to-miss address-bar indicator instead of the real
 * prompt — so asking automatically at login mostly just burns the one
 * attempt without the person ever noticing anything happened. Waiting for
 * an explicit tap on the Settings toggle means the prompt actually shows.
 *
 * BUG FIX: this used to short-circuit on a module-level `initialized`
 * flag set on the *first* call regardless of outcome. So the automatic
 * login call would run, fail to get permission (see above), set
 * `initialized = true`, and then a later, explicit tap on the Settings
 * toggle — which also calls this function — would return instantly
 * without ever re-prompting, because the flag was already set. That's
 * exactly the "toggle it on and nothing happens" symptom. Now we only
 * ever skip work we've already genuinely finished (a saved token this
 * session), not work we merely attempted.
 */
export async function initPush({ requestPermission = false } = {}) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (!VAPID_KEY || VAPID_KEY.startsWith("PASTE_")) return; // not configured yet — skip quietly
  if (!(await isSupported().catch(() => false))) return;
  if (Notification.permission === "denied") return; // nothing we can do until the person re-enables it in browser settings
  if (Notification.permission === "default" && !requestPermission) return; // see doc comment above
  if (tokenSavedThisSession) return;

  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);

    // Foreground messages (app open in this tab): FCM doesn't auto-show a
    // system notification for these, so surface it as an in-app toast. Data-
    // only payload (see api/send-push.js), so title/body live under `.data`.
    // Wired once, independent of whether the token step below succeeds.
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
    if (permission !== "granted") return; // not saved — a later call (e.g. the toggle) may retry

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
