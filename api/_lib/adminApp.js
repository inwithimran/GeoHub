import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Timestamp } from "firebase-admin/firestore";
import { ApiError } from "./errors.js";

export { ApiError };

export function getAdminApp() {
  if (getApps().length) return getApps()[0];
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
  }
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({ credential: cert(serviceAccount) });
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
