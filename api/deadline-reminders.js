// ============================================================
// api/deadline-reminders.js — Vercel Cron job.
//
// Runs once a day (see the "crons" entry in vercel.json) and sends a
// push notification for every deadline (js/deadlines.js) whose due
// date falls within the next ~24-25 hours and hasn't already been
// reminded about. This is a SEPARATE code path from api/send-push.js
// on purpose: every push in send-push.js is triggered by a signed-in
// student's browser right after an action they just took, but a "due
// tomorrow" reminder has to fire on a schedule even while nobody has
// GeoHub open at all — nothing client-side can do that, so it needs
// its own server-triggered entry point instead of a client call.
//
// SETUP (see VERCEL_SETUP.md for the full walkthrough):
//   1. Needs the same FIREBASE_SERVICE_ACCOUNT env var as send-push.js
//      (already required for that route, so nothing new to add there).
//   2. Optionally set a CRON_SECRET env var in the Vercel project. If
//      set, Vercel automatically sends it back as
//      "Authorization: Bearer <CRON_SECRET>" on every cron invocation
//      (https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs),
//      and this route checks it below — that's what stops a stranger
//      from hitting this URL directly to spam a reminder push early.
//      If you don't set it, the route still works (a small department
//      app doesn't strictly need this), it's just unauthenticated.
//   3. The schedule itself lives in vercel.json's "crons" array — edit
//      the cron expression there to change what time of day this runs.
//      Vercel Cron schedules are always in UTC.
// ============================================================
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

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized." });
    }
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
