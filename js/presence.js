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
const ONLINE_WINDOW_MS = 240_000;
const REPAINT_TICK_MS = 12_000;
const BACKGROUND_GRACE_MS = 45_000;

let heartbeatTimer = null;
let backgroundGraceTimer = null;
let presenceObserver = null;
let paintScheduled = false;

function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.toDate === "function") return ts.toDate().getTime();
  return 0;
}

function writeHeartbeat() {
  const user = auth.currentUser;
  if (!user) return;
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

export function initPresence() {
  startHeartbeat();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      if (backgroundGraceTimer) { clearTimeout(backgroundGraceTimer); backgroundGraceTimer = null; }
      else startHeartbeat();
    } else {
      if (backgroundGraceTimer) clearTimeout(backgroundGraceTimer);
      backgroundGraceTimer = setTimeout(() => {
        backgroundGraceTimer = null;
        stopHeartbeat();
      }, BACKGROUND_GRACE_MS);
    }
  });
  window.addEventListener("pagehide", writeHeartbeat);
  subscribeToProfileUpdates(paintPresenceUI);
  setInterval(paintPresenceUI, REPAINT_TICK_MS);
  observeForFreshPresenceNodes();
}

export function teardownPresence() {
  if (backgroundGraceTimer) { clearTimeout(backgroundGraceTimer); backgroundGraceTimer = null; }
  stopHeartbeat();
  if (presenceObserver) { presenceObserver.disconnect(); presenceObserver = null; }
}

export function isUserOnline(profile) {
  const ms = toMillis(profile?.lastActive);
  return ms > 0 && (Date.now() - ms) < ONLINE_WINDOW_MS;
}

export function presenceLabel(profile) {
  if (!profile) return "";
  if (isUserOnline(profile)) return "Active Now";
  if (!profile.lastActive) return "";
  return `Active ${timeAgo(profile.lastActive)}`;
}

function shortTimeAgo(ts) {
  const ms = toMillis(ts);
  if (!ms) return "";
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 60) return "now";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return "";
}

export function presenceDotHtml(uid) {
  if (!uid) return "";
  return `<span class="presence-dot" data-presence-uid="${uid}" aria-hidden="true"></span>`;
}

export function presenceTextHtml(uid, className = "presence-text") {
  if (!uid) return "";
  return `<span class="${className}" data-presence-text-uid="${uid}"></span>`;
}

export function avatarPresenceDotHtml(uid, { label = false } = {}) {
  if (!uid) return "";
  const cls = label ? "avatar-presence-badge avatar-presence-badge-timed" : "avatar-presence-badge";
  return `<span class="${cls}" data-presence-uid="${uid}" aria-hidden="true"></span>`;
}

export function paintPresenceUI() {
  document.querySelectorAll("[data-presence-uid]").forEach((dot) => {
    const profile = getCachedProfile(dot.dataset.presenceUid);
    const online = isUserOnline(profile);
    dot.classList.toggle("online", online);
    const timed = dot.classList.contains("avatar-presence-badge-timed");
    if (!timed) {
      dot.title = online ? "Active Now" : "";
      return;
    }
    if (online) {
      dot.textContent = "";
      dot.classList.remove("has-label");
      dot.title = "Active Now";
      return;
    }
    const label = shortTimeAgo(profile?.lastActive);
    dot.textContent = label;
    dot.classList.toggle("has-label", !!label);
    dot.title = profile?.lastActive ? `Active ${timeAgo(profile.lastActive)}` : "";
  });
  document.querySelectorAll("[data-presence-text-uid]").forEach((el) => {
    const profile = getCachedProfile(el.dataset.presenceTextUid);
    el.textContent = presenceLabel(profile);
    el.classList.toggle("online-now", isUserOnline(profile));
  });
}

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(() => { paintScheduled = false; paintPresenceUI(); });
}

function observeForFreshPresenceNodes() {
  if (presenceObserver) return;
  presenceObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.addedNodes.length) { schedulePaint(); return; }
    }
  });
  presenceObserver.observe(document.body, { childList: true, subtree: true });
}
