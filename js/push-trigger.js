import { auth } from "./firebase-config.js";
import { API_BASE } from "./api-client.js";
export async function triggerPush(payload) {
  try {
    if (!auth.currentUser) return;
    const idToken = await auth.currentUser.getIdToken();
    await fetch(`${API_BASE}/api/send-push`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("Couldn't trigger push notification:", err.message);
  }
}
