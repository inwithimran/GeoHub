// ============================================================
// DIRECTORY.JS — Classmate Directory
// Reads every doc in "users" (each student's own signup profile
// doubles as their directory entry — no separate collection needed).
// Also doubles as the shared profile cache used across the app.
// ============================================================
import { auth, db } from "./firebase-config.js";
import { collection, query, limit } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import { escapeHtml, showToast, setBtnLoading, cacheUserProfile, avatarInner, nameWithBadge, friendlyError } from "./ui-utils.js";
import { avatarPresenceDotHtml, isUserOnline, paintPresenceUI } from "./presence.js";
import { openUserProfilePage } from "./profile-view.js";
import { openDmThread } from "./messages.js";

const directoryList = document.getElementById("directory-list");
const searchInput = document.getElementById("directory-search");
let yearChipRow = null;
let activeYear = "All";

let allStudents = [];
let unsubscribeDirectory = null;

let onlineSection = null;
let onlineRefreshTimer = null;
const ONLINE_SECTION_REFRESH_MS = 12_000;

// ============================================================
// PAGINATION — same trade-off as the Wall (see wall.js): reading
// every classmate in one go got expensive as the department's
// signups grew, so the realtime listener is capped to a page size
// and "Load more classmates" just asks for a bigger page. No
// orderBy() is needed here (the list is re-sorted by name client-
// side for display anyway) — Firestore's default document-id order
// keeps each bigger page a strict superset of the last, so nobody
// already on screen jumps around when more load in underneath.
// ============================================================
const DIRECTORY_PAGE_SIZE = 60;
let directoryPageLimit = DIRECTORY_PAGE_SIZE;
let lastLoadedCount = 0;

export function getAllStudents() {
  return allStudents;
}

export function initDirectory(onSnapshotReceived) {
  searchInput.addEventListener("input", renderDirectory);
  subscribeDirectory(onSnapshotReceived);
  if (!onlineRefreshTimer) onlineRefreshTimer = setInterval(renderOnlineNowSection, ONLINE_SECTION_REFRESH_MS);
}

function subscribeDirectory(onSnapshotReceived) {
  if (unsubscribeDirectory) unsubscribeDirectory();
  const q = query(collection(db, "users"), limit(directoryPageLimit));
  unsubscribeDirectory = onSnapshotWithRetry(q, (snap) => {
    lastLoadedCount = snap.size;
    allStudents = snap.docs.map(d => {
      const data = d.data();
      cacheUserProfile(d.id, data);
      return data;
    }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderOnlineNowSection();
    renderYearChips();
    renderDirectory();
    if (onSnapshotReceived) onSnapshotReceived(snap);
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load classmates.");
    showToast(message, { details: technical });
  });
}

function renderYearChips() {
  const years = [...new Set(allStudents.map(s => s.year).filter(Boolean))];
  if (!years.length) { if (yearChipRow) { yearChipRow.remove(); yearChipRow = null; } return; }
  if (activeYear !== "All" && !years.includes(activeYear)) activeYear = "All";

  if (!yearChipRow) {
    yearChipRow = document.createElement("div");
    yearChipRow.className = "chip-row directory-year-chips";
    directoryList.parentElement.insertBefore(yearChipRow, directoryList);
  }
  const chips = ["All", ...years];
  yearChipRow.innerHTML = chips.map(y =>
    `<button type="button" class="chip ${y === activeYear ? "active" : ""}" data-year="${escapeHtml(y)}">${escapeHtml(y)}</button>`
  ).join("");
  yearChipRow.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      activeYear = chip.dataset.year;
      yearChipRow.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c === chip));
      renderDirectory();
    });
  });
}

