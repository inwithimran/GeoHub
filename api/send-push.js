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
// resource/notice/comment/report/DM/Class Chat message to Firestore (see
// wall.js, resources.js, routine.js, messages.js), it calls this endpoint
// with a Firebase ID token +
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

/** Every admin's registered devices (used for "new report" — never the whole department). */
async function collectAdminTokens(db, excludeUid) {
  if (!ADMIN_EMAILS.length) return [];
  const adminsSnap = await db.collection("users").where("email", "in", ADMIN_EMAILS).get();
  const pairs = [];
  await Promise.all(adminsSnap.docs.map(async (userDoc) => {
    if (userDoc.id === excludeUid) return;
    const tokensSnap = await db.collection("users").doc(userDoc.id).collection("fcmTokens").get();
    tokensSnap.forEach((t) => {
      if (!t.data().revoked) pairs.push({ uid: userDoc.id, token: t.id });
    });
  }));
  return pairs;
}

/** Sends to every pair in chunks of 500 (FCM's multicast limit), pruning dead tokens as it goes. */
async function sendToTokens(messaging, db, pairs, data = {}) {
  if (!pairs.length) return { sent: 0, pruned: 0 };
  let sent = 0;
  let pruned = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk.map((p) => p.token),
      // Data-only message — deliberately no top-level `notification` field.
      // When a push includes a `notification` payload, the browser/OS shows
      // it automatically in the background AND the service worker's
      // onBackgroundMessage handler fires and calls showNotification() itself
      // — two notifications for one push. Sending data-only means nothing is
      // shown automatically, so the service worker's single explicit call
      // (see firebase-messaging-sw.js) is the only one that ever displays.
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
  const name = actorName || "Someone";
  switch (type) {
    case "post":
      return { title: `${name} shared a new post on the Student Wall`, body: truncate(text) || "Tap to view the post." };
    case "resource":
      return { title: `${name} shared a new resource in Notes & Sheets`, body: truncate(text) || "Tap to view." };
    case "notice":
      return { title: urgent ? "⚠️ Urgent Notice" : "📢 New Notice", body: truncate(text) };
    case "deadline":
      return { title: "🗓️ New Deadline Posted", body: truncate(text) || "Tap to view the details." };
    case "routine":
      return { title: "🗓️ Weekly Routine Updated", body: truncate(text) || "Tap to view the updated class routine." };
    case "deadline-reminder":
      return { title: "⏰ Deadline Tomorrow", body: truncate(text) || "Tap to view the details." };
    case "comment":
      return { title: `${name} commented on your post`, body: truncate(text) };
    case "like":
      return { title: `${name} reacted to your post`, body: "Tap to view." };
    case "mention":
      return { title: `${name} mentioned you`, body: truncate(text) || "Tap to view." };
    case "report":
      return { title: `New content report from ${name}`, body: truncate(text) || "Tap to review it." };
    case "dm":
      return { title: `${name} sent you a message`, body: truncate(text) || "Tap to view." };
    case "classChat":
      return { title: `${name} posted in Department Chat`, body: truncate(text) || "Tap to view." };
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
  const { type, targetUid, postId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId } = payload;

  if (type === "deadline") {
    // Same trust model as "notice": only the CR/admin may trigger this
    // push (postDeadline() in deadlines.js can't succeed for anyone else
    // anyway — see firestore.rules — so there's nothing else to verify
    // per-id beyond "does this deadline exist and was it just created").
    if (!ADMIN_EMAILS.includes(callerEmail || "")) {
      throw { status: 403, message: "Only the class admin can send a deadline push." };
    }
    if (deadlineId) {
      const snap = await db.collection("deadlines").doc(deadlineId).get();
      if (!snap.exists || !isRecent(snap.get("createdAt"))) {
        throw { status: 400, message: "That deadline doesn't exist or isn't recent." };
      }
    }
    return;
  }

  if (type === "routine") {
    // Same trust model as "notice"/"deadline": only the CR/admin may ever
    // trigger this push (saveRoutine() in routine.js can't succeed for
    // anyone else anyway — see firestore.rules). The routine lives at a
    // single fixed doc (routine/weekly) rather than one-per-edit, so
    // recency is checked against its `updatedAt` field (stamped on every
    // save) instead of a fresh document id.
    if (!ADMIN_EMAILS.includes(callerEmail || "")) {
      throw { status: 403, message: "Only the class admin can send a routine push." };
    }
    const snap = await db.collection("routine").doc("weekly").get();
    if (!snap.exists || !isRecent(snap.get("updatedAt"))) {
      throw { status: 400, message: "The routine doesn't exist or wasn't just updated." };
    }
    return;
  }

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
    // A where()+orderBy() combo on different fields needs a composite
    // Firestore index; until that index is manually created in the console
    // this call throws "failed-precondition" and every "commented on your
    // post" push silently fails (triggerPush() swallows the error client-
    // side). Dropping orderBy avoids that entirely — a single-field
    // equality filter needs no composite index, and scanning a handful of
    // the caller's own comments on one post for a recent one is plenty.
    const commentsSnap = await db.collection("posts").doc(postId).collection("comments")
      .where("authorUid", "==", callerUid).limit(20).get();
    const hasRecentComment = commentsSnap.docs.some((d) => isRecent(d.get("createdAt")));
    if (!hasRecentComment) {
      throw { status: 400, message: "No recent comment by you found on that post." };
    }
    return;
  }

  if (type === "mention") {
    if (!postId || !targetUid) throw { status: 400, message: "Missing postId or targetUid." };
    const postSnap = await db.collection("posts").doc(postId).get();
    if (!postSnap.exists) throw { status: 400, message: "That post doesn't exist." };

    // The mention can be in the post itself...
    const postMentions = postSnap.get("mentions") || [];
    const isPostMention = postSnap.get("authorUid") === callerUid &&
      isRecent(postSnap.get("createdAt")) &&
      postMentions.some((m) => m && m.uid === targetUid);
    if (isPostMention) return;

    // ...or in a recent comment by the caller on that post. Same
    // no-orderBy, scan-a-few-recent-ones approach as the "comment" case
    // above, for the same composite-index reason.
    const commentsSnap = await db.collection("posts").doc(postId).collection("comments")
      .where("authorUid", "==", callerUid).limit(20).get();
    const isCommentMention = commentsSnap.docs.some((d) =>
      isRecent(d.get("createdAt")) && (d.get("mentions") || []).some((m) => m && m.uid === targetUid));
    if (!isCommentMention) throw { status: 400, message: "No recent mention of that person found." };
    return;
  }

  if (type === "report") {
    // Only the admin(s) ever get this push, so the claim just has to prove
    // the caller really filed the report they're claiming to have — same
    // "reporting something that just happened" shape as every other type.
    if (!reportId) throw { status: 400, message: "Missing reportId." };
    const snap = await db.collection("reports").doc(reportId).get();
    if (!snap.exists) throw { status: 400, message: "That report doesn't exist." };
    if (snap.get("reportedByUid") !== callerUid) throw { status: 403, message: "You didn't file that report." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That report isn't recent." };
    return;
  }

  if (type === "classChat") {
    // Same "reporting something that just happened" shape as "post" — one
    // shared room, so the check is just "did the caller really just post
    // this message" (broadcasts to everyone else, same as "post").
    if (!messageId) throw { status: 400, message: "Missing messageId." };
    const snap = await db.collection("classChat").doc(messageId).get();
    if (!snap.exists) throw { status: 400, message: "That message doesn't exist." };
    if (snap.get("authorUid") !== callerUid) throw { status: 403, message: "You didn't send that message." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That message isn't recent." };
    return;
  }

  if (type === "dm") {
    // A DM push only ever goes to the other participant, never the whole
    // department — so this has to confirm both that the caller is really
    // in that conversation AND that targetUid is the other person on it,
    // on top of the usual "did this message really just get sent" check.
    if (!conversationId || !messageId || !targetUid) {
      throw { status: 400, message: "Missing conversationId, messageId or targetUid." };
    }
    const convSnap = await db.collection("conversations").doc(conversationId).get();
    if (!convSnap.exists) throw { status: 400, message: "That conversation doesn't exist." };
    const participants = convSnap.get("participants") || [];
    if (!participants.includes(callerUid)) throw { status: 403, message: "You're not part of that conversation." };
    if (targetUid === callerUid || !participants.includes(targetUid)) {
      throw { status: 400, message: "targetUid isn't the other participant in that conversation." };
    }
    const msgSnap = await db.collection("conversations").doc(conversationId).collection("messages").doc(messageId).get();
    if (!msgSnap.exists) throw { status: 400, message: "That message doesn't exist." };
    if (msgSnap.get("senderUid") !== callerUid) throw { status: 403, message: "You didn't send that message." };
    if (!isRecent(msgSnap.get("createdAt"))) throw { status: 400, message: "That message isn't recent." };
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

    const { type, text, actorName, urgent, targetUid, postId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId } = req.body || {};
    if (!type) return res.status(400).json({ error: "Missing 'type'." });

    const db = getFirestore(app);

    // ---- Prove the claim before sending anything (see verifyClaim above) ----
    try {
      await verifyClaim(db, callerUid, callerEmail, { type, targetUid, postId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId });
    } catch (claimErr) {
      const status = claimErr.status || 400;
      return res.status(status).json({ error: claimErr.message || "Couldn't verify this request." });
    }

    // ---- Simple per-user cooldown so even a legitimate flurry of actions can't spam pushes ----
    const allowed = await checkAndBumpRateLimit(db, callerUid);
    if (!allowed) return res.status(429).json({ ok: false, error: "Please wait a few seconds before triggering another notification." });

    const messaging = getMessaging(app);
    const { title, body } = buildNotification(type, { text, actorName, urgent });

    // A new comment, like, mention, or DM only notifies one specific
    // student (the post's author, whoever got @mentioned, or the other
    // side of the conversation); a new report only notifies the admin(s);
    // everything else — including a new Class Chat message — broadcasts
    // to the whole department.
    const pairs = (type === "comment" || type === "like" || type === "mention" || type === "dm")
      ? await collectTokensFor(db, targetUid, callerUid)
      : type === "report"
        ? await collectAdminTokens(db, callerUid)
        : await collectAllTokens(db, callerUid);

    // FCM data payloads only allow string values, hence the explicit casts.
    const result = await sendToTokens(messaging, db, pairs, { url: "/", type: String(type), title, body });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("send-push error:", err);
    return res.status(500).json({ error: err.message || "Failed to send push." });
  }
}
