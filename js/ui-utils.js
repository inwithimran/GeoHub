// ============================================================
// UI-UTILS.JS — small shared helpers (toast, modal, formatting)
// used by wall.js / resources.js / directory.js / routine.js
// ============================================================
import { ADMIN_EMAILS, ADMIN_NAME } from "./firebase-config.js";

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
const modalCloseBtn = document.getElementById("modal-close-btn");

// ============================================================
// MODAL <-> BACK BUTTON — every modal push its own history entry,
// so the device/browser back button closes the modal (instead of
// leaving the whole app) and lands the user back on whatever
// section they were viewing. Content-only refreshes of an already
// -open modal (e.g. a "Loading…" state swapped for the real
// content) don't push a second entry.
//
// Tapping the dark backdrop no longer closes the sheet — the only
// way to dismiss a modal is the close (X) button in its top-right
// corner. A modal opened with { closable: false } (the mandatory
// "finish your profile" step right after first sign-in) hides that
// button entirely and can't be dismissed until the flow calls
// closeModal({ force: true }) itself.
// ============================================================
let modalHistoryOpen = false;   // true while the current history entry represents an open modal
let closingFromPopstate = false; // true while we're reacting to a back-navigation, to avoid a double history.back()
let modalClosable = true;       // false while a mandatory, non-dismissable modal is open

/** Open the shared bottom-sheet modal with the given inner HTML. Pass { closable: false } for a modal that must be completed rather than dismissed. */
export function openModal(html, { closable = true } = {}) {
  const wasHidden = modalOverlay.classList.contains("hidden");
  modalBody.innerHTML = html;
  modalClosable = closable;
  modalOverlay.classList.toggle("no-close", !closable);
  modalOverlay.classList.remove("hidden");
  if (wasHidden) {
    history.pushState({ geohubModal: true }, "");
    modalHistoryOpen = true;
  }
}
/**
 * Close the modal. A non-closable (mandatory) modal ignores this unless { force: true } is passed.
 * Pass { keepHistory: true } when the modal is being closed only because the caller is about to
 * navigate to a full page right after (e.g. tapping a name in the "Liked by" list) — this skips the
 * history.back() call so it can't race the page's own history.pushState/replaceState. The caller is
 * then responsible for using `{ replace: true }` on that navigation so it replaces this modal's
 * history entry instead of stacking on top of it.
 */
export function closeModal({ force = false, keepHistory = false } = {}) {
  if (modalOverlay.classList.contains("hidden")) return;
  if (!modalClosable && !force) return;
  modalOverlay.classList.add("hidden");
  modalOverlay.classList.remove("no-close");
  modalBody.innerHTML = "";
  modalClosable = true;
  if (modalHistoryOpen) {
    modalHistoryOpen = false;
    if (!closingFromPopstate && !keepHistory) history.back(); // pop the entry this modal pushed
  }
}
// The close (X) button is the only way to dismiss a modal by hand.
modalCloseBtn.addEventListener("click", () => closeModal());
// Device/browser back button: close an open, closable modal instead of
// navigating away. A mandatory modal re-asserts its history entry so the
// back button can't be used to slip past it.
window.addEventListener("popstate", () => {
  if (modalOverlay.classList.contains("hidden")) return;
  if (!modalClosable) {
    history.pushState({ geohubModal: true }, "");
    return;
  }
  closingFromPopstate = true;
  closeModal();
  closingFromPopstate = false;
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
  if (profile.photoURL) {
    return `<span class="avatar-fill" style="background:${color}"><img src="${escapeHtml(profile.photoURL)}" alt="" loading="lazy" /></span>`;
  }
  return `<span class="avatar-fill" style="background:${color}">${genderIconSvg(profile.gender)}</span>`;
}

/** True if this email belongs to a GeoHub admin (CR / class admin). */
export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}

/** The small purple "verified" seal shown next to the admin's name everywhere (scalloped badge shape, like the well-known social-app verified marks, with an "A" mark inside). */
export function adminBadgeHtml() {
  return `<svg class="admin-badge" viewBox="0 0 24 24" role="img" aria-label="Verified Admin" aria-hidden="false"><title>Founder & Admin</title><path d="M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12z"/><text x="12" y="15.7" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Arial, Helvetica, sans-serif">A</text></svg>`;
}

/**
 * A student's display name, with the admin badge appended when applicable.
 * For the class admin's email, the canonical ADMIN_NAME is always shown
 * (instead of whatever name happens to be stored on the account) — so the
 * admin's identity is consistent everywhere: Wall posts, comments, the
 * Notice Board, Directory, and Profile.
 */
export function nameWithBadge(name, email) {
  const admin = isAdminEmail(email);
  const displayName = admin ? ADMIN_NAME : (name || "Classmate");
  return `${escapeHtml(displayName)}${admin ? adminBadgeHtml() : ""}`;
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
      btn.textContent = expanded ? "See less" : "See more";
    });
  });
}

