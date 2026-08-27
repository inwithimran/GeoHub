// ============================================================
// UI-UTILS.JS — small shared helpers (toast, modal, formatting)
// used by wall.js / resources.js / directory.js / routine.js
// ============================================================
import { ADMIN_EMAILS } from "./firebase-config.js";

const toastEl = document.getElementById("toast");
let toastTimer = null;

/** Show a brief bottom toast message (auto-hides after 2.5s). */
export function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 2500);
}

const modalOverlay = document.getElementById("modal-overlay");
const modalBody = document.getElementById("modal-body");

/** Open the shared bottom-sheet modal with the given inner HTML. */
export function openModal(html) {
  modalBody.innerHTML = html;
  modalOverlay.classList.remove("hidden");
}
export function closeModal() {
  modalOverlay.classList.add("hidden");
  modalBody.innerHTML = "";
}
// Tapping the dark backdrop closes the sheet
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

/** Escape user-entered text before injecting into innerHTML (XSS guard). */
export function escapeHtml(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/** Two-letter initials — kept for legacy callers, no longer used for avatars. */
export function initialsOf(name = "?") {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
}

// ============================================================
// AVATARS — every avatar in the app is a gender-based silhouette
// icon (never initials/letters) on a color that's unique per
// student, so classmates are visually distinguishable at a glance
// across the Wall, comments, Directory and Profile screens.
// ============================================================

/** A stable, good-looking palette — colors picked to all read well with a white icon on top. */
const AVATAR_PALETTE = [
  "#e11d48", "#db2777", "#c026d3", "#9333ea", "#7c3aed",
  "#4f46e5", "#2563eb", "#0ea5e9", "#0891b2", "#0d9488",
  "#059669", "#65a30d", "#ca8a04", "#d97706", "#ea580c", "#dc2626"
];

/** Deterministic hash so the same student always gets the same avatar color. */
function hashSeed(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) { h = (h * 31 + seed.charCodeAt(i)) >>> 0; }
  return h;
}

/** Pick a stable background color for a given uid/name/email seed. */
export function avatarColorFor(seed) {
  if (!seed) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[hashSeed(String(seed)) % AVATAR_PALETTE.length];
}

/**
 * Gender-silhouette icon markup (never initials). Built from a couple of
 * simple, high-contrast layered shapes rather than fussy hand-drawn detail —
 * that's what keeps it reading clearly at avatar sizes as small as 24px.
 * Falls back to a neutral bust for unset/other.
 */
