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

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});

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
  try { localStorage.setItem(SESSION_MARKER_KEY, "1"); } catch {  }
}

export const VAPID_KEY = "BD9lAKJwaHRwTaSMqD6sYWs40rfsEhUW0rxuyZtOgBsWm4jhdAgMCS4aLCIpcvFmtpIvnn_klw9IdwWrP2tp7rc";

export const DEPARTMENT_NAME = "Geography & Environment";
export const COLLEGE_NAME = "Govt. Michael Madhusudan College, Jessore";

// Re-exported from the single shared source of truth — see
// /shared/resource-categories.js (also used by the serverless API routes).
export { RESOURCE_CATEGORIES } from "../shared/resource-categories.js";

// Re-exported from the single shared source of truth — see
// /shared/admin-config.js (also used by the serverless API routes).
export { ADMIN_EMAILS, ADMIN_NAME } from "../shared/admin-config.js";
