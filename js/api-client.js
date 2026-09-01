// ============================================================
// API-CLIENT.JS — shared helper for calling GeoHub's own
// write-validation Vercel API routes (create-post, create-comment,
// update-profile). Same Authorization-header pattern js/push-trigger.js
// already uses for api/send-push.js, factored out so every caller
// doesn't re-implement the token fetch + fetch() + error unwrap.
// ============================================================
import { auth } from "./firebase-config.js";

// ------------------------------------------------------------
// CLIENT-SIDE RATE LIMIT — a courtesy, not the real guard (that's
// enforceRateLimit() in api/_lib/adminApp.js, which every create-*
// route calls server-side — a client-side check can always be
// bypassed by calling the endpoint directly). This just rejects an
// obviously-too-fast repeat call immediately, locally, instead of
// spending a round trip only to have the server say the same thing.
// Keyed by `path` so create-post and create-comment each get their
// own cooldown, matching the server's per-endpoint buckets.
// ------------------------------------------------------------
const CLIENT_COOLDOWN_MS = { "create-post": 3000, "create-comment": 1500 };
const lastCallAt = new Map();

/**
 * POSTs `payload` as JSON to /api/<path> with the current user's Firebase
 * ID token attached. Throws a plain Error with the API's own message on
 * a non-2xx response (or a generic one if the API didn't return JSON),
 * so callers can show it directly the same way they show any other
 * Firestore-write error.
 *
 * `skipClientCooldown` is for js/write-queue.js's replay of a post that
 * was queued while offline — that call is already being retried on its
 * own schedule (see write-queue.js), so re-applying the interactive
 * cooldown on top would just make a queued post wait longer than it
 * needs to for no benefit (the server-side limit still applies either way).
 */
export async function callApi(path, payload, { skipClientCooldown = false } = {}) {
  const cooldownMs = CLIENT_COOLDOWN_MS[path];
  if (cooldownMs && !skipClientCooldown) {
    const waitMs = cooldownMs - (Date.now() - (lastCallAt.get(path) || 0));
    if (waitMs > 0) {
      throw new Error(`You're doing that too fast — please wait ${Math.ceil(waitMs / 1000)}s and try again.`);
    }
    lastCallAt.set(path, Date.now());
  }
  if (!auth.currentUser) throw new Error("You're not signed in.");
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(payload)
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error page, fall through */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}