function genderIconSvg(gender) {
  // Shoulders/body — shared by every variant.
  const body = `<path d="M12 14.5c-4.53 0-10.05 2.07-10.05 6.25V22h20.1v-1.25c0-4.18-5.52-6.25-10.05-6.25Z" fill="rgba(255,255,255,0.97)"/>`;

  if (gender === "male") {
    // Short, tapered hairline: a slightly larger dim circle behind a smaller
    // bright face circle, so only a subtle rim of "hair" peeks out at the top.
    return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <circle cx="12" cy="7.65" r="4.55" fill="rgba(255,255,255,0.5)"/>
      <circle cx="12" cy="8.3" r="4" fill="rgba(255,255,255,0.97)"/>
      ${body}
    </svg>`;
  }

  if (gender === "female") {
    // Long hair silhouette: one soft, rounded mass behind a smaller, dimmer
    // face circle (peeking out), plus two flowing strands over the shoulders.
    return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path d="M17.55 13.75c1.75.98 2.9 2.6 3.15 4.55.25-1.55.06-2.98-.55-4.15-.75.02-1.6-.13-2.6-.4Z" fill="rgba(255,255,255,0.97)"/>
      <path d="M6.45 13.75c-1.75.98-2.9 2.6-3.15 4.55-.25-1.55-.06-2.98.55-4.15.75.02 1.6-.13 2.6-.4Z" fill="rgba(255,255,255,0.97)"/>
      <circle cx="12" cy="8.35" r="5.6" fill="rgba(255,255,255,0.97)"/>
      <circle cx="12" cy="9.05" r="3.7" fill="rgba(255,255,255,0.72)"/>
      ${body}
    </svg>`;
  }

  // "others" / not set — neutral bust with a small identity mark, no hairstyle.
  return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
    <circle cx="12" cy="7.65" r="4.4" fill="rgba(255,255,255,0.97)"/>
    <circle cx="12" cy="4.55" r="1.15" fill="rgba(255,255,255,0.55)"/>
    ${body}
  </svg>`;
}

/**
 * Build a full avatar element's inner markup (icon on a colored circle).
 * Pass whatever profile-ish object you have — {uid, name, gender, email}.
 * Only `uid` (or name as fallback) is required for a consistent color.
 */
export function avatarInner(profile = {}) {
  const seed = profile.uid || profile.name || "?";
  const color = avatarColorFor(seed);
  return `<span class="avatar-fill" style="background:${color}">${genderIconSvg(profile.gender)}</span>`;
}

/** True if this email belongs to a GeoHub admin (CR / class admin). */
export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}

/** The small admin badge shown next to an admin's name everywhere — an "A" mark, no icon. */
export function adminBadgeHtml() {
  return `<span class="admin-badge" role="img" aria-label="Class Admin" title="Class Admin">A</span>`;
}

/** A student's display name, with the admin badge appended when applicable. */
export function nameWithBadge(name, email) {
  return `${escapeHtml(name || "Classmate")}${isAdminEmail(email) ? adminBadgeHtml() : ""}`;
}

/** Turn a Firestore Timestamp (or null, while pending) into "3m ago" style text. */
export function timeAgo(timestamp) {
  if (!timestamp || !timestamp.toDate) return "just now";
  const seconds = Math.floor((Date.now() - timestamp.toDate().getTime()) / 1000);
  if (seconds < 60) return "just now";
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return timestamp.toDate().toLocaleDateString();
}

/** Full readable date, used in detail modals (notices, profile "joined" date, etc). */
export function fullDate(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  return timestamp.toDate().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// ============================================================
// BUTTON LOADING STATE — used on every submit action (login,
// signup, post, comment, notice, resource, profile save…) so the
// user always gets clear feedback while a request is in flight.
// ============================================================
const spinnerHtml = `<span class="btn-spinner" aria-hidden="true"></span>`;

/**
 * Toggle a busy/spinner state on a button.
 * setBtnLoading(btn, true, "Posting…") -> disables it, shows a spinner + label
 * setBtnLoading(btn, false) -> restores exactly what was there before
 */
export function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.originalHtml === undefined) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = `${spinnerHtml}<span>${label || "Please wait…"}</span>`;
  } else {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    if (btn.dataset.originalHtml !== undefined) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

// ============================================================
// SHARED USER CACHE — populated by the directory listener (which
// already streams every student's profile) so other screens can
// show a name/avatar/details for a uid without a fresh fetch.
// ============================================================
const userCache = new Map();
export function cacheUserProfile(uid, profile) {
  if (uid && profile) userCache.set(uid, profile);
}
export function getCachedProfile(uid) {
  return userCache.get(uid) || null;
}

/** Long posts / notices collapse behind a "See more" toggle instead of stretching the feed. */
export function attachClampToggle(container) {
  container.querySelectorAll(".clamp-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const textEl = btn.previousElementSibling;
      const expanded = textEl.classList.toggle("expanded");
      btn.textContent = expanded ? "See less" : "… See more";
    });
  });
}

/** Renders body text with a "See more" affordance when it's long — shared by posts & notices. */
export function clampableHtml(rawText, extraClass = "") {
  const safe = escapeHtml(rawText);
  const isLong = rawText.length > 260;
  return `<p class="clampable ${extraClass} ${isLong ? "is-clampable" : ""}">${safe}</p>${isLong ? `<button type="button" class="clamp-toggle">… See more</button>` : ""}`;
}
