// ============================================================
// AUTH.JS — Sign up, log in, log out, and auth-state watching.
// Writes a profile document to Firestore at users/{uid} on signup.
// ============================================================
import { auth, db } from "./firebase-config.js";
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
  doc, setDoc, updateDoc, getDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

/** In-memory cache of the logged-in student's profile (name, roll, blood, phone). */
export let currentProfile = null;

const googleProvider = new GoogleAuthProvider();

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
    gender: data.gender || "",
    phone: data.phone.trim(),
    email: data.email.trim(),
    photoURL: "",
    bio: "",
    session: "",
    year: "",
    hometown: "",
    address: "",
    socialLink: "",
    hidePhone: false,
    hideEmail: false,
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "users", cred.user.uid), profile);
  currentProfile = profile;
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
export async function updateProfileDetails({ roll, blood, phone, bio, session, year, hometown, address, socialLink, gender, hidePhone, hideEmail, photoURL }) {
  const uid = auth.currentUser.uid;
  const updates = {
    roll: roll.trim(),
    bloodGroup: blood,
    phone: phone.trim(),
    profileIncomplete: false
  };
  if (bio !== undefined) updates.bio = bio.trim();
  if (session !== undefined) updates.session = session.trim();
  if (year !== undefined) updates.year = year;
  if (hometown !== undefined) updates.hometown = hometown.trim();
  if (address !== undefined) updates.address = address.trim();
  if (socialLink !== undefined) updates.socialLink = socialLink.trim();
  if (gender !== undefined && gender) updates.gender = gender;
  if (hidePhone !== undefined) updates.hidePhone = !!hidePhone;
  if (hideEmail !== undefined) updates.hideEmail = !!hideEmail;
  if (photoURL !== undefined && photoURL) updates.photoURL = photoURL;

  await updateDoc(doc(db, "users", uid), updates);
  currentProfile = { ...currentProfile, ...updates };
  return currentProfile;
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
      let profile = await fetchProfile(user.uid);

      // First-ever sign-in with Google has no matching users/{uid} doc yet —
      // create a starter profile (roll/blood/phone blank) right here so
      // there's a single, race-free place this happens.
      const isGoogleUser = user.providerData.some(p => p.providerId === "google.com");
      if (!profile && isGoogleUser) {
        profile = {
          uid: user.uid,
          name: user.displayName || "New Student",
          roll: "",
          bloodGroup: "",
          gender: "",
          phone: "",
          email: user.email || "",
          photoURL: user.photoURL || "",
          bio: "",
          session: "",
          year: "",
          hometown: "",
          address: "",
          socialLink: "",
          hidePhone: false,
          hideEmail: false,
          createdAt: serverTimestamp(),
          profileIncomplete: true
        };
        await setDoc(doc(db, "users", user.uid), profile);
      }

      currentProfile = profile;
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