/** Renders body text with a "See more" affordance when it's long — shared by posts & notices. */
export function clampableHtml(rawText, extraClass = "") {
  const safe = escapeHtml(rawText);
  const isLong = rawText.length > 260;
  return `<p class="clampable ${extraClass} ${isLong ? "is-clampable" : ""}">${safe}</p>${isLong ? `<button type="button" class="clamp-toggle"> See more</button>` : ""}`;
}

// ============================================================
// OWNER "THREE-DOT" MENU — reused wherever a student should be
// able to edit/delete something they own (posts, comments,
// resources, notices). Markup + wiring live here once so every
// screen behaves identically and only one dropdown is ever open.
// ============================================================

/** Build the three-dot trigger + its dropdown of actions. `id` is handed back to your handler untouched. */
export function kebabMenuHtml(id, actions, extraClass = "") {
  return `
    <div class="kebab-menu ${extraClass}" data-kebab-id="${escapeHtml(String(id))}">
      <button type="button" class="kebab-btn" aria-label="More options" aria-haspopup="true">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
      </button>
      <div class="kebab-dropdown hidden">
        ${actions.map(a => `<button type="button" class="kebab-item ${a.danger ? "danger" : ""}" data-kebab-action="${escapeHtml(a.action)}">${escapeHtml(a.label)}</button>`).join("")}
      </div>
    </div>`;
}

/**
 * Close every open kebab dropdown in the document, and un-elevate whatever
 * row it had been lifted above its siblings (see wireKebabMenus below).
 */
export function closeAllKebabMenus() {
  document.querySelectorAll(".kebab-dropdown").forEach(d => d.classList.add("hidden"));
  document.querySelectorAll(".kebab-stack-top").forEach(el => el.classList.remove("kebab-stack-top"));
}
document.addEventListener("click", closeAllKebabMenus);

/**
 * Wire up every not-yet-wired `.kebab-menu` under `root`.
 * `handlers` is a map of action name -> function(id). Re-safe to call
 * on every re-render since already-wired menus are skipped.
 */
export function wireKebabMenus(root, handlers) {
  root.querySelectorAll(".kebab-menu").forEach(menu => {
    const btn = menu.querySelector(".kebab-btn");
    const dd = menu.querySelector(".kebab-dropdown");
    if (!btn || !dd || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    // Some cards (notice-row, in particular) apply a CSS transform, which
    // creates its own stacking context — that traps the dropdown's z-index
    // inside it, so the *next* card (painted after it in normal doc order)
    // can still cover the open dropdown. Elevating the whole card above its
    // siblings while its own menu is open fixes that for every card type.
    const stackHost = menu.closest(".notice-row, .feed-post, .resource-row, .comment-item, .directory-row") || menu;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasHidden = dd.classList.contains("hidden");
      closeAllKebabMenus();
      if (wasHidden) {
        dd.classList.remove("hidden");
        stackHost.classList.add("kebab-stack-top");
      }
    });
    dd.querySelectorAll(".kebab-item").forEach(item => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closeAllKebabMenus();
        const action = item.dataset.kebabAction;
        handlers[action]?.(menu.dataset.kebabId);
      });
    });
  });
}

/** Shared "are you sure?" confirmation sheet — used for every delete action in the app. */
export function confirmDialog({ title, text, confirmLabel = "Delete", danger = true, onConfirm }) {
  openModal(`
    <div class="confirm-modal">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
      </div>
      <h3>${escapeHtml(title)}</h3>
      <p class="confirm-text">${escapeHtml(text)}</p>
      <div class="confirm-actions">
        <button type="button" class="btn-outline full" id="confirm-cancel-btn">Cancel</button>
        <button type="button" class="btn-primary full ${danger ? "danger-solid" : ""}" id="confirm-ok-btn">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `);
  document.getElementById("confirm-cancel-btn").addEventListener("click", () => closeModal());
  const okBtn = document.getElementById("confirm-ok-btn");
  okBtn.addEventListener("click", async () => {
    setBtnLoading(okBtn, true, "Please wait…");
    try {
      await onConfirm();
      closeModal();
    } catch (err) {
      showToast("Something went wrong: " + err.message);
      setBtnLoading(okBtn, false);
    }
  });
}

/**
 * Fix for tab panels sharing one page-level scroll container: switching
 * tabs used to leave the window at whatever scrollTop the previous tab
 * left behind, so a short tab could open already "scrolled" out of view.
 * Call this right after toggling `.active` on the tab panels.
 */
export function resetScrollForTabs(anchorEl) {
  if (!anchorEl) return;
  const topbar = document.querySelector(".topbar");
  const offset = (topbar?.offsetHeight || 0) + 10;
  const top = anchorEl.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(top, 0), behavior: "auto" });
}
