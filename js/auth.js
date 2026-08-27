// ============================================================
// AUTH.JS — Sign up, log in, log out, and auth-state watching.
// Writes a profile document to Firestore at users/{uid} on signup.
// ============================================================
import { auth, db } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/** In-memory cache of the logged-in student's profile (name, roll, blood, phone). */
export let currentProfile = null;

/**
 * Create a new account, then create the matching Firestore profile doc.
 * @param {{name:string, roll:string, blood:string, phone:string, email:string, password:string}} data
 */
export async function signUp(data) {
  const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
  const profile = {
    uid: cred.user.uid,
    name: data.name.trim(),
    roll: data.roll.trim(),
    bloodGroup: data.blood,
    phone: data.phone.trim(),
    email: data.email.trim(),
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "users", cred.user.uid), profile);
  currentProfile = profile;
  return cred.user;
}

/** Log in an existing student with email + password. */
export async function logIn(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/** Log the current user out. */
export function logOut() {
  return signOut(auth);
}

/** Fetch a user's profile doc from Firestore by uid (used across the app). */
export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Subscribe to Firebase's auth-state changes.
 * Calls onLogin(user, profile) or onLogout() as appropriate.
 * This is the single source of truth for whether the app shell shows.
 */
export function watchAuthState(onLogin, onLogout) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentProfile = await fetchProfile(user.uid);
      onLogin(user, currentProfile);
    } else {
      currentProfile = null;
      onLogout();
    }
  });
}

/** Turns a raw Firebase auth error into a short, student-friendly message. */
export function friendlyAuthError(err) {
  const map = {
    "auth/email-already-in-use": "That email is already registered — try logging in instead.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password. Try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again."
  };
  return map[err.code] || "Something went wrong. Please try again.";
}
