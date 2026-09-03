import { auth } from "./firebase-config.js";
import { API_BASE } from "./api-client.js";

const RETRY_DELAYS_MS = [2000, 5000, 10000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendOnce(payload) {
  const idToken = await auth.currentUser.getIdToken();
  return fetch(`${API_BASE}/api/send-push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
    body: JSON.stringify(payload)
  });
}

export async function triggerPush(payload) {
  if (!auth.currentUser) return;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await sendOnce(payload);
      if (res.ok || (res.status !== 429 && res.status < 500)) return;
    } catch (err) {
      console.warn("Couldn't trigger push notification:", err.message);
    }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
}
