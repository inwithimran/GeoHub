import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getMessaging } from "firebase-admin/messaging";

const REMINDER_WINDOW_START_MS = 20 * 60 * 60 * 1000; 
const REMINDER_WINDOW_END_MS = 32 * 60 * 60 * 1000;

function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

async function collectAllTokens(db) {
  const usersSnap = await db.collection("users").get();
  const pairs = [];
  await Promise.all(usersSnap.docs.map(async (userDoc) => {
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

export async function deadlineReminders(req, res) {
  if (!process.env.CRON_SECRET) {
    console.error("deadline-reminders: CRON_SECRET is not set — refusing request.");
    return res.status(500).json({ error: "Server misconfiguration." });
  }
  const authHeader = req.headers.authorization || "";
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const app = getAdminApp();
    const db = getFirestore(app);
    const messaging = getMessaging(app);

    const now = Date.now();
    const windowStart = Timestamp.fromMillis(now + REMINDER_WINDOW_START_MS);
    const windowEnd = Timestamp.fromMillis(now + REMINDER_WINDOW_END_MS);

    const snap = await db.collection("deadlines")
      .where("dueAt", ">=", windowStart)
      .where("dueAt", "<=", windowEnd)
      .get();

    const due = snap.docs.filter((d) => !d.get("remindedAt"));
    if (!due.length) return res.status(200).json({ ok: true, reminded: 0 });

    const pairs = await collectAllTokens(db);
    let reminded = 0;
    for (const d of due) {
      const data = d.data();
      const { title, body } = { title: "⏰ Deadline Tomorrow", body: truncate(data.title || "") || "Tap to view the details." };
      await sendToTokens(messaging, db, pairs, {
        url: "/", type: "deadline-reminder", title, body
      });
      await d.ref.update({ remindedAt: Timestamp.now() });
      reminded++;
    }

    return res.status(200).json({ ok: true, reminded });
  } catch (err) {
    console.error("deadline-reminders error:", err);
    return res.status(500).json({ error: err.message || "Failed to send deadline reminders." });
  }
}
