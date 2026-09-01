// ============================================================
// api/_lib/adminApp.js — shared helper for every Vercel API route
// that needs the Firebase Admin SDK.
//
// Vercel does not turn files under api/_lib/** into routes (any
// file/folder starting with "_" is skipped by its zero-config API
// detection), so this is safe to import from api/*.js without
// becoming its own accidental endpoint.
//
// Pulled out of api/resolve-profile.js and api/send-push.js, which
// each used to define their own copy of getAdminApp() — now every
// write-validation route (create-post, create-comment,
// update-profile, plus the two existing routes) shares one.
// ============================================================
import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";

export function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function verifyCaller(req) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) throw new ApiError(401, "Missing Authorization bearer token.");
  try {
    return await getAuth(getAdminApp()).verifyIdToken(idToken);
  } catch {
    throw new ApiError(401, "Your session has expired — please sign in again.");
  }
}

export function requirePost(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    throw new ApiError(405, "Method not allowed");
  }
}

// ============================================================
// RATE LIMITING — same Firestore-transaction cooldown pattern
// api/send-push.js already used for pushes (checkAndBumpRateLimit),
// generalized here with a `key` so each write-validation endpoint
// gets its own bucket per caller (a burst of comments shouldn't use
// up a student's post-creation allowance, and vice versa). The
// client-side cooldown in js/api-client.js (callApi) is a courtesy —
// it saves a wasted round trip and gives faster feedback — but this
// is the real guard, since a client-side check can always be
// bypassed by calling the endpoint directly.
// ============================================================
const DEFAULT_MIN_MS_BETWEEN_WRITES = 3000;

export async function enforceRateLimit(db, uid, key, minMs = DEFAULT_MIN_MS_BETWEEN_WRITES) {
  const ref = db.collection("apiRateLimits").doc(`${uid}_${key}`);
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const last = snap.exists ? snap.get("lastWriteAt") : null;
    if (last && typeof last.toMillis === "function" && Date.now() - last.toMillis() < minMs) {
      return false;
    }
    tx.set(ref, { lastWriteAt: Timestamp.now() }, { merge: true });
    return true;
  });
  if (!allowed) {
    throw new ApiError(429, "You're doing that too quickly — please wait a moment and try again.");
  }
}

export function sendError(res, err) {
  const status = err instanceof ApiError ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
}
