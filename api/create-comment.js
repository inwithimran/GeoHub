// ============================================================
// api/create-comment.js — Vercel Serverless Function.
//
// Same reasoning as api/create-post.js, applied to comments
// (js/post-detail.js's submitComment): authorName/authorEmail are
// looked up server-side (never trusted from the client), mentions are
// checked against real profiles, and — the one comment-specific check —
// `postId` must actually exist, so a comment can't be created dangling
// under a made-up or already-deleted post id.
//
// firestore.rules is changed to require every new comment go through
// here (`allow create: if false` on /posts/{postId}/comments/{commentId}).
//
// Needs FIREBASE_SERVICE_ACCOUNT (same as the other API routes).
// ============================================================
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { requiredText, validateMentions } from "./_lib/validators.js";

const COMMENT_TEXT_LIMIT = 500;
const MIN_MS_BETWEEN_COMMENTS = 2000;

export default async function handler(req, res) {
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

    const commentRef = db.collection("posts").doc(postId).collection("comments").doc();
    const batch = db.batch();
    batch.set(commentRef, {
      authorUid: uid,
      authorName: author.name || "",
      authorEmail: author.email || decoded.email || "",
      text,
      mentions,
      createdAt: FieldValue.serverTimestamp()
    });
    batch.update(postSnap.ref, { commentCount: FieldValue.increment(1) });
    await batch.commit();

    return res.status(200).json({ id: commentRef.id, postAuthorUid: postSnap.get("authorUid") || null });
  } catch (err) {
    return sendError(res, err);
  }
}
