// ============================================================
// api/send-push.js — Vercel Serverless Function.
//
// This is the SERVER side of push notifications. It runs on
// Vercel, NOT on Firebase — so it needs no Firebase Blaze plan.
// Firestore reads/writes and sending FCM messages are both free
// on the Firebase Spark (free) plan; Blaze was only ever required
// because Firebase *Cloud Functions* need billing enabled to
// deploy at all. Moving the same logic here sidesteps that.
//
// Flow: after a student's browser successfully writes a new post/
// resource/notice/comment to Firestore (see wall.js, resources.js,
// routine.js), it calls this endpoint with a Firebase ID token +
// a small payload describing what happened. This function verifies
// that token (so only a signed-in student can trigger a send),
// looks up every registered device's FCM token under
// users/{uid}/fcmTokens/{token}, and pushes the notification out.
//
// SECURITY: verifying the ID token only proves someone is SIGNED IN
// — by itself it doesn't prove the thing they're claiming just
// happened (a new post/notice/etc.) actually did. Without checking
// that, any signed-in student could call this endpoint directly
// (bypassing the UI entirely) with an arbitrary `text` and, worse,
// `type: "notice", urgent: true` to blast a fake "urgent notice" to
// the whole department without ever creating a real one. So every
// request here is checked against Firestore before anything is
// sent — see verifyClaim() below — and a lightweight per-user
// cooldown guards against simple spam even from legitimate actions.
//
// Needs one environment variable set in the Vercel project:
//   FIREBASE_SERVICE_ACCOUNT — the full JSON key of a Firebase
//   service account (see the setup guide for how to get this).
// ============================================================
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getAuth } from "firebase-admin/auth";

const ADMIN_EMAILS = ["in.with.imran@gmail.com"]; // keep in sync with js/firebase-config.js and firestore.rules
const MIN_MS_BETWEEN_PUSHES = 5000; // per-user cooldown, guards against simple spam
// How recently the referenced document must have been created for this
// request to count as "reporting something that just happened", rather
// than replaying an old id to re-send a notification repeatedly.
const MAX_CLAIM_AGE_MS = 2 * 60 * 1000;

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

/** Every { uid, token } pair registered for push, across every student except `excludeUid`. */
async function collectAllTokens(db, excludeUid) {
  const usersSnap = await db.collection("users").get();
  const pairs = [];
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
    if (userDoc.id === excludeUid) return;
    const tokensSnap = await db.collection("users").doc(userDoc.id).collection("fcmTokens").get();
    tokensSnap.forEach((t) => {
      if (!t.data().revoked) pairs.push({ uid: userDoc.id, token: t.id });
    });
  }));
  return pairs;
}

/** Only the given student's own registered devices (used for "X commented on your post"). */
async function collectTokensFor(db, uid, excludeUid) {
  if (!uid || uid === excludeUid) return [];
  const tokensSnap = await db.collection("users").doc(uid).collection("fcmTokens").get();
  return tokensSnap.docs.filter((d) => !d.data().revoked).map((d) => ({ uid, token: d.id }));
}

/** Sends to every pair in chunks of 500 (FCM's multicast limit), pruning dead tokens as it goes. */
async function sendToTokens(messaging, db, pairs, notification, data = {}) {
  if (!pairs.length) return { sent: 0, pruned: 0 };
  let sent = 0;
  let pruned = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk.map((p) => p.token),
      notification,
      data,
      webpush: { fcmOptions: { link: data.url || "/" } }
    });
    sent += res.successCount;
    await Promise.all(res.responses.map((r, idx) => {
      if (r.success) return null;
      const code = r.error?.code || "";
      if (!code.includes("registration-token-not-registered") && !code.includes("invalid-argument")) return null;
      pruned++;
      const { uid, token } = chunk[idx];
      return db.collection("users").doc(uid).collection("fcmTokens").doc(token).delete().catch(() => null);
    }));
  }
  return { sent, pruned };
}

function truncate(text = "", max = 120) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** Builds the { title, body } shown in the notification, per activity type. */
function buildNotification(type, { text, actorName, urgent }) {
  switch (type) {
    case "post":
      return { title: `${actorName || "Someone"} posted on the Student Wall`, body: truncate(text) || "Tap to view." };
    case "resource":
      return { title: `${actorName || "Someone"} shared a note/sheet`, body: truncate(text) || "Tap to view." };
    case "notice":
      return { title: urgent ? "⚠️ Urgent Notice" : "New Notice", body: truncate(text) };
    case "comment":
      return { title: `${actorName || "Someone"} commented on your post`, body: truncate(text) };
    case "like":
      return { title: `${actorName || "Someone"} liked your post`, body: "Tap to view." };
    default:
      return { title: "GeoHub", body: truncate(text) };
  }
}

/** True if this Firestore Timestamp is recent enough to count as "just happened". */
function isRecent(timestamp) {
  if (!timestamp || typeof timestamp.toMillis !== "function") return false;
  return Date.now() - timestamp.toMillis() < MAX_CLAIM_AGE_MS;
}

/**
 * Confirms the payload actually describes something that just happened in
 * Firestore, and that the caller is the right person to be reporting it.
 * Throws a { status, message } on any mismatch — see the catch block in
 * the handler, which turns that into the HTTP response.
 */
