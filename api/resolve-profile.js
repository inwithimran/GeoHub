// ============================================================
// api/resolve-profile.js — Vercel Serverless Function.
//
// WHY THIS EXISTS
// ----------------------------------------------------------------------------
// firebase-js-sdk (the browser SDK) has a known, still-open bug
// (github.com/firebase/firebase-js-sdk/issues/8593): right after the
// browser's "Clear site data" wipes IndexedDB out from under an
// already-open Firestore connection, the client's local persistence layer
// can come back corrupted — and getDoc()/getDocFromServer() can BOTH end
// up confidently reporting "document doesn't exist" for a document that is
// very much still on the server, because the SDK's local sync engine
// reconciles even server-sourced reads against its own (corrupted) local
// cache state before resolving them.
//
// That read used to be the ONLY thing deciding "is this a returning
// student or a brand-new one" (see js/auth.js's watchAuthState). Getting
// it wrong silently spawns a second blank profile and makes the student's
// real one look "lost" — and no amount of choosing which client-side read
// function to call can fully fix it, because the corruption lives in the
// browser's local database itself, not in which Firestore API is used to
// read it.
//
// This is also, not coincidentally, how large social apps handle this
// class of problem in general: the browser's local cache is treated as a
// convenience for read-heavy, tolerate-some-staleness UI (a feed, a
// directory list) — never as the source of truth for an identity-critical
// decision like "does this account exist". That decision is made by a
// server the client doesn't control the cache of. Here, that's this
// endpoint: it uses the Firebase ADMIN SDK, which talks to Firestore
// directly from Vercel's servers and has no browser, no IndexedDB, and
// nothing "Clear site data" can ever touch.
//
// FLOW
// ----------------------------------------------------------------------------
// Right after Firebase Auth resolves who's signed in (onAuthStateChanged),
// the client calls this endpoint with its ID token instead of reading
// users/{uid} itself. This endpoint:
//   1. Verifies the ID token (proves who's actually asking).
//   2. Reads users/{uid} via the Admin SDK — authoritative, cache-proof.
//   3. If it exists: returns it as-is.
//   4. If it doesn't exist and this is a Google sign-in: checks (still via
//      Admin SDK) whether some OTHER uid already has a profile for this
//      email — the same-email-different-uid guard that used to live in
//      js/auth.js's findProfileByEmail() — and, if genuinely new, creates
//      the starter profile in a transaction (atomic: two rapid calls for
//      the same brand-new uid can't ever create two starter profiles).
//   5. If it doesn't exist and this is NOT a Google sign-in: something's
//      wrong (email/password signUp() already writes the doc synchronously
//      before this could ever run) — reported as an error rather than
//      guessed at.
//
// Needs one environment variable set in the Vercel project (same one
// api/send-push.js already needs):
//   FIREBASE_SERVICE_ACCOUNT — the full JSON key of a Firebase service account.
// ============================================================
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: "Missing Authorization bearer token." });

  try {
    const app = getAdminApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);
    const uid = decoded.uid;
    const email = decoded.email || "";
    const isGoogleUser = decoded.firebase?.sign_in_provider === "google.com";

    const db = getFirestore(app);
    const userRef = db.collection("users").doc(uid);
    const snap = await userRef.get();

    if (snap.exists) {
      const profile = snap.data();
      // Merge in the real, unmasked phone/email from the private subdoc —
      // same reason js/auth.js used to do this client-side: a student who's
      // hidden their number should still see their real number in their own
      // "Edit Profile" form. Admin SDK reads bypass security rules, so this
      // is safe here even though a regular signed-in client couldn't read
      // another student's private/contact doc.
      const contactSnap = await userRef.collection("private").doc("contact").get();
      if (contactSnap.exists) {
        const contact = contactSnap.data();
        if (contact.phone !== undefined) profile.phone = contact.phone;
        if (contact.email !== undefined) profile.email = contact.email;
      }
      return res.status(200).json({ status: "existing", profile });
    }

    if (!isGoogleUser) {
      // email/password signUp() writes users/{uid} synchronously before the
      // client ever gets here, so a missing doc for a password account means
      // something genuinely went wrong (e.g. the write failed) — surface it
      // instead of guessing.
      return res.status(409).json({ error: "No profile record found for this account." });
    }

    // Same-email-different-uid guard, done authoritatively (Admin SDK reads
    // bypass Firestore security rules entirely, so — unlike the old client-side
    // findProfileByEmail() — this also catches the case where the other
    // profile's email happens to be hidden/masked).
    const dupSnap = await db.collection("users").where("email", "==", email).limit(5).get();
    const dup = dupSnap.docs.find((d) => d.id !== uid);
    if (dup) {
      return res.status(200).json({
        status: "conflict",
        message:
          `A GeoHub profile for ${email} already exists under a different sign-in. ` +
          `You may have picked a different Google account than the one you used before. ` +
          `Please try "Continue with Google" again and make sure to choose the right account.`
      });
    }

    // Genuinely brand-new — create the starter profile. The transaction
    // re-checks existence right before writing, so two near-simultaneous
    // calls for the same new uid (e.g. a double-click, or a retry) can
    // never race into creating it twice.
    const profile = await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(userRef);
      if (freshSnap.exists) return freshSnap.data();
      const starter = {
        uid,
        name: decoded.name || "New Student",
        roll: "",
        bloodGroup: "",
        gender: "",
        phone: "",
        email,
        photoURL: decoded.picture || "",
        bio: "",
        session: "",
        year: "",
        hometown: "",
        address: "",
        socialLink: "",
        hidePhone: false,
        hideEmail: false,
        nameChangedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        profileIncomplete: true
      };
      tx.set(userRef, starter);
      tx.set(userRef.collection("private").doc("contact"), { phone: "", email });
      return starter;
    });

    return res.status(200).json({ status: "new", profile });
  } catch (err) {
    console.error("resolve-profile error:", err);
    return res.status(500).json({ error: err.message || "Failed to resolve profile." });
  }
}
