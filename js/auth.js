// ============================================================
// AUTH.JS — Sign up, log in, log out, and auth-state watching.
// Writes a profile document to Firestore at users/{uid} on signup.
// ============================================================
import { auth, db, ADMIN_EMAILS } from "./firebase-config.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  fetchSignInMethodsForEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  doc, setDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { callApi } from "./api-client.js";

// ============================================================
// PRIVACY: the `users/{uid}` document is readable by every signed-in
// classmate (that's what powers the Directory), so it can only ever
// hold the "visible mirror" of phone/email — never the real values
// when a student has hidden them. The real, unmasked values always
// live in `users/{uid}/private/contact`, which Firestore rules only
// let the student themself (or an admin) read. These two small
// helpers compute the mirror and keep both documents in sync so the
// rest of the app doesn't have to think about it.
// ============================================================
function isAdminEmailLocal(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}
/** What the public `users/{uid}` doc's phone/email fields should hold, given the real values + hide flags. */
function visibleContactMirror({ phone, email, hidePhone, hideEmail }) {
  return {
    // The admin's email is intentionally always identifiable (it's how the
    // whole app recognizes the CR/admin badge everywhere), so it's never
    // masked here regardless of hideEmail.
    email: (isAdminEmailLocal(email) || !hideEmail) ? (email || "") : "",
    phone: hidePhone ? "" : (phone || "")
  };
}

/** In-memory cache of the logged-in student's profile (name, roll, blood, phone). */
export let currentProfile = null;

const googleProvider = new GoogleAuthProvider();

// ============================================================
// NAME CHANGE COOLDOWN — a student may change their display name, but
// only once every 7 days. `nameChangedAt` on the profile doc records the
// last time it actually changed (null until the first edit, so the very
// first change is never blocked). Enforced here for the UI AND, for real,
// in firestore.rules — this client-side check alone is just a courtesy;
// it can't be trusted to stop someone from writing to Firestore directly.
// ============================================================
const NAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis(); // Firestore Timestamp
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  if (ts instanceof Date) return ts.getTime();
  return 0;
}

/** Whether the logged-in student can change their name right now, and if not, how many days until they can. */
export function nameChangeStatus() {
  const lastMs = toMillis(currentProfile?.nameChangedAt);
  if (!lastMs) return { canChange: true, daysRemaining: 0 };
  const elapsed = Date.now() - lastMs;
  if (elapsed >= NAME_CHANGE_COOLDOWN_MS) return { canChange: true, daysRemaining: 0 };
  const daysRemaining = Math.max(1, Math.ceil((NAME_CHANGE_COOLDOWN_MS - elapsed) / (24 * 60 * 60 * 1000)));
  return { canChange: false, daysRemaining };
}


/**
 * Create a new account, then create the matching Firestore profile doc.
 * @param {{name:string, roll:string, blood:string, phone:string, email:string, password:string}} data
 */
export async function signUp(data) {
  const cred = await createUserWithEmailAndPassword(auth, data.email, data.password);
  const name = data.name.trim();
  const roll = data.roll.trim();
  const phone = data.phone.trim();
  const email = data.email.trim();
  const hidePhone = false;
  const hideEmail = false;

  const profile = {
    uid: cred.user.uid,
    name,
    roll,
    bloodGroup: data.blood,
    gender: data.gender || "",
    ...visibleContactMirror({ phone, email, hidePhone, hideEmail }),
    photoURL: "",
    bio: "",
    session: "",
    year: "",
    hometown: "",
    address: "",
    socialLink: "",
    hidePhone,
    hideEmail,
    nameChangedAt: null,
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "users", cred.user.uid), profile);
  await setDoc(doc(db, "users", cred.user.uid, "private", "contact"), { phone, email });
  // Keep the real (unmasked) values in memory for this session — the
  // student editing their own profile should always see their real phone,
  // never the possibly-blanked public mirror.
  currentProfile = { ...profile, phone, email };
  return cred.user;
}

/**
 * Log in an existing student with email + password.
 * If the email/password combo fails because this account was actually
 * created via "Continue with Google" (so it has no password credential
 * at all), we detect that here and throw a clearer, specific error
 * instead of a generic "wrong password" — see friendlyAuthError below.
 */
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
        // fetchSignInMethodsForEmail itself failed (e.g. offline) — fall through to original error
      }
    }
    throw err;
  }
}

/**
 * Sign in (or sign up, if this is the student's first visit) with Google.
 * NOTE: the "Google" sign-in method must be turned on in the Firebase
 * Console under Authentication -> Sign-in method before this works.
 * The actual profile doc (created if this is a first-time Google user)
 * is handled centrally in watchAuthState below, so there's no race
 * between this popup resolving and the auth-state listener firing.
 */
