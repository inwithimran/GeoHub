import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "../_lib/adminApp.js";
import { requiredText, validateImages, validateMentions, validatePoll, deriveHashtags } from "../_lib/validators.js";

const POST_TEXT_LIMIT = 3000;
const MIN_MS_BETWEEN_POSTS = 5000; 

export async function createPost(req, res) {
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
