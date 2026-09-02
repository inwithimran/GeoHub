import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { requiredText, validateMentions } from "./_lib/validators.js";

const COMMENT_TEXT_LIMIT = 500;

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());

    const body = req.body || {};
    const postId = typeof body.postId === "string" ? body.postId : "";
    const commentId = typeof body.commentId === "string" ? body.commentId : "";
    if (!postId || !commentId) throw new ApiError(400, "Missing postId or commentId.");

    await enforceRateLimit(db, uid, "edit-comment", 2000);

    const commentRef = db.collection("posts").doc(postId).collection("comments").doc(commentId);
    const commentSnap = await commentRef.get();
    if (!commentSnap.exists) throw new ApiError(404, "That comment no longer exists.");
    if (commentSnap.get("authorUid") !== uid) throw new ApiError(403, "You can only edit your own comments.");

    const text = requiredText(body.text, "Comment", COMMENT_TEXT_LIMIT);
    const mentions = await validateMentions(db, body.mentions, uid, 20);

    const updates = { text, mentions, editedAt: FieldValue.serverTimestamp() };
    await commentRef.update(updates);

    return res.status(200).json({ ok: true, ...updates, editedAt: new Date().toISOString() });
  } catch (err) {
    return sendError(res, err);
  }
}
