import { ADMIN_EMAILS, ADMIN_NAME, db } from "./firebase-config.js";
import { doc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";

const toastEl = document.getElementById("toast");
let toastTimer = null;
let toastDetailsId = 0;

export function showToast(message, { details, duration = 2500 } = {}) {
  clearTimeout(toastTimer);
  toastEl.innerHTML = "";
  toastEl.classList.toggle("has-details", !!details);

  const msgSpan = document.createElement("span");
  msgSpan.className = "toast-msg";
  msgSpan.textContent = message;
  toastEl.appendChild(msgSpan);

  if (details) {
    const detailsId = `toast-details-${++toastDetailsId}`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "toast-details-toggle";
    toggle.textContent = "Details";
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-controls", detailsId);

    const detailsEl = document.createElement("div");
    detailsEl.id = detailsId;
    detailsEl.className = "toast-details hidden";
    detailsEl.textContent = details;

    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const nowHidden = detailsEl.classList.toggle("hidden");
      toggle.setAttribute("aria-expanded", String(!nowHidden));
      toggle.textContent = nowHidden ? "Details" : "Hide details";
      clearTimeout(toastTimer);
      if (nowHidden) toastTimer = setTimeout(() => toastEl.classList.add("hidden"), duration);
    });

    toastEl.appendChild(toggle);
    toastEl.appendChild(detailsEl);
  }

  toastEl.classList.remove("hidden");
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), duration);
}

const FRIENDLY_ERROR_MESSAGES = {
  "permission-denied": "You don't have permission to do that.",
  "unauthenticated": "You've been signed out — please log in again.",
  "unavailable": "Can't reach the server right now. Check your connection and try again.",
  "failed-precondition": "That couldn't be completed right now. Please try again in a moment.",
  "not-found": "That couldn't be found — it may have been removed.",
  "already-exists": "That already exists.",
  "resource-exhausted": "Too many requests right now — please try again shortly.",
  "cancelled": "That was interrupted before it finished. Please try again.",
  "deadline-exceeded": "That took too long to respond. Please try again.",
  "aborted": "That couldn't be completed — please try again.",
  "internal": "Something went wrong on our end. Please try again.",
  "invalid-argument": "Something about that request wasn't valid.",
  "out-of-range": "Something about that request wasn't valid.",
  "data-loss": "Something went wrong loading that data. Please try again.",
};

export function friendlyError(err, fallback = "Something went wrong. Please try again.") {
  const code = err?.code ? String(err.code).replace(/^firestore\//, "") : "";
  const technical = err ? [err.code, err.message].filter(Boolean).join(" — ") || String(err) : "";
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return { message: "You're offline — this will work again once you're back online.", technical };
  }
  return { message: FRIENDLY_ERROR_MESSAGES[code] || fallback, technical };
}

const modalOverlay = document.getElementById("modal-overlay");
const modalBody = document.getElementById("modal-body");
const modalScroll = document.getElementById("modal-scroll");
const modalCloseBtn = document.getElementById("modal-close-btn");

let modalHistoryOpen = false;  
let closingFromPopstate = false; 
let modalClosable = true;    
export function openModal(html, { closable = true } = {}) {
  const wasHidden = modalOverlay.classList.contains("hidden");
  modalBody.innerHTML = html;
  if (modalScroll) modalScroll.scrollTop = 0; 
  modalClosable = closable;
  modalOverlay.classList.toggle("no-close", !closable);
  modalOverlay.classList.remove("hidden");
  if (wasHidden) {
    history.pushState({ geohubModal: true }, "");
    modalHistoryOpen = true;
  }
}

export function closeModal({ force = false, keepHistory = false } = {}) {
  if (modalOverlay.classList.contains("hidden")) return;
  if (!modalClosable && !force) return;
  modalOverlay.classList.add("hidden");
  modalOverlay.classList.remove("no-close");
  modalBody.innerHTML = "";
  modalClosable = true;
  if (modalHistoryOpen) {
    modalHistoryOpen = false;
    if (!closingFromPopstate && !keepHistory) history.back(); 
  }
}

modalCloseBtn.addEventListener("click", () => closeModal());

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

document.addEventListener("wheel", (e) => {
  const row = e.target.closest?.(".chip-row");
  if (!row || row.scrollWidth <= row.clientWidth) return;
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; 
  e.preventDefault();
  row.scrollLeft += e.deltaY;
}, { passive: false });

export function skeletonRowsHtml(count = 3) {
  const row = `
    <div class="skeleton-row" aria-hidden="true">
      <div class="skeleton-avatar"></div>
      <div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div>
    </div>`;
  return row.repeat(count);
}

