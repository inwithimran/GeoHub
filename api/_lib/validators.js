// ============================================================
// api/_lib/validators.js — shared input validation for the
// write-validation API routes (create-post, create-comment,
// update-profile).
//
// The point of these routes isn't "prove someone is signed in" —
// firestore.rules already does that, and does it for every write,
// with no way for a client to skip it. What Firestore rules
// genuinely CAN'T do well is: cross-check an array of {uid,name}
// mentions against real profiles, restrict an image URL to actually
// being one this app uploaded (vs. any arbitrary string), or re-derive
// something (hashtags) from the text instead of trusting whatever
// array the client attached to it. That richer checking is what
// lives here — see each function's comment.
//
// Every validator either returns a clean value or throws an ApiError
// (see adminApp.js) with a message that's safe to show the caller.
// ============================================================
import { ApiError } from "./adminApp.js";

const CLOUDINARY_CLOUD = "s9htrtz2";

export function requiredText(value, field, maxLen) {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new ApiError(400, `${field} is required.`);
  if (s.length > maxLen) throw new ApiError(400, `${field} is too long (max ${maxLen} characters).`);
  return s;
}

export function optionalText(value, field, maxLen) {
  if (value === undefined || value === null) return "";
  const s = typeof value === "string" ? value.trim() : "";
  if (s.length > maxLen) throw new ApiError(400, `${field} is too long (max ${maxLen} characters).`);
  return s;
}

export function enumOrEmpty(value, field, allowed) {
  const s = typeof value === "string" ? value : "";
  if (s === "" || allowed.includes(s)) return s;
  throw new ApiError(400, `${field} has an invalid value.`);
}

export function isOwnCloudinaryUrl(url, folder) {
  if (typeof url !== "string" || url.length > 600) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "https:" || u.hostname !== "res.cloudinary.com") return false;
  if (!u.pathname.startsWith(`/${CLOUDINARY_CLOUD}/image/upload/`)) return false;
  return u.pathname.includes(`/${folder}/`);
}

export function validateImages(raw, folder, max = 6) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "images must be a list.");
  if (raw.length > max) throw new ApiError(400, `You can attach up to ${max} photos.`);
  raw.forEach((url) => {
    if (!isOwnCloudinaryUrl(url, folder)) throw new ApiError(400, "One of the attached photos isn't a valid upload.");
  });
  return raw;
}

const HASHTAG_RE = /#([A-Za-z0-9_\u0980-\u09FF]{2,40})/g;
export function deriveHashtags(text) {
  const found = new Set();
  for (const m of text.matchAll(HASHTAG_RE)) found.add(m[1].toLowerCase());
  return [...found];
}

export async function validateMentions(db, raw, callerUid, max = 20) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "mentions must be a list.");
  const candidates = raw
    .filter((m) => m && typeof m.uid === "string" && typeof m.name === "string" && m.uid !== callerUid)
    .slice(0, max);
  if (!candidates.length) return [];
  const refs = candidates.map((m) => db.collection("users").doc(m.uid));
  const snaps = await db.getAll(...refs);
  const out = [];
  snaps.forEach((snap, i) => {
    if (snap.exists && snap.get("name") === candidates[i].name) {
      out.push({ uid: candidates[i].uid, name: candidates[i].name });
    }
  });
  return out;
}

export function validatePoll(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || !Array.isArray(raw.options)) throw new ApiError(400, "Malformed poll.");
  const options = raw.options
    .map((o, i) => ({ id: typeof o?.id === "string" ? o.id : `opt${i}`, text: typeof o?.text === "string" ? o.text.trim() : "" }))
    .filter((o) => o.text)
    .slice(0, 6)
    .map((o) => {
      if (o.text.length > 80) throw new ApiError(400, "A poll option is too long (max 80 characters).");
      return o;
    });
  if (options.length < 2) return null;
  return { options, votes: {} };
}
