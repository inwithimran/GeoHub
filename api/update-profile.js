import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError } from "./_lib/adminApp.js";
import { requiredText, optionalText, enumOrEmpty, isOwnCloudinaryUrl } from "./_lib/validators.js";
import { ADMIN_EMAILS } from "../shared/admin-config.js";

const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const GENDERS = ["male", "female", "other"];
const YEARS = ["1st Year", "2nd Year", "3rd Year", "4th Year", "Honours Completed"];
const PHONE_RE = /^[0-9+\-\s()]{6,20}$/;
const NAME_CHANGE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

function visibleContactMirror({ phone, email, hidePhone, hideEmail }) {
  return {
    email: (ADMIN_EMAILS.includes(email) || !hideEmail) ? (email || "") : "",
    phone: hidePhone ? "" : (phone || "")
  };
}

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());
    const userRef = db.collection("users").doc(uid);

    const body = req.body || {};

    const roll = requiredText(body.roll, "Class roll", 30);
    const bloodGroup = enumOrEmpty(body.blood, "Blood group", BLOOD_GROUPS);
    const gender = enumOrEmpty(body.gender, "Gender", GENDERS);
    const year = enumOrEmpty(body.year, "Year", YEARS);
    const phone = requiredText(body.phone, "Phone number", 20);
    if (!PHONE_RE.test(phone)) throw new ApiError(400, "That doesn't look like a valid phone number.");
    const session = optionalText(body.session, "Session", 40);
    const hometown = optionalText(body.hometown, "Hometown", 100);
    const address = optionalText(body.address, "Address", 150);
    const socialLink = optionalText(body.socialLink, "Social link", 300);
    if (socialLink && !/^https?:\/\//i.test(socialLink)) throw new ApiError(400, "Social link must start with http:// or https://.");
    const bio = optionalText(body.bio, "Bio", 150);
    const hidePhone = !!body.hidePhone;
    const hideEmail = !!body.hideEmail;
    let photoURL;
    if (body.photoURL !== undefined && body.photoURL !== "") {
      if (!isOwnCloudinaryUrl(body.photoURL, "geohub/avatars")) throw new ApiError(400, "Invalid profile photo.");
      photoURL = body.photoURL;
    }
    const rawName = typeof body.name === "string" ? body.name.trim() : undefined;
    if (rawName !== undefined && rawName.length > 60) throw new ApiError(400, "Name is too long (max 60 characters).");

    const profile = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new ApiError(409, "Your profile isn't set up yet — please finish onboarding first.");
      const current = snap.data();

      const realEmail = current.email || decoded.email || "";
      const mirror = visibleContactMirror({ phone, email: realEmail, hidePhone, hideEmail });

      const updates = {
        roll,
        bloodGroup,
        profileIncomplete: false,
        hidePhone,
        hideEmail,
        ...mirror
      };
      if (body.session !== undefined) updates.session = session;
      if (body.year !== undefined) updates.year = year;
      if (body.hometown !== undefined) updates.hometown = hometown;
      if (body.address !== undefined) updates.address = address;
      if (body.socialLink !== undefined) updates.socialLink = socialLink;
      if (gender) updates.gender = gender;
      if (photoURL) updates.photoURL = photoURL;

      if (rawName && rawName !== (current.name || "")) {
        const lastChangeMs = current.nameChangedAt?.toMillis ? current.nameChangedAt.toMillis() : 0;
        if (lastChangeMs && Date.now() - lastChangeMs < NAME_CHANGE_COOLDOWN_MS) {
          const daysLeft = Math.max(1, Math.ceil((NAME_CHANGE_COOLDOWN_MS - (Date.now() - lastChangeMs)) / (24 * 60 * 60 * 1000)));
          throw new ApiError(429, `You can change your name again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.`);
        }
        updates.name = rawName;
        updates.nameChangedAt = FieldValue.serverTimestamp();
      }

      tx.update(userRef, updates);
      tx.set(userRef.collection("private").doc("contact"), { phone, email: realEmail }, { merge: true });
      return { ...current, ...updates, phone, email: realEmail };
    });

    return res.status(200).json({ profile });
  } catch (err) {
    return sendError(res, err);
  }
}
