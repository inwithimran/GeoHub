import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "../_lib/adminApp.js";
import { requiredText, validateMentions } from "../_lib/validators.js";

const COMMENT_TEXT_LIMIT = 500;
const MIN_MS_BETWEEN_COMMENTS = 2000;

export async function createComment(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;

    const db = getFirestore(getAdminApp());
    await enforceRateLimit(db, uid, "create-comment", MIN_MS_BETWEEN_COMMENTS);

    const body = req.body || {};
    const postId = typeof body.postId === "string" ? body.postId : "";
    if (!postId) throw new ApiError(400, "Missing postId.");

    const [authorSnap, postSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("posts").doc(postId).get()
    ]);
    if (!authorSnap.exists) throw new ApiError(409, "Your profile isn't set up yet — please finish onboarding first.");
    if (!postSnap.exists) throw new ApiError(404, "That post no longer exists.");
    const author = authorSnap.data();

    const text = requiredText(body.text, "Comment", COMMENT_TEXT_LIMIT);
    const mentions = await validateMentions(db, body.mentions, uid, 20);

    let replyTo = null;
    const replyToRaw = body.replyTo;
    if (replyToRaw && typeof replyToRaw.id === "string" && replyToRaw.id) {
      const parentSnap = await db.collection("posts").doc(postId).collection("comments").doc(replyToRaw.id).get();
      if (!parentSnap.exists) throw new ApiError(400, "That comment no longer exists.");
      const parentData = parentSnap.data();
      const topLevelId = parentData.replyTo ? parentData.replyTo.id : parentSnap.id;
      const topLevelSnap = topLevelId === parentSnap.id
        ? parentSnap
        : await db.collection("posts").doc(postId).collection("comments").doc(topLevelId).get();
      if (!topLevelSnap.exists) throw new ApiError(400, "That comment no longer exists.");
      replyTo = { id: topLevelId, authorUid: parentData.authorUid, authorName: parentData.authorName || "" };
    }

    const postRef = db.collection("posts").doc(postId);
    const commentRef = await postRef.collection("comments").add({
      authorUid: uid,
      authorName: author.name || "",
      authorEmail: author.email || decoded.email || "",
      text,
      mentions,
      ...(replyTo ? { replyTo } : {}),
      createdAt: FieldValue.serverTimestamp()
    });

    if (typeof postSnap.get("commentCount") === "number") {
      await postRef.update({ commentCount: FieldValue.increment(1) });
    } else {
      const countSnap = await postRef.collection("comments").count().get();
      await postRef.update({ commentCount: countSnap.data().count });
    }

    return res.status(200).json({
      id: commentRef.id,
      postAuthorUid: postSnap.get("authorUid") || null,
      replyTargetUid: replyTo ? replyTo.authorUid : null
    });
  } catch (err) {
    return sendError(res, err);
  }
}
