// ============================================================
// UI-UTILS.JS — small shared helpers (toast, modal, formatting)
// used by wall.js / resources.js / directory.js / routine.js
// ============================================================

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

/** Two-letter initials for avatar circles, e.g. "Rafiul Islam" -> "RI". */
export function initialsOf(name = "?") {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
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
