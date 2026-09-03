import { auth, db } from "./firebase-config.js";
import { API_BASE } from "./api-client.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithCredential,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  fetchSignInMethodsForEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { callApi } from "./api-client.js";
import { isDisposableEmail } from "../shared/blocked-email-domains.js";
import { Capacitor } from "@capacitor/core";
import { FirebaseAuthentication } from "@capacitor-firebase/authentication";

export let currentProfile = null;

const googleProvider = new GoogleAuthProvider();

const NAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

export function nameChangeStatus() {
  const lastMs = toMillis(currentProfile?.nameChangedAt);
  if (!lastMs) return { canChange: true, daysRemaining: 0 };
  const elapsed = Date.now() - lastMs;
  if (elapsed >= NAME_CHANGE_COOLDOWN_MS) return { canChange: true, daysRemaining: 0 };
  const daysRemaining = Math.max(1, Math.ceil((NAME_CHANGE_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000)));
  return { canChange: false, daysRemaining };
}

export async function signUp(data) {
  if (isDisposableEmail(data.email)) {
    const err = new Error("Temporary or disposable email addresses aren't allowed. Please sign up with a permanent email address.");
    err.code = "auth/disposable-email";
    throw err;
  }
  const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
  try {
    const { profile } = await callApi("create-profile", {
      name: data.name.trim(),
      roll: data.roll.trim(),
      phone: data.phone.trim(),
      blood: data.blood,
      gender: data.gender || ""
    });
    currentProfile = profile;
    return cred.user;
  } catch (err) {
    try { await cred.user.delete(); } catch { /* best effort */ }
    throw err;
  }
}

export async function logIn(email, password) {
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  } catch (err) {
    if (["auth/user-not-found", "auth/invalid-credential", "auth/wrong-password"].includes(err.code)) {
      try {
        const methods = await fetchSignInMethodsForEmail(auth, email);
        if (methods.length && !methods.includes("password")) {
          const clearer = new Error("This account uses Google Sign-In.");
          clearer.code = "auth/google-only-account";
          throw clearer;
        }
      } catch (inner) {
        if (inner.code === "auth/google-only-account") throw inner;
       
      }
    }
    throw err;
  }
}

export async function signInWithGoogle() {
  if (Capacitor.isNativePlatform()) {
    const result = await FirebaseAuthentication.signInWithGoogle();
    const idToken = result.credential?.idToken;
    if (!idToken) {
      const err = new Error("Google sign-in didn't return a valid credential.");
      err.code = "auth/google-only-account";
      throw err;
    }
    const credential = GoogleAuthProvider.credential(idToken);
    const cred = await signInWithCredential(auth, credential);
    return cred.user;
  }
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

export async function updateProfileDetails({ name, roll, blood, phone, bio, session, year, hometown, address, socialLink, gender, hidePhone, hideEmail, photoURL }) {

  const wasNameChangeAttempt = name !== undefined && name.trim() && name.trim() !== (currentProfile?.name || "");
  const { profile } = await callApi("update-profile", {
    name, roll, blood, phone, bio, session, year, hometown, address, socialLink, gender, hidePhone, hideEmail, photoURL
  });
  currentProfile = profile;
  if (wasNameChangeAttempt) currentProfile.nameChangedAt = new Date();
  return currentProfile;
}

export function logOut() {
  return signOut(auth);
}

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

async function resolveOwnProfile(user) {
  const idToken = await user.getIdToken();
  const res = await fetch(`${API_BASE}/api/resolve-profile`, {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `resolve-profile failed (${res.status})`);
  return body;
}

export function watchAuthState(onLogin, onLogout, onConflict) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      let result;
      try {
        result = await resolveOwnProfile(user);
      } catch {
        await signOut(auth);
        if (onConflict) {
          onConflict("Couldn't reach GeoHub's server to load your profile. Please check your connection and try signing in again.");
        }
        return;
      }

      if (result.status === "conflict" || result.status === "blocked") {
        await signOut(auth);
        if (onConflict) onConflict(result.message);
        return;
      }

      currentProfile = result.profile || null;
      onLogin(user, currentProfile);
    } else {
      currentProfile = null;
      onLogout();
    }
  });
}

export function friendlyAuthError(err) {
  const map = {
    "auth/email-already-in-use": "That email is already registered — try logging in instead.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password. Try again.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/popup-closed-by-user": "Google sign-in was closed before finishing.",
    "auth/cancelled-popup-request": "Google sign-in was cancelled.",
    "auth/popup-blocked": "Your browser blocked the Google sign-in popup. Please allow popups and try again.",
    "auth/account-exists-with-different-credential": "That email is already registered with a password. Log in with your password instead.",
    "auth/google-only-account": "This email was registered with \"Continue with Google\" — it has no password set. Please use the Google button below to log in."
  };
  if (err.code && map[err.code]) return map[err.code];
  if (err.message) return err.message;
  return "Something went wrong. Please try again.";
}