export function escapeHtml(str = "") {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

export function initialsOf(name = "?") {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || "").join("") || "?";
}


const AVATAR_PALETTE = [
  "#e11d48", "#db2777", "#c026d3", "#9333ea", "#7c3aed",
  "#4f46e5", "#2563eb", "#0ea5e9", "#0891b2", "#0d9488",
  "#059669", "#65a30d", "#ca8a04", "#d97706", "#ea580c", "#dc2626"
];

function hashSeed(seed = "") {
  let h = 0;
  for (let i = 0; i < seed.length; i++) { h = (h * 31 + seed.charCodeAt(i)) >>> 0; }
  return h;
}

export function avatarColorFor(seed) {
  if (!seed) return AVATAR_PALETTE[0];
  return AVATAR_PALETTE[hashSeed(String(seed)) % AVATAR_PALETTE.length];
}

function genderIconSvg(gender) {
  const body = `<path d="M12 14.5c-4.53 0-10.05 2.07-10.05 6.25V22h20.1v-1.25c0-4.18-5.52-6.25-10.05-6.25Z" fill="rgba(255,255,255,0.97)"/>`;

  if (gender === "male") {
    return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <circle cx="12" cy="7.65" r="4.55" fill="rgba(255,255,255,0.5)"/>
      <circle cx="12" cy="8.3" r="4" fill="rgba(255,255,255,0.97)"/>
      ${body}
    </svg>`;
  }

  if (gender === "female") {
    return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
      <path d="M17.55 13.75c1.75.98 2.9 2.6 3.15 4.55.25-1.55.06-2.98-.55-4.15-.75.02-1.6-.13-2.6-.4Z" fill="rgba(255,255,255,0.97)"/>
      <path d="M6.45 13.75c-1.75.98-2.9 2.6-3.15 4.55-.25-1.55-.06-2.98.55-4.15.75.02 1.6-.13 2.6-.4Z" fill="rgba(255,255,255,0.97)"/>
      <circle cx="12" cy="8.35" r="5.6" fill="rgba(255,255,255,0.97)"/>
      <circle cx="12" cy="9.05" r="3.7" fill="rgba(255,255,255,0.72)"/>
      ${body}
    </svg>`;
  }

  return `<svg viewBox="0 0 24 24" width="60%" height="60%" aria-hidden="true">
    <circle cx="12" cy="7.65" r="4.4" fill="rgba(255,255,255,0.97)"/>
    <circle cx="12" cy="4.55" r="1.15" fill="rgba(255,255,255,0.55)"/>
    ${body}
  </svg>`;
}

export function avatarInner(profile = {}) {
  const seed = profile.uid || profile.name || "?";
  const color = avatarColorFor(seed);
  if (profile.photoURL) {
    return `<span class="avatar-fill" style="background:${color}"><img src="${escapeHtml(profile.photoURL)}" alt="" loading="lazy" /></span>`;
  }
  return `<span class="avatar-fill" style="background:${color}">${genderIconSvg(profile.gender)}</span>`;
}

export function isAdminEmail(email) {
  return !!email && ADMIN_EMAILS.includes(email);
}

export function adminBadgeHtml() {
  return `<svg class="admin-badge" viewBox="0 0 24 24" role="img" aria-label="Verified Admin" aria-hidden="false"><title>Founder & Admin</title><path d="M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12z"/><text x="12" y="15.7" text-anchor="middle" font-size="10" font-weight="800" fill="#fff" font-family="Arial, Helvetica, sans-serif">A</text></svg>`;
}

export function nameWithBadge(name, email) {
  const admin = isAdminEmail(email);
  const displayName = admin ? ADMIN_NAME : (name || "Classmate");
  return `${escapeHtml(displayName)}${admin ? adminBadgeHtml() : ""}`;
}

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

