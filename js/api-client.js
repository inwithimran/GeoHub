import { auth } from "./firebase-config.js";

const CLIENT_COOLDOWN_MS = { "create-post": 3000, "create-comment": 1500 };
const lastCallAt = new Map();

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
  try { data = await res.json(); } catch {  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status}).`);
  return data;
}
