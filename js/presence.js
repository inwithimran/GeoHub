// ============================================================
// PRESENCE.JS — "who's online" for GeoHub.
//
// This app only has Firestore (no Realtime Database), so there's no
// onDisconnect() hook to reliably fire the instant someone closes a
// tab, loses signal, or their browser just crashes. Instead this uses
// the same trick most Firestore-only presence systems lean on:
//
//   1. While a student has GeoHub open AND the tab is actually visible,
//      we "heartbeat" — stamp users/{uid}.lastActive with the server
//      time every HEARTBEAT_INTERVAL_MS.
//   2. Anyone viewing that student (Directory, Wall post, Post Detail,
//      a Profile page) treats them as "Online" as long as that stamp
//      is fresher than ONLINE_WINDOW_MS — a window comfortably wider
//      than one heartbeat, so a slow network or a throttled background
//      tab doesn't flicker someone's status.
//   3. Nobody ever has to write "online: false" on the way out — if
//      the tab dies without warning, the heartbeat just stops, and the
//      stamp silently ages past the window on every viewer's own
//      clock. Self-healing, no cleanup job needed.
//
// The tab-visibility piece (pausing the heartbeat when hidden) keeps
// this cheap: a student who opens GeoHub and leaves the tab in the
// background all day doesn't rack up silent writes for it, and
// correctly reads as "Active Xm ago" (not "Online") to classmates
// once their heartbeat goes stale. A short BACKGROUND_GRACE_MS delay
// before actually pausing means a quick app-switch (checking a
// notification, glancing at another app) doesn't instantly read as
// "went offline" to everyone else — same reasoning Facebook-style
// presence uses to stay a stable, non-flickery dot instead of
// bouncing on/off on every brief blip.
// ============================================================
import { db, auth } from "./firebase-config.js";
import { doc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { getCachedProfile, subscribeToProfileUpdates, timeAgo } from "./ui-utils.js";

const HEARTBEAT_INTERVAL_MS = 25_000;
// A generous multiple of the heartbeat (not just "a bit more") — a
// single delayed or dropped beat (a slow network round-trip, a
// throttled background tab, a Firestore write that lands a few
// seconds late) should never be enough to flip someone's dot off and
// back on again. Matches Facebook-style presence: once a dot goes
// green it stays a solid, stable green for up to ~4 minutes of no
// fresh heartbeat, instead of flickering on/off on every missed beat.
const ONLINE_WINDOW_MS = 240_000;
// Repaint every dot/label on screen periodically even without any new
// Firestore data landing — this is what actually flips someone from
// "Online" to "Active Xm ago" once their heartbeat goes stale, since
// nothing else would otherwise re-trigger that check.
const REPAINT_TICK_MS = 12_000;
// How long to keep heartbeating after the tab is backgrounded before
// actually pausing — absorbs brief app-switches/notification-checks
// without a visible status flicker for anyone watching.
const BACKGROUND_GRACE_MS = 45_000;

let heartbeatTimer = null;
let backgroundGraceTimer = null;

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function writeHeartbeat() {
  const user = auth.currentUser;
  if (!user) return;
  // Best-effort — a missed beat just means this student reads as "Active
  // a moment ago" a little longer than usual for everyone else; nothing
  // to surface to them over it.
  updateDoc(doc(db, "users", user.uid), { lastActive: serverTimestamp() }).catch(() => {});
}

function startHeartbeat() {
  stopHeartbeat();
  writeHeartbeat();
  heartbeatTimer = setInterval(writeHeartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/** Call once on login (alongside initWall()/initDirectory()/etc). */
export function initPresence() {
  startHeartbeat();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      // Back before the grace period fired — nothing ever actually
      // stopped, so there's nothing to restart, and no flicker.
      if (backgroundGraceTimer) { clearTimeout(backgroundGraceTimer); backgroundGraceTimer = null; }
      else startHeartbeat();
    } else {
      if (backgroundGraceTimer) clearTimeout(backgroundGraceTimer);
      backgroundGraceTimer = setTimeout(() => {
        backgroundGraceTimer = null;
        stopHeartbeat(); // sustained background stay — stop spending writes; see file header
      }, BACKGROUND_GRACE_MS);
    }
  });
  // Best-effort final stamp on the way out (tab close, refresh, app switch
  // on mobile) — not guaranteed to land, but costs nothing to try.
  window.addEventListener("pagehide", writeHeartbeat);
  // Repaint whenever the shared profile cache changes (Directory's listener
  // streams every classmate's doc in real time, so this is how a stale dot
  // usually flips fresh again well before the timer below ever needs to).
  subscribeToProfileUpdates(paintPresenceUI);
  setInterval(paintPresenceUI, REPAINT_TICK_MS);
}

/** Call once on logout, so a stale heartbeat doesn't keep firing for a signed-out session. */
export function teardownPresence() {
  if (backgroundGraceTimer) { clearTimeout(backgroundGraceTimer); backgroundGraceTimer = null; }
  stopHeartbeat();
}

/** Whether `profile` (as currently cached) counts as online right now. */
export function isUserOnline(profile) {
  const ms = toMillis(profile?.lastActive);
  return ms > 0 && (Date.now() - ms) < ONLINE_WINDOW_MS;
}

/** "Online" / "Active 5m ago" / "" (nothing on file yet — e.g. an older account that predates this feature). */
export function presenceLabel(profile) {
  if (!profile) return "";
  if (isUserOnline(profile)) return "Online";
  if (!profile.lastActive) return "";
  return `Active ${timeAgo(profile.lastActive)}`;
}

/** A small dot, styled green by CSS only once painted `.online` — drop right after a name. Needs a uid. */
export function presenceDotHtml(uid) {
  if (!uid) return "";
  return `<span class="presence-dot" data-presence-uid="${uid}" aria-hidden="true"></span>`;
}

/** An empty text node that paintPresenceUI() keeps filled with presenceLabel() for this uid — e.g. under a Profile page's name. */
export function presenceTextHtml(uid, className = "presence-text") {
  if (!uid) return "";
  return `<span class="${className}" data-presence-text-uid="${uid}"></span>`;
}

/**
 * A small badge meant to sit on the corner of an avatar (Messenger/WhatsApp
 * style) rather than floating after a name — wrap the avatar in
 * `.avatar-presence-wrap` and drop this right after it. Reuses the same
 * `data-presence-uid` hook as presenceDotHtml(), so paintPresenceUI() above
 * keeps it in sync automatically; only the CSS differs (see
 * .avatar-presence-badge). Used across Directory/Messages — deliberately
 * NOT used on Profile pages, which keep their existing presence display.
 */
export function avatarPresenceDotHtml(uid) {
  if (!uid) return "";
  return `<span class="avatar-presence-badge" data-presence-uid="${uid}" aria-hidden="true"></span>`;
}

/**
 * Re-derive every presence-dot/-text element currently on screen from
 * whatever's in the shared profile cache right now. Cheap (no network) —
 * safe to call often. Wired up automatically by initPresence() above; screens
 * don't need to call this themselves after rendering one of the html helpers.
 */
export function paintPresenceUI() {
  document.querySelectorAll("[data-presence-uid]").forEach((dot) => {
    const online = isUserOnline(getCachedProfile(dot.dataset.presenceUid));
    dot.classList.toggle("online", online);
    dot.title = online ? "Online" : "";
  });
  document.querySelectorAll("[data-presence-text-uid]").forEach((el) => {
    const profile = getCachedProfile(el.dataset.presenceTextUid);
    el.textContent = presenceLabel(profile);
    el.classList.toggle("online-now", isUserOnline(profile));
  });
}