export function fullDate(timestamp) {
  if (!timestamp || !timestamp.toDate) return "";
  return timestamp.toDate().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

const spinnerHtml = `<span class="btn-spinner" aria-hidden="true"></span>`;

export function setBtnLoading(btn, loading, label) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.originalHtml === undefined) btn.dataset.originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.classList.add("is-loading");
    btn.innerHTML = `${spinnerHtml}<span class="btn-spinner-label">${label || "Please wait…"}</span>`;
  } else {
    btn.disabled = false;
    btn.classList.remove("is-loading");
    if (btn.dataset.originalHtml !== undefined) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

export function wireCharCounter(field, limit) {
  if (!field) return;
  field.maxLength = limit;
  let counter = field.nextElementSibling;
  if (!counter || !counter.classList.contains("char-counter")) {
    counter = document.createElement("div");
    counter.className = "char-counter";
    field.insertAdjacentElement("afterend", counter);
  }
  const update = () => {
    const len = field.value.length;
    counter.textContent = `${len}/${limit}`;
    counter.classList.toggle("char-counter-warn", len >= limit * 0.9);
  };
  field.addEventListener("input", update);
  update();
}

const userCache = new Map();
const profileListeners = new Set();
const subscribedProfiles = new Set();

export function cacheUserProfile(uid, profile) {
  if (!uid || !profile) return;
  userCache.set(uid, profile);
  profileListeners.forEach(cb => cb(uid));
}

export function getCachedProfile(uid) {
  return userCache.get(uid) || null;
}


export function subscribeToProfileUpdates(callback) {
  profileListeners.add(callback);
  return () => profileListeners.delete(callback);
}

export function ensureProfileLoaded(uid) {
  if (!uid || subscribedProfiles.has(uid)) return;
  subscribedProfiles.add(uid);
  onSnapshotWithRetry(doc(db, "users", uid), (snap) => {
    if (snap.exists()) cacheUserProfile(uid, snap.data());
  }, () => {  });
}

export function attachClampToggle(container) {
  container.querySelectorAll(".clamp-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const textEl = btn.previousElementSibling;
      const expanded = textEl.classList.toggle("expanded");
      btn.textContent = expanded ? "See less" : "See more";
    });
  });
}

export function clampableHtml(rawText, extraClass = "") {
  const safe = escapeHtml(rawText);
  const isLong = rawText.length > 260;
  return `<p class="clampable ${extraClass} ${isLong ? "is-clampable" : ""}">${safe}</p>${isLong ? `<button type="button" class="clamp-toggle"> See more</button>` : ""}`;
}

const HASHTAG_RE = /#([A-Za-z0-9_\u0980-\u09FF]{2,40})/g;

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractHashtags(rawText = "") {
  const found = new Set();
  for (const m of rawText.matchAll(HASHTAG_RE)) found.add(m[1].toLowerCase());
  return [...found];
}

export function richTextHtml(rawText, mentions = []) {
  let safe = escapeHtml(rawText);

  const uniqueMentions = [...new Map((mentions || []).filter(m => m && m.uid && m.name).map(m => [m.uid, m])).values()]
    .sort((a, b) => b.name.length - a.name.length);
  uniqueMentions.forEach((m) => {
    const escapedName = escapeHtml(m.name);
    const re = new RegExp(`@${escapeRegExp(escapedName)}(?=\\s|$|[.,!?;:)])`, "g");
    safe = safe.replace(re, `<button type="button" class="mention-chip" data-mention-uid="${escapeHtml(m.uid)}">@${escapedName}</button>`);
  });

  safe = safe.replace(HASHTAG_RE, (whole, tag) =>
    `<button type="button" class="hashtag-chip" data-hashtag="${tag.toLowerCase()}">#${tag}</button>`);

  return safe;
}

export function clampableRichHtml(rawText, mentions = [], extraClass = "") {
  const html = richTextHtml(rawText, mentions);
  const isLong = rawText.length > 260;
  return `<p class="clampable ${extraClass} ${isLong ? "is-clampable" : ""}">${html}</p>${isLong ? `<button type="button" class="clamp-toggle"> See more</button>` : ""}`;
}

export function wireRichTextClicks(root) {
  root.querySelectorAll(".mention-chip").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { openUserProfilePage } = await import("./profile-view.js");
      openUserProfilePage(btn.dataset.mentionUid);
    });
  });
  root.querySelectorAll(".hashtag-chip").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const { openHashtagResults } = await import("./wall.js");
      openHashtagResults(btn.dataset.hashtag);
    });
  });
}

