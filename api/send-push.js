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
// Needs one environment variable set in the Vercel project:
//   FIREBASE_SERVICE_ACCOUNT — the full JSON key of a Firebase
//   service account (see the setup guide for how to get this).
// ============================================================
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getAuth } from "firebase-admin/auth";

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
    default:
      return { title: "GeoHub", body: truncate(text) };
  }
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

    const { type, text, actorName, urgent, targetUid } = req.body || {};
    if (!type) return res.status(400).json({ error: "Missing 'type'." });

    const db = getFirestore(app);
    const messaging = getMessaging(app);
    const notification = buildNotification(type, { text, actorName, urgent });

    // A new comment only notifies the post's author, not the whole department.
    const pairs = type === "comment"
      ? await collectTokensFor(db, targetUid, callerUid)
      : await collectAllTokens(db, callerUid);

    const result = await sendToTokens(messaging, db, pairs, notification, { url: "/", type });
    return res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error("send-push error:", err);
    return res.status(500).json({ error: err.message || "Failed to send push." });
  }
}
