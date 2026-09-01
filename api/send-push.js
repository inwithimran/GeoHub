import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getAuth } from "firebase-admin/auth";

const ADMIN_EMAILS = ["in.with.imran@gmail.com"];
const MIN_MS_BETWEEN_PUSHES = 5000; 
const MAX_CLAIM_AGE_MS = 2 * 60 * 1000;

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

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

async function collectTokensFor(db, uid, excludeUid) {
  if (!uid || uid === excludeUid) return [];
  const tokensSnap = await db.collection("users").doc(uid).collection("fcmTokens").get();
  return tokensSnap.docs.filter((d) => !d.data().revoked).map((d) => ({ uid, token: d.id }));
}

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

async function sendToTokens(messaging, db, pairs, data = {}) {
  if (!pairs.length) return { sent: 0, pruned: 0 };
  let sent = 0;
  let pruned = 0;
  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk.map((p) => p.token),
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
    case "reply":
      return { title: `${name} replied to your comment`, body: truncate(text) };
    case "like":
      return { title: `${name} reacted to your post`, body: "Tap to view." };
    case "comment-like":
      return { title: `${name} reacted to your comment`, body: truncate(text) || "Tap to view." };
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

function isRecent(timestamp) {
  if (!timestamp || typeof timestamp.toMillis !== "function") return false;
  return Date.now() - timestamp.toMillis() < MAX_CLAIM_AGE_MS;
}

async function verifyClaim(db, callerUid, callerEmail, payload) {
  const { type, targetUid, postId, commentId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId } = payload;

  if (type === "deadline") {
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

  if (type === "comment-like") {
    if (!postId || !commentId) throw { status: 400, message: "Missing postId or commentId." };
    const commentSnap = await db.collection("posts").doc(postId).collection("comments").doc(commentId).get();
    if (!commentSnap.exists) throw { status: 400, message: "That comment doesn't exist." };
    const commentReactions = commentSnap.get("reactions") || {};
    if (commentReactions[callerUid] == null) throw { status: 403, message: "You haven't reacted to that comment." };
    if (commentSnap.get("authorUid") !== targetUid) throw { status: 400, message: "targetUid doesn't match the comment's author." };
    return;
  }

  if (type === "reply") {
    if (!postId) throw { status: 400, message: "Missing postId." };
    if (!targetUid) throw { status: 400, message: "Missing targetUid." };
    const commentsSnap = await db.collection("posts").doc(postId).collection("comments")
      .where("authorUid", "==", callerUid).limit(20).get();
    const hasRecentReply = commentsSnap.docs.some((d) =>
      isRecent(d.get("createdAt")) && d.get("replyTo") && d.get("replyTo").authorUid === targetUid);
    if (!hasRecentReply) throw { status: 400, message: "No recent reply by you to that person found." };
    return;
  }

  if (type === "comment") {
    if (!postId) throw { status: 400, message: "Missing postId." };
    const postSnap = await db.collection("posts").doc(postId).get();
    if (!postSnap.exists) throw { status: 400, message: "That post doesn't exist." };
    if (postSnap.get("authorUid") !== targetUid) throw { status: 400, message: "targetUid doesn't match the post's author." };
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

    const postMentions = postSnap.get("mentions") || [];
    const isPostMention = postSnap.get("authorUid") === callerUid &&
      isRecent(postSnap.get("createdAt")) &&
      postMentions.some((m) => m && m.uid === targetUid);
    if (isPostMention) return;

    const commentsSnap = await db.collection("posts").doc(postId).collection("comments")
      .where("authorUid", "==", callerUid).limit(20).get();
    const isCommentMention = commentsSnap.docs.some((d) =>
      isRecent(d.get("createdAt")) && (d.get("mentions") || []).some((m) => m && m.uid === targetUid));
    if (!isCommentMention) throw { status: 400, message: "No recent mention of that person found." };
    return;
  }

  if (type === "report") {
    if (!reportId) throw { status: 400, message: "Missing reportId." };
    const snap = await db.collection("reports").doc(reportId).get();
    if (!snap.exists) throw { status: 400, message: "That report doesn't exist." };
    if (snap.get("reportedByUid") !== callerUid) throw { status: 403, message: "You didn't file that report." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That report isn't recent." };
    return;
  }

  if (type === "classChat") {
    if (!messageId) throw { status: 400, message: "Missing messageId." };
    const snap = await db.collection("classChat").doc(messageId).get();
    if (!snap.exists) throw { status: 400, message: "That message doesn't exist." };
    if (snap.get("authorUid") !== callerUid) throw { status: 403, message: "You didn't send that message." };
    if (!isRecent(snap.get("createdAt"))) throw { status: 400, message: "That message isn't recent." };
    return;
  }

  if (type === "dm") {
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

  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: "Missing Authorization bearer token." });

  try {
    const app = getAdminApp();
    const decoded = await getAuth(app).verifyIdToken(idToken);
    const callerUid = decoded.uid;
    const callerEmail = decoded.email || "";

    const { type, text, actorName, urgent, targetUid, postId, commentId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId } = req.body || {};
    if (!type) return res.status(400).json({ error: "Missing 'type'." });

    const db = getFirestore(app);

    try {
      await verifyClaim(db, callerUid, callerEmail, { type, targetUid, postId, commentId, resourceId, noticeId, reportId, deadlineId, conversationId, messageId });
    } catch (claimErr) {
      const status = claimErr.status || 400;
      return res.status(status).json({ error: claimErr.message || "Couldn't verify this request." });
    }

    const allowed = await checkAndBumpRateLimit(db, callerUid);
    if (!allowed) return res.status(429).json({ ok: false, error: "Please wait a few seconds before triggering another notification." });

    const messaging = getMessaging(app);
    const { title, body } = buildNotification(type, { text, actorName, urgent });

    const pairs = (type === "comment" || type === "reply" || type === "like" || type === "comment-like" || type === "mention" || type === "dm")
      ? await collectTokensFor(db, targetUid, callerUid)
      : type === "report"
        ? await collectAdminTokens(db, callerUid)
        : await collectAllTokens(db, callerUid);

    const result = await sendToTokens(messaging, db, pairs, { url: "/", type: String(type), title, body });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("send-push error:", err);
    return res.status(500).json({ error: err.message || "Failed to send push." });
  }
}
