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
  initializeFirestore, persistentLocalCache, persistentSingleTabManager
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// TODO: replace with your own Firebase project credentials
const firebaseConfig = {
  apiKey: "AIzaSyANw4D4Y-Be7R3Jctg5uNKnRa2AtG8dHGs",
  authDomain: "geohub-geo-env.firebaseapp.com",
  projectId: "geohub-geo-env",
  storageBucket: "geohub-geo-env.firebasestorage.app",
  messagingSenderId: "219912104826",
  appId: "1:219912104826:web:bc47576804468d343b44c3",
  measurementId: "G-E8XXFVJHVQ"
};

// Initialize once, export everywhere else needs it
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

// Department constant — used across the app (post metadata, empty states, etc.)
export const DEPARTMENT_NAME = "Geography & Environment";
export const COLLEGE_NAME = "Govt. Michael Madhusudan College, Jessore";

// Resource categories shown in the Notes & Sheet Hub
export const RESOURCE_CATEGORIES = [
  "Physical Geography",
  "Climatology",
  "Human Geography",
  "Cartography",
  "General / Others"
];

// Emails allowed to post to the Notice Board (CR / Class Admins).
// Add your CR's/co-CR's login email(s) here. Mirror this list in your
// Firestore security rules so it's enforced server-side, not just in the UI.
// Any email in this list also gets the special admin badge next to their
// name everywhere in the app (wall posts, comments, directory, notices…).
export const ADMIN_EMAILS = [
  "in.with.imran@gmail.com"
];

// The class admin's real, canonical name — shown everywhere their email
// appears (Wall posts, comments, Notice Board, Directory, Profile), with
// the admin badge, regardless of whatever name string is stored on the
// account itself. Keeps the admin identity consistent across the app.
export const ADMIN_NAME = "Tabib Imran";
