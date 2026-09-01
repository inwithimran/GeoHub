// ============================================================
// api/create-post.js — Vercel Serverless Function.
//
// WHY THIS EXISTS
// ----------------------------------------------------------------------------
// js/wall.js used to call addDoc(collection(db, "posts"), {...}) directly
// from the browser. firestore.rules already stopped the obvious abuse
// (authorUid must match the caller, text capped at 3000 chars) — but rules
// can't cheaply do everything worth checking: that an image URL is really
// one this app's own Cloudinary upload produced (not an arbitrary string),
// that a poll's `votes` map starts empty rather than whatever the client
// sent, that `hashtags` actually match the text instead of being invented,
// or that a `mentions` entry names a real classmate rather than a spoofed
// {uid, name} pair used to fake a notification. This route does all of
// that with the Admin SDK (server-side, cache-proof, rule-bypassing — see
// api/resolve-profile.js for the fuller version of this reasoning), then
// firestore.rules is changed to require every new post go through here
// (`allow create: if false` on /posts/{postId} — see firestore.rules).
//
// authorName/authorEmail are also looked up server-side from the caller's
// OWN profile doc rather than trusted from the request body, so a post
// can never be created under a spoofed display name.
//
// Needs FIREBASE_SERVICE_ACCOUNT (same as the other two API routes).
// ============================================================
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "./_lib/adminApp.js";
import { requiredText, validateImages, validateMentions, validatePoll, deriveHashtags } from "./_lib/validators.js";

const POST_TEXT_LIMIT = 3000; // mirrors js/wall.js's POST_TEXT_LIMIT + firestore.rules' textWithinLimit("text", 3000)
const MIN_MS_BETWEEN_POSTS = 5000; // a real student writing separate posts is never this fast

export default async function handler(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;

    const db = getFirestore(getAdminApp());
    await enforceRateLimit(db, uid, "create-post", MIN_MS_BETWEEN_POSTS);

    const authorSnap = await db.collection("users").doc(uid).get();
    if (!authorSnap.exists) throw new ApiError(409, "Your profile isn't set up yet — please finish onboarding first.");
    const author = authorSnap.data();

    const body = req.body || {};
    const text = requiredText(body.text, "Post text", POST_TEXT_LIMIT);
    const images = validateImages(body.images, "geohub/posts", 6);
    const mentions = await validateMentions(db, body.mentions, uid, 20);
    const poll = validatePoll(body.poll);
    const hashtags = deriveHashtags(text);

    const postRef = await db.collection("posts").add({
      authorUid: uid,
      authorName: author.name || "",
      authorEmail: author.email || decoded.email || "",
      text,
      images,
      likes: [],
      reactions: {},
      pinned: false,
      hashtags,
      mentions,
      poll,
      createdAt: FieldValue.serverTimestamp()
    });

    return res.status(200).json({ id: postRef.id });
  } catch (err) {
    return sendError(res, err);
  }
}
