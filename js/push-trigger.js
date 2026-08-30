// ============================================================
// PUSH-TRIGGER.JS — client-side call to the Vercel API route
// (api/send-push.js) that actually sends the push notification.
// Called right after a write to Firestore succeeds (new post, new
// resource, new notice, new comment) — see wall.js, resources.js,
// routine.js. Always best-effort: a failure here never blocks or
// surfaces an error for the action that triggered it, since the
// underlying post/notice/etc. was already saved successfully.
// ============================================================
import { auth } from "./firebase-config.js";

/**
 * @param {{type:"post"|"resource"|"notice"|"comment"|"like"|"mention"|"report", text?:string, actorName?:string, urgent?:boolean, targetUid?:string, postId?:string, reportId?:string}} payload
 *   targetUid is required for types "comment", "like" and "mention" (who should be notified).
 *   reportId is required for type "report" (goes to the admin(s) only, never the whole department).
 */
export async function triggerPush(payload) {
  try {
    if (!auth.currentUser) return;
    const idToken = await auth.currentUser.getIdToken();
    await fetch("/api/send-push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn("Couldn't trigger push notification:", err.message);
  }
}
