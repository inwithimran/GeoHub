import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError } from "../_lib/adminApp.js";
import { requiredText, enumOrEmpty } from "../_lib/validators.js";
import { isDisposableEmailAsync } from "../_lib/disposable-domains.js";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const GENDERS = ["male", "female", "other"];
const PHONE_RE = /^[0-9+\-\s()]{6,20}$/;

function visibleContactMirror({ phone, email }) {
  return {
    email: email || "",
    phone: phone || ""
  };
}

export async function createProfile(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());
    const userRef = db.collection("users").doc(uid);

    const existing = await userRef.get();
    if (existing.exists) {
      throw new ApiError(409, "A profile already exists for this account.");
    }

    const body = req.body || {};
    const name = requiredText(body.name, "Name", 60);
    const roll = requiredText(body.roll, "Class roll", 30);
    const bloodGroup = enumOrEmpty(body.blood, "Blood group", BLOOD_GROUPS);
    const gender = enumOrEmpty(body.gender, "Gender", GENDERS);
    const phone = requiredText(body.phone, "Phone number", 20);
    if (!PHONE_RE.test(phone)) throw new ApiError(400, "That doesn't look like a valid phone number.");

    const email = decoded.email || "";
    if (!email) throw new ApiError(400, "No verified email on this account.");
    if (await isDisposableEmailAsync(email, db)) throw new ApiError(403, "Temporary or disposable email addresses aren't allowed. Please sign up with a permanent email address.");

    const mirror = visibleContactMirror({ phone, email });

    const profile = {
      uid,
      name,
      roll,
      bloodGroup,
      gender,
      ...mirror,
      photoURL: "",
      bio: "",
      session: "",
      year: "",
      hometown: "",
      address: "",
      socialLink: "",
      hidePhone: false,
      hideEmail: false,
      nameChangedAt: null,
      profileIncomplete: false,
      createdAt: FieldValue.serverTimestamp()
    };

    await db.runTransaction(async (tx) => {
      const freshSnap = await tx.get(userRef);
      if (freshSnap.exists) throw new ApiError(409, "A profile already exists for this account.");
      tx.set(userRef, profile);
      tx.set(userRef.collection("private").doc("contact"), { phone, email });
    });

    return res.status(200).json({ profile: { ...profile, phone, email } });
  } catch (err) {
    return sendError(res, err);
  }
}
