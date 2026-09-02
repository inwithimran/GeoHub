import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "../_lib/adminApp.js";
import { requiredText, requiredUrl, enumOrEmpty, isOwnCloudinaryUrl, optionalText } from "../_lib/validators.js";
import { RESOURCE_CATEGORIES } from "../../shared/resource-categories.js";

const TITLE_LIMIT = 150;
const SOURCE_TYPES = ["link", "upload"];

export async function createResource(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());

    await enforceRateLimit(db, uid, "create-resource", 3000);

    const authorSnap = await db.collection("users").doc(uid).get();
    if (!authorSnap.exists) throw new ApiError(409, "Your profile isn't set up yet — please finish onboarding first.");
    const author = authorSnap.data();

    const body = req.body || {};
    const title = requiredText(body.title, "Title", TITLE_LIMIT);
    const category = enumOrEmpty(body.category, "Category", RESOURCE_CATEGORIES);
    const sourceType = enumOrEmpty(body.sourceType, "Source type", SOURCE_TYPES);
    if (!sourceType) throw new ApiError(400, "Source type is required.");

    let link;
    if (sourceType === "upload") {
      if (!isOwnCloudinaryUrl(body.link, "geohub/resources")) throw new ApiError(400, "Invalid uploaded file.");
      link = body.link;
    } else {
      link = requiredUrl(body.link, "Link");
    }

    const fileExt = optionalText(body.fileExt, "File extension", 10);
    const fileName = optionalText(body.fileName, "File name", 200);

    const resRef = await db.collection("resources").add({
      title,
      category,
      link,
      sourceType,
      fileExt: fileExt || null,
      fileName: fileName || null,
      contributorName: author.name || "",
      contributorUid: uid,
      openCount: 0,
      createdAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({ id: resRef.id });
  } catch (err) {
    return sendError(res, err);
  }
}