export async function signInWithGoogle() {
  const cred = await signInWithPopup(auth, googleProvider);
  return cred.user;
}

/**
 * Save/update a student's editable details. Used both to complete a
 * Google-created profile the first time, and later from "My Profile"
 * to edit roll/blood/phone plus the richer optional fields and the
 * privacy toggles that control what classmates can see (and whether
 * they can call this student).
 */
export async function updateProfileDetails({ name, roll, blood, phone, bio, session, year, hometown, address, socialLink, gender, hidePhone, hideEmail, photoURL }) {
  // Validated + written server-side (api/update-profile.js) — enum checks
  // on blood/gender/year, a real phone-format check, the photoURL actually
  // being this student's own Cloudinary avatar upload, and the 7-day
  // name-change cooldown enforced for real (this client-side
  // nameChangeStatus() disabling the field is just instant UI feedback,
  // same as before — the API is what a direct-to-Firestore write could
  // never be trusted to respect).
  const wasNameChangeAttempt = name !== undefined && name.trim() && name.trim() !== (currentProfile?.name || "");
  const { profile } = await callApi("update-profile", {
    name, roll, blood, phone, bio, session, year, hometown, address, socialLink, gender, hidePhone, hideEmail, photoURL
  });
  currentProfile = profile;
  // The API's nameChangedAt (when this call actually changed the name) is a
  // write-time sentinel that doesn't survive the JSON round-trip as a real
  // value — stand in a local Date so nameChangeStatus() has something to
  // compare against immediately, until the next fetch replaces it with the
  // real one.
  if (wasNameChangeAttempt) currentProfile.nameChangedAt = new Date();
  return currentProfile;
}

/** Log the current user out. */
export function logOut() {
  return signOut(auth);
}

/** Fetch a user's profile doc from Firestore by uid (used across the app,
 *  e.g. Directory rows, post authors, "view profile"). Deliberately reads
 *  ONLY the public doc — for any uid other than the caller's own, that's
 *  the masked/visible mirror, exactly as it should be. This is fine to
 *  serve from the client-side cache: staleness here is a minor cosmetic
 *  issue, never an identity decision — see resolveOwnProfile() below for
 *  the one read that isn't. */
export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Resolves (and, for a brand-new Google sign-in, creates) the CALLER's own
 * profile — via the server, never via the browser's local Firestore SDK.
 *
 * Why: firebase-js-sdk has a known, still-open bug
 * (github.com/firebase/firebase-js-sdk/issues/8593) where, right after the
 * browser's "Clear site data" wipes IndexedDB out from under an
 * already-open Firestore connection, the client's local persistence layer
 * can come back corrupted — and this can affect getDoc() AND
 * getDocFromServer() alike, because the SDK's local sync engine
 * reconciles even server-sourced reads against its own (corrupted) local
 * cache state before resolving them. In other words: no client-side read
 * function is fully trustworthy for this after that sequence of events.
 *
 * So this doesn't read Firestore from the browser at all. It calls
 * /api/resolve-profile (see that file), a Vercel serverless function using
 * the Firebase ADMIN SDK, which talks to Firestore directly from the
 * server — no browser, no IndexedDB, nothing "Clear site data" can ever
 * touch. That endpoint also does the same-email-different-uid conflict
 * check and the atomic starter-profile creation that used to happen here.
 */
async function resolveOwnProfile(user) {
  const idToken = await user.getIdToken();
  const res = await fetch("/api/resolve-profile", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `resolve-profile failed (${res.status})`);
  return body; // { status: "existing" | "new" | "conflict", profile?, message? }
}

/**
 * Subscribe to Firebase's auth-state changes.
 * Calls onLogin(user, profile) or onLogout() as appropriate; onConflict(message),
 * if provided, is called (instead of onLogin) when a same-email-different-uid
 * collision is caught, or when the server-side profile check itself fails —
 * the person is signed out again so they land back on the auth screen with
 * an explanation, rather than silently getting a second blank profile.
 * This is the single source of truth for whether the app shell shows.
 */
export function watchAuthState(onLogin, onLogout, onConflict) {
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      let result;
      try {
        result = await resolveOwnProfile(user);
      } catch {
        // Couldn't reach the server to confirm one way or the other (e.g.
        // genuinely offline, or the API route itself is down). Sign back
        // out and ask for a retry rather than ever guessing "new student"
        // client-side — see resolveOwnProfile() above for why no
        // client-side fallback here is safe.
        await signOut(auth);
        if (onConflict) {
          onConflict("Couldn't reach GeoHub's server to load your profile. Please check your connection and try signing in again.");
        }
        return;
      }

      if (result.status === "conflict") {
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

/** Turns a raw Firebase auth error into a short, student-friendly message. */
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
  return map[err.code] || "Something went wrong. Please try again.";
}
