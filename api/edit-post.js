import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { requiredText, validateImages, validateMentions, deriveHashtags } from "./_lib/validators.js";

const POST_TEXT_LIMIT = 3000;

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());

    const body = req.body || {};
    const postId = typeof body.postId === "string" ? body.postId : "";
    if (!postId) throw new ApiError(400, "Missing postId.");

    await enforceRateLimit(db, uid, "edit-post", 2000);

    const postRef = db.collection("posts").doc(postId);
    const postSnap = await postRef.get();
    if (!postSnap.exists) throw new ApiError(404, "That post no longer exists.");
    if (postSnap.get("authorUid") !== uid) throw new ApiError(403, "You can only edit your own posts.");

    const text = requiredText(body.text, "Post text", POST_TEXT_LIMIT);
    const images = validateImages(body.images, "geohub/posts", 6);
    const mentions = await validateMentions(db, body.mentions, uid, 20);
    const hashtags = deriveHashtags(text);

    const updates = { text, images, mentions, hashtags, editedAt: FieldValue.serverTimestamp() };
    await postRef.update(updates);

    return res.status(200).json({ ok: true, ...updates, editedAt: new Date().toISOString() });
  } catch (err) {
    return sendError(res, err);
  }
}
