import crypto from "node:crypto";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { getFirestore } from "firebase-admin/firestore";

const CLOUD_NAME = "s9htrtz2";
const UPLOAD_PRESET = "GeoHub";
// Every folder the app is allowed to upload into. Keep this in sync with
// isOwnCloudinaryUrl()'s callers in validators.js / update-profile.js.
const ALLOWED_FOLDERS = new Set(["geohub/avatars", "geohub/posts", "geohub/resources"]);

function signParams(params, apiSecret) {
  const toSign = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return crypto.createHash("sha1").update(toSign + apiSecret).digest("hex");
}

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;

    if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      throw new ApiError(500, "Uploads aren't configured on the server.");
    }

    const db = getFirestore(getAdminApp());
    await enforceRateLimit(db, uid, "sign-upload", 800);

    const body = req.body || {};
    const folder = typeof body.folder === "string" ? body.folder : "";
    if (!ALLOWED_FOLDERS.has(folder)) {
      throw new ApiError(400, "Invalid upload folder.");
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { folder, timestamp, upload_preset: UPLOAD_PRESET };
    const signature = signParams(paramsToSign, process.env.CLOUDINARY_API_SECRET);

    return res.status(200).json({
      cloudName: CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      uploadPreset: UPLOAD_PRESET,
      folder,
      timestamp,
      signature
    });
  } catch (err) {
    return sendError(res, err);
  }
}