async function verifyClaim(db, callerUid, callerEmail, payload) {
  const { type, targetUid, postId, resourceId, noticeId } = payload;

  if (type === "notice") {
    // Only the admin/CR may ever trigger a department-wide "notice" push —
    // this is the one type with no per-notice ownership check below it,
    // since postNotice() in routine.js can't run for a non-admin anyway
    // (blocked by firestore.rules), so there's nothing to verify per-id.
    if (!ADMIN_EMAILS.includes(callerEmail || "")) {
      throw { status: 403, message: "Only the class admin can send a notice push." };
    }
    if (noticeId) {
      const snap = await db.collection("notices").doc(noticeId).get();
      if (!snap.exists || !isRecent(snap.get("createdAt"))) {
        throw { status: 400, message: "That notice doesn't exist or isn't recent." };
      }
    }
    return;
  }

  if (type === "post") {
    if (!postId) throw { status: 400, message: "Missing postId." };
    const snap = await db.collection("posts").doc(postId).get();
    if (!snap.exists) throw { status: 400, message: "That post doesn't exist." };
    if (snap.get("authorUid") !== callerUid) throw { status: 403, message: "You didn't author that post." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That post isn't recent." };
    return;
  }

  if (type === "resource") {
    if (!resourceId) throw { status: 400, message: "Missing resourceId." };
    const snap = await db.collection("resources").doc(resourceId).get();
    if (!snap.exists) throw { status: 400, message: "That resource doesn't exist." };
    if (snap.get("contributorUid") !== callerUid) throw { status: 403, message: "You didn't share that resource." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That resource isn't recent." };
    return;
  }

  if (type === "like") {
    if (!postId) throw { status: 400, message: "Missing postId." };
    const snap = await db.collection("posts").doc(postId).get();
    if (!snap.exists) throw { status: 400, message: "That post doesn't exist." };
    const likes = snap.get("likes") || [];
    if (!likes.includes(callerUid)) throw { status: 403, message: "You haven't liked that post." };
    if (snap.get("authorUid") !== targetUid) throw { status: 400, message: "targetUid doesn't match the post's author." };
    return;
  }

  if (type === "comment") {
    if (!postId) throw { status: 400, message: "Missing postId." };
    const postSnap = await db.collection("posts").doc(postId).get();
    if (!postSnap.exists) throw { status: 400, message: "That post doesn't exist." };
    if (postSnap.get("authorUid") !== targetUid) throw { status: 400, message: "targetUid doesn't match the post's author." };
    // Find a recent comment on this post by the caller — good enough proof
    // without requiring the client to also thread the commentId through.
    // NOTE: this where()+orderBy() combo needs a composite Firestore index
    // on the comments subcollection (authorUid + createdAt) — Firestore's
    // error the first time will include a direct link to create it.
    const commentsSnap = await db.collection("posts").doc(postId).collection("comments")
      .where("authorUid", "==", callerUid).orderBy("createdAt", "desc").limit(1).get();
    if (commentsSnap.empty || !isRecent(commentsSnap.docs[0].get("createdAt"))) {
      throw { status: 400, message: "No recent comment by you found on that post." };
    }
    return;
  }

  throw { status: 400, message: `Unknown type '${type}'.` };
}

/** Rejects (silently, from the caller's point of view — this is best-effort push, not a user-facing action) if this uid pushed too recently. */
async function checkAndBumpRateLimit(db, uid) {
  const ref = db.collection("pushRateLimits").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? snap.get("lastSentAt") : null;
    if (last && typeof last.toMillis === "function" && Date.now() - last.toMillis() < MIN_MS_BETWEEN_PUSHES) {
      return false;
    }
    tx.set(ref, { lastSentAt: Timestamp.now() }, { merge: true });
    return true;
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ---- Only a signed-in student may trigger a send ----
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: "Missing Authorization bearer token." });

  try {
    const app = getAdminApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);
    const callerUid = decoded.uid;
    const callerEmail = decoded.email || "";

    const { type, text, actorName, urgent, targetUid, postId, resourceId, noticeId } = req.body || {};
    if (!type) return res.status(400).json({ error: "Missing 'type'." });

    const db = getFirestore(app);

    // ---- Prove the claim before sending anything (see verifyClaim above) ----
    try {
      await verifyClaim(db, callerUid, callerEmail, { type, targetUid, postId, resourceId, noticeId });
    } catch (claimErr) {
      const status = claimErr.status || 400;
      return res.status(status).json({ error: claimErr.message || "Couldn't verify this request." });
    }

    // ---- Simple per-user cooldown so even a legitimate flurry of actions can't spam pushes ----
    const allowed = await checkAndBumpRateLimit(db, callerUid);
    if (!allowed) return res.status(429).json({ ok: false, error: "Please wait a few seconds before triggering another notification." });

    const messaging = getMessaging(app);
    const notification = buildNotification(type, { text, actorName, urgent });

    // A new comment or like only notifies the post's author, not the whole department.
    const pairs = (type === "comment" || type === "like")
      ? await collectTokensFor(db, targetUid, callerUid)
      : await collectAllTokens(db, callerUid);

    const result = await sendToTokens(messaging, db, pairs, notification, { url: "/", type });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("send-push error:", err);
    return res.status(500).json({ error: err.message || "Failed to send push." });
  }
}
