import { getFirestore } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { requiredText, requiredUrl, enumOrEmpty, isOwnCloudinaryUrl } from "./_lib/validators.js";
import { RESOURCE_CATEGORIES } from "../shared/resource-categories.js";

const TITLE_LIMIT = 150;

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());

    const body = req.body || {};
    const resId = typeof body.resId === "string" ? body.resId : "";
    if (!resId) throw new ApiError(400, "Missing resId.");

    await enforceRateLimit(db, uid, "edit-resource", 2000);

    const resRef = db.collection("resources").doc(resId);
    const resSnap = await resRef.get();
    if (!resSnap.exists) throw new ApiError(404, "That resource no longer exists.");
    if (resSnap.get("contributorUid") !== uid) throw new ApiError(403, "You can only edit your own resources.");

    const title = requiredText(body.title, "Title", TITLE_LIMIT);
    const category = enumOrEmpty(body.category, "Category", RESOURCE_CATEGORIES);

    // sourceType is fixed at creation time and never accepted from the
    // client on edit — the link must still match whichever type it was.
    const sourceType = resSnap.get("sourceType");
    let link;
    if (sourceType === "upload") {
      if (!isOwnCloudinaryUrl(body.link, "geohub/resources")) throw new ApiError(400, "Invalid uploaded file.");
      link = body.link;
    } else {
      link = requiredUrl(body.link, "Link");
    }

    const updates = { title, category, link };
    await resRef.update(updates);

    return res.status(200).json({ ok: true, ...updates });
  } catch (err) {
    return sendError(res, err);
  }
}
