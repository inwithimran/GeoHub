// ============================================================================
// FIREBASE CONFIGURATION
// ----------------------------------------------------------------------------
// 1. Go to https://console.firebase.google.com -> Create a project.
// 2. Add a "Web App" to the project, copy the config object it gives you,
//    and paste the values below (replace every "YOUR_..." placeholder).
// 3. In the Firebase Console enable:
//      Authentication -> Sign-in method -> Email/Password
//      Firestore Database -> Create database (start in production mode)
// 4. Paste the Firestore security rules from rules.txt (bottom of this repo)
//    into Firestore -> Rules, so only logged-in classmates can read/write.
// ============================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore
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
export const db = getFirestore(app);

// Department constant — used across the app (post metadata, empty states, etc.)
export const DEPARTMENT_NAME = "Geography & Environment (1st Year Honors)";
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
export const ADMIN_EMAILS = [
  "in.with.imran@gmail.com"
];
