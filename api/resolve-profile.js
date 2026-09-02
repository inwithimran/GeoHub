import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { isDisposableEmailAsync } from "./_lib/disposable-domains.js";

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
      const contactSnap = await userRef.collection("private").doc("contact").get();
      if (contactSnap.exists) {
        const contact = contactSnap.data();
        if (contact.phone !== undefined) profile.phone = contact.phone;
        if (contact.email !== undefined) profile.email = contact.email;
      }
      return res.status(200).json({ status: "existing", profile });
    }

    if (!isGoogleUser) {
      return res.status(409).json({ error: "No profile record found for this account." });
    }

    if (await isDisposableEmailAsync(email, db)) {
      try { await getAuth(app).deleteUser(uid); } catch { }
      return res.status(200).json({
        status: "blocked",
        message: "Temporary or disposable email addresses aren't allowed on GeoHub. Please use a permanent email address."
      });
    }

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
