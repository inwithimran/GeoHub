import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "../_lib/adminApp.js";
import { ADMIN_EMAILS } from "../../shared/admin-config.js";

export async function deleteComment(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;
    const db = getFirestore(getAdminApp());

    const body = req.body || {};
    const postId = typeof body.postId === "string" ? body.postId : "";
    const commentId = typeof body.commentId === "string" ? body.commentId : "";
    if (!postId || !commentId) throw new ApiError(400, "Missing postId or commentId.");

    await enforceRateLimit(db, uid, "delete-comment", 1000);

    const postRef = db.collection("posts").doc(postId);
    const commentRef = postRef.collection("comments").doc(commentId);
    const [postSnap, commentSnap] = await Promise.all([postRef.get(), commentRef.get()]);
    if (!commentSnap.exists) throw new ApiError(404, "That comment no longer exists.");

    const comment = commentSnap.data();
    const isCommentAuthor = comment.authorUid === uid;
    const isPostAuthor = postSnap.exists && postSnap.get("authorUid") === uid;
    const isAdmin = ADMIN_EMAILS.includes(decoded.email || "");
    if (!isCommentAuthor && !isPostAuthor && !isAdmin) {
      throw new ApiError(403, "You can only delete your own comments.");
    }

    await commentRef.delete();

    if (postSnap.exists) {
      if (typeof postSnap.get("commentCount") === "number") {
        await postRef.update({ commentCount: FieldValue.increment(-1) });
      } else {
        const countSnap = await postRef.collection("comments").count().get();
        await postRef.update({ commentCount: countSnap.data().count });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}
