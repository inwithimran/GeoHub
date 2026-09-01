// ============================================================================
// FIREBASE CONFIGURATION
// ----------------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com -> Create a project.
// 2. Add a "Web App" to the project, copy the config object it gives you,
//    and paste the values below (replace every "YOUR_..." placeholder).
// 3. In the Firebase Console enable:
//      Authentication -> Sign-in method -> Email/Password
//      Authentication -> Sign-in method -> Google (needed for the
//        "Continue with Google" button on the login/signup screen)
//      Firestore Database -> Create database (start in production mode)
// 4. Paste the Firestore security rules from rules.txt (bottom of this repo)
//    into Firestore -> Rules, so only logged-in classmates can read/write.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager, clearIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyANw4D4Y-Be7R3Jctg5uNKnRa2AtG8dHGs",
  authDomain: "geohub-geo-env.firebaseapp.com",
  projectId: "geohub-geo-env",
  storageBucket: "geohub-geo-env.firebasestorage.app",
  messagingSenderId: "219912104826",
  appId: "1:219912104826:web:bc47576804468d343b44c3",
  measurementId: "G-E8XXFVJHVQ"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// ============================================================
// PERSISTENT LOCAL CACHE — same thing every "professional" app with a
// realtime backend does: keep a copy of whatever's been read in IndexedDB,
// so a reload doesn't have to go back to the network for data it already
// has. Wall posts, notices, the Directory, conversations, messages — all
// of it now survives a refresh and paints instantly from disk while
// Firestore re-syncs the live listeners quietly underneath. Reloading a
// few minutes later (or even fully offline) no longer means sitting
// through the same loading screen from scratch. `persistentSingleTabManager`
// keeps this to one tab at a time (no multi-tab coordination overhead) —
// students opening GeoHub in a second tab just fall back to in-memory-only
// caching for that extra tab, which is fine.
// ============================================================
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

// ============================================================
// COLD-START CACHE RESET — a "Clear site data" reload doesn't just empty
// the local cache, it can leave firebase-js-sdk's persistence layer
// CORRUPTED (github.com/firebase/firebase-js-sdk/issues/8593): the browser
// deletes the IndexedDB database out from under an already-open Firestore
// connection, and the connection that opens on the next page load can
// inherit a half-broken state from that — reads (even ones forced to the
// server) can then come back wrong: missing documents, incomplete lists,
// stale counts. That's the "user কম দেখাচ্ছে" / "ডেটা আসছে না" pattern.
//
// resetCacheOnColdStart() is the fix the SDK's own maintainers point to
// for this: instead of trusting whatever state a raw browser-level delete
// left behind, ask Firestore itself to properly tear down and rebuild its
// local persistence via clearIndexedDbPersistence() — its own clean
// reset routine, not a blind wipe. This MUST run before any other read or
// listener touches `db` (nothing in this app does until after login, so
// calling this once, early, in js/app.js is enough).
//
// "Cold start" here is detected with a plain localStorage marker rather
// than by inspecting IndexedDB directly (indexedDB.databases() isn't
// reliably supported everywhere) — "Clear site data" wipes localStorage
// right alongside IndexedDB, so the marker's absence is exactly the
// signal we need, no extra API required.
// ============================================================
const SESSION_MARKER_KEY = "geohub_session_established";

export async function resetCacheOnColdStart() {
  if (localStorage.getItem(SESSION_MARKER_KEY)) return false;
  try {
    await clearIndexedDbPersistence(db);
  } catch {
  }
  return true;
}

export function markSessionEstablished() {
  try { localStorage.setItem(SESSION_MARKER_KEY, "1"); } catch { }
}

// ============================================================
// PUSH NOTIFICATIONS (Firebase Cloud Messaging)
// ----------------------------------------------------------------------------
// 1. Firebase Console -> Project settings -> Cloud Messaging -> "Web Push
//    certificates" -> Generate key pair. Paste the resulting key below.
// 2. The server side that actually SENDS the push (triggered after a new
//    post/note/notice/comment is saved) is a Vercel serverless function at
//    /api/send-push.js — NOT a Firebase Cloud Function, so this stays on
//    Firebase's free Spark plan. See VERCEL_SETUP.md for the deploy steps.
// ============================================================
export const VAPID_KEY = "BD9lAKJwaHRwTaSMqD6sYWs40rfsEhUW0rxuyZtOgBsWm4jhdAgMCS4aLCIpcvFmtpIvnn_klw9IdwWrP2tp7rc";

export const DEPARTMENT_NAME = "Geography & Environment";
export const COLLEGE_NAME = "Govt. Michael Madhusudan College, Jessore";

export const RESOURCE_CATEGORIES = [
  "Physical Geography",
  "Climatology",
  "Human Geography",
  "Cartography",
  "General / Others"
];

export const ADMIN_EMAILS = [
  "in.with.imran@gmail.com"
];

export const ADMIN_NAME = "Tabib Imran";
