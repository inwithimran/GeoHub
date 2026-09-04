import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";
import { getAdminApp, verifyCaller, requirePost, sendError, ApiError, enforceRateLimit } from "../_lib/adminApp.js";
import { requiredText } from "../_lib/validators.js";

const MESSAGE_TEXT_LIMIT = 2000;
const MIN_MS_BETWEEN_MESSAGES = 1500;

function conversationIdFor(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

function truncate(text = "", max = 120) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

async function notifyRecipient(db, uid, otherUid, { conversationId, messageId, text, senderName }) {
  const tokensSnap = await db.collection("users").doc(otherUid).collection("fcmTokens").get();
  const pairs = tokensSnap.docs.filter((d) => !d.data().revoked).map((d) => ({ uid: otherUid, token: d.id }));
  if (!pairs.length) return;

  const messaging = getMessaging(getAdminApp());
  const data = {
    type: "dm",
    title: `${senderName || "Someone"} sent you a message`,
    body: truncate(text) || "Tap to view.",
    url: `/#dm-thread?id=${uid}`,
    conversationId: String(conversationId),
    messageId: String(messageId),
    senderUid: uid,
    senderName: senderName || ""
  };

  for (let i = 0; i < pairs.length; i += 500) {
    const chunk = pairs.slice(i, i + 500);
    const res = await messaging.sendEachForMulticast({
      tokens: chunk.map((p) => p.token),
      data,
      android: { priority: "high" },
      webpush: { fcmOptions: { link: data.url } }
    });
    await Promise.all(res.responses.map((r, idx) => {
      if (r.success) return null;
      const code = r.error?.code || "";
      if (!code.includes("registration-token-not-registered") && !code.includes("invalid-argument")) return null;
      const { token } = chunk[idx];
      return db.collection("users").doc(otherUid).collection("fcmTokens").doc(token).delete().catch(() => null);
    }));
  }
}

export async function sendDmMessage(req, res) {
  try {
    requirePost(req, res);
    const decoded = await verifyCaller(req);
    const uid = decoded.uid;

    const db = getFirestore(getAdminApp());
    await enforceRateLimit(db, uid, "send-dm-message", MIN_MS_BETWEEN_MESSAGES);

    const body = req.body || {};
    const otherUid = typeof body.targetUid === "string" ? body.targetUid : "";
    if (!otherUid) throw new ApiError(400, "Missing targetUid.");
    if (otherUid === uid) throw new ApiError(400, "You can't message yourself.");

    const text = requiredText(body.text, "Message", MESSAGE_TEXT_LIMIT);

    const [meSnap, otherSnap] = await Promise.all([
      db.collection("users").doc(uid).get(),
      db.collection("users").doc(otherUid).get()
    ]);
    if (!meSnap.exists) throw new ApiError(409, "Your profile isn't set up yet — please finish onboarding first.");
    if (!otherSnap.exists) throw new ApiError(404, "That user no longer exists.");

    const conversationId = conversationIdFor(uid, otherUid);
    const convRef = db.collection("conversations").doc(conversationId);
    const convSnap = await convRef.get();
    const blockedBy = convSnap.exists ? (convSnap.get("blockedBy") || []) : [];
    if (blockedBy.includes(uid) || blockedBy.includes(otherUid)) {
      throw new ApiError(403, "You can't message this person right now.");
    }

    if (!convSnap.exists) {
      await convRef.set({
        participants: [uid, otherUid],
        createdAt: FieldValue.serverTimestamp(),
        blockedBy: [],
        deletedFor: {},
        unread: { [uid]: 0, [otherUid]: 0 }
      }, { merge: true });
    } else if (convSnap.get(`deletedFor.${uid}`) || convSnap.get(`deletedFor.${otherUid}`)) {
      await convRef.update({ [`deletedFor.${uid}`]: FieldValue.delete(), [`deletedFor.${otherUid}`]: FieldValue.delete() });
    }

    const msgRef = await convRef.collection("messages").add({
      senderUid: uid,
      text,
      createdAt: FieldValue.serverTimestamp()
    });

    await convRef.update({
      lastMessageText: text.length > 140 ? text.slice(0, 140) + "…" : text,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastSenderUid: uid,
      [`unread.${otherUid}`]: FieldValue.increment(1)
    });

    const senderName = meSnap.get("name") || "";
    await notifyRecipient(db, uid, otherUid, { conversationId, messageId: msgRef.id, text, senderName }).catch(() => null);

    return res.status(200).json({ messageId: msgRef.id, conversationId, senderName });
  } catch (err) {
    return sendError(res, err);
  }
}