export function wireMentionAutocomplete(fieldEl, getCandidates, onPick) {
  if (!fieldEl || fieldEl.dataset.mentionWired) return;
  fieldEl.dataset.mentionWired = "1";

  const dropdown = document.createElement("div");
  dropdown.className = "mention-dropdown hidden";
  document.body.appendChild(dropdown);

  function reposition() {
    const rect = fieldEl.getBoundingClientRect();
    const bottomClearance = 92;
    const dropdownHeight = Math.min(dropdown.scrollHeight || 220, 220);
    const spaceBelow = window.innerHeight - rect.bottom - bottomClearance;
    const openUpward = spaceBelow < dropdownHeight && rect.top > dropdownHeight + 12;

    dropdown.style.left = `${rect.left}px`;
    dropdown.style.width = `${rect.width}px`;
    if (openUpward) {
      dropdown.style.top = "";
      dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
    } else {
      dropdown.style.bottom = "";
      dropdown.style.top = `${rect.bottom + 4}px`;
    }
  }

  let activeIndex = -1;
  let currentMatches = [];

  function currentTrigger() {
    const value = fieldEl.value;
    const caret = fieldEl.selectionStart ?? value.length;
    const match = value.slice(0, caret).match(/(?:^|\s)@([^\s@]{0,30})$/);
    return match ? match[1] : null;
  }

  function close() {
    dropdown.classList.add("hidden");
    dropdown.innerHTML = "";
    currentMatches = [];
    activeIndex = -1;
  }

  function pick(candidate) {
    const value = fieldEl.value;
    const caret = fieldEl.selectionStart ?? value.length;
    const before = value.slice(0, caret).replace(/@([^\s@]{0,30})$/, `@${candidate.name} `);
    fieldEl.value = before + value.slice(caret);
    const newCaret = before.length;
    fieldEl.focus();
    fieldEl.setSelectionRange(newCaret, newCaret);
    close();
    onPick(candidate);
  }

  function paintActive() {
    dropdown.querySelectorAll(".mention-option").forEach((btn, i) => {
      btn.classList.toggle("active", i === activeIndex);
    });
  }

  function open(query) {
    currentMatches = (getCandidates(query) || []).slice(0, 6);
    if (!currentMatches.length) { close(); return; }
    activeIndex = 0;
    dropdown.innerHTML = currentMatches.map((m, i) =>
      `<button type="button" class="mention-option ${i === 0 ? "active" : ""}" data-index="${i}">
        <span class="avatar avatar-sm">${avatarInner(m)}</span>
        <span>${escapeHtml(m.name || "Classmate")}</span>
      </button>`
    ).join("");
    dropdown.classList.remove("hidden");
    reposition();
    dropdown.querySelectorAll(".mention-option").forEach((btn, i) => {
      btn.addEventListener("mousedown", (e) => { e.preventDefault(); pick(currentMatches[i]); });
      btn.addEventListener("mouseenter", () => { activeIndex = i; paintActive(); });
    });
  }

  fieldEl.addEventListener("input", () => {
    const q = currentTrigger();
    if (q === null) { close(); return; }
    open(q);
  });
  fieldEl.addEventListener("blur", () => setTimeout(close, 120));
  fieldEl.addEventListener("keydown", (e) => {
    if (dropdown.classList.contains("hidden")) return;
    if (e.key === "Escape") { close(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      activeIndex = (activeIndex + 1) % currentMatches.length;
      paintActive();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      activeIndex = (activeIndex - 1 + currentMatches.length) % currentMatches.length;
      paintActive();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (currentMatches[activeIndex]) {
        e.preventDefault();
        pick(currentMatches[activeIndex]);
      }
    }
  });
  window.addEventListener("resize", () => { if (!dropdown.classList.contains("hidden")) reposition(); });
  window.addEventListener("scroll", () => { if (!dropdown.classList.contains("hidden")) reposition(); }, true);

  const cleanupObserver = new MutationObserver(() => {
    if (!document.body.contains(fieldEl)) {
      dropdown.remove();
      cleanupObserver.disconnect();
    }
  });
  cleanupObserver.observe(document.body, { childList: true, subtree: true });
}

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

export function closeAllKebabMenus() {
  document.querySelectorAll(".kebab-dropdown").forEach(d => d.classList.add("hidden"));
  document.querySelectorAll(".kebab-stack-top").forEach(el => el.classList.remove("kebab-stack-top"));
}
document.addEventListener("click", closeAllKebabMenus);

export function wireKebabMenus(root, handlers) {
  root.querySelectorAll(".kebab-menu").forEach(menu => {
    const btn = menu.querySelector(".kebab-btn");
    const dd = menu.querySelector(".kebab-dropdown");
    if (!btn || !dd || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    const stackHost = menu.closest(".notice-row, .feed-post, .resource-row, .comment-item, .directory-row, .dm-thread-header-row") || menu;
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
      const { message, technical } = friendlyError(err);
      showToast(message, { details: technical });
      setBtnLoading(okBtn, false);
    }
  });
}

export function resetScrollForTabs(anchorEl) {
  if (!anchorEl) return;
  const topbar = document.querySelector(".topbar");
  const offset = (topbar?.offsetHeight || 0) + 10;
  const top = anchorEl.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({ top: Math.max(top, 0), behavior: "auto" });
}