function renderOnlineNowSection() {
  const myUid = auth.currentUser?.uid;
  const online = allStudents.filter(s => s.uid && s.uid !== myUid && isUserOnline(s));

  if (!online.length) {
    if (onlineSection) { onlineSection.remove(); onlineSection = null; }
    return;
  }
  if (!onlineSection) {
    onlineSection = document.createElement("div");
    onlineSection.className = "directory-online-section";
    directoryList.parentElement.insertBefore(onlineSection, directoryList);
  }
  onlineSection.innerHTML = `
    <div class="section-heading directory-online-heading">Online Now · ${online.length}</div>
    <div class="directory-online-scroll">
      ${online.map(s => `
        <button type="button" class="directory-online-item" data-uid="${escapeHtml(s.uid)}">
          <span class="avatar-presence-wrap">
            <span class="avatar">${avatarInner(s)}</span>
            ${avatarPresenceDotHtml(s.uid)}
          </span>
          <span class="directory-online-name">${escapeHtml((s.name || "Classmate").split(" ")[0])}</span>
        </button>
      `).join("")}
    </div>`;
  onlineSection.querySelectorAll(".directory-online-item").forEach(btn => {
    btn.addEventListener("click", () => openUserProfilePage(btn.dataset.uid));
  });
  paintPresenceUI();
}

function renderDirectory() {
  const term = searchInput.value.trim().toLowerCase();
  const filtered = allStudents.filter(s =>
    (activeYear === "All" || s.year === activeYear) &&
    ((s.name || "").toLowerCase().includes(term) ||
     (s.bloodGroup || "").toLowerCase().includes(term) ||
     (s.roll || "").toLowerCase().includes(term))
  );

  if (!filtered.length) {
    directoryList.innerHTML = `<p class="empty-state">No classmates match your search.</p>`;
    return;
  }

  directoryList.innerHTML = `<div class="flat-list">` + filtered.map(s => `
    <div class="directory-row" data-uid="${escapeHtml(s.uid || "")}">
      <span class="avatar-presence-wrap">
        <div class="avatar">${avatarInner(s)}</div>
        ${avatarPresenceDotHtml(s.uid, { label: true })}
      </span>
      <div class="directory-info">
        <strong>${nameWithBadge(s.name || "Unnamed", s.email)}</strong>
        <div class="directory-sub">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 17V7l8-4 8 4v10l-8 4-8-4z"/></svg>
          ${escapeHtml(s.roll || "—")}${s.year ? " · " + escapeHtml(s.year) : (s.session ? " · " + escapeHtml(s.session) : "")}
        </div>
      </div>
      <span class="blood-badge">${escapeHtml(s.bloodGroup || "—")}</span>
      ${s.uid && s.uid !== auth.currentUser?.uid
        ? `<button type="button" class="msg-btn" data-no-row-click data-msg-uid="${escapeHtml(s.uid)}" title="Message ${escapeHtml((s.name||"").split(" ")[0]||"")}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H8l-4.5 4V6.5a1 1 0 0 1 1-1z"/></svg>
          </button>`
        : ""}
      ${s.hidePhone || !s.phone
        ? `<span class="call-btn call-btn-disabled" title="${s.phone ? "Number hidden" : "No number on file"}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.32 1.85.55 2.81.68A2 2 0 0 1 22 16.92z"/><line x1="2" y1="2" x2="22" y2="22"/></svg>
          </span>`
        : `<a class="call-btn" href="tel:${escapeHtml(s.phone)}" data-no-row-click title="Call ${escapeHtml((s.name||"").split(" ")[0]||"")}">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.68 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.32 1.85.55 2.81.68A2 2 0 0 1 22 16.92z"/></svg>
          </a>`}
    </div>
  `).join("") + `</div>`;

  directoryList.querySelectorAll(".directory-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-no-row-click]")) return;
      openUserProfilePage(row.dataset.uid);
    });
  });
  directoryList.querySelectorAll(".msg-btn[data-msg-uid]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDmThread(btn.dataset.msgUid);
    });
  });

  if (lastLoadedCount === directoryPageLimit) {
    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.type = "button";
    loadMoreBtn.className = "btn-outline full directory-load-more";
    loadMoreBtn.textContent = "Load more classmates";
    loadMoreBtn.addEventListener("click", () => {
      setBtnLoading(loadMoreBtn, true, "Loading…");
      directoryPageLimit += DIRECTORY_PAGE_SIZE;
      subscribeDirectory();
    });
    directoryList.appendChild(loadMoreBtn);
  }
}

export function teardownDirectory() {
  if (unsubscribeDirectory) unsubscribeDirectory();
  if (onlineRefreshTimer) { clearInterval(onlineRefreshTimer); onlineRefreshTimer = null; }
}
