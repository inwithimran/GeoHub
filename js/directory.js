// ============================================================
// DIRECTORY.JS — Classmate Directory
// Reads every doc in "users" (each student's own signup profile
// doubles as their directory entry — no separate collection needed).
// Also doubles as the shared profile cache used across the app.
// ============================================================
import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, showToast, cacheUserProfile, avatarInner, nameWithBadge } from "./ui-utils.js";
import { openUserProfileModal } from "./profile-view.js";

const directoryList = document.getElementById("directory-list");
const searchInput = document.getElementById("directory-search");

let allStudents = [];
let unsubscribeDirectory = null;

export function initDirectory() {
  searchInput.addEventListener("input", renderDirectory);

  unsubscribeDirectory = onSnapshot(collection(db, "users"), (snap) => {
    allStudents = snap.docs.map(d => {
      const data = d.data();
      cacheUserProfile(d.id, data); // keep the shared cache warm for wall.js / profile-view.js
      return data;
    }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderDirectory();
  }, (err) => showToast("Couldn't load classmates: " + err.message));
}

function renderDirectory() {
  const term = searchInput.value.trim().toLowerCase();
  const filtered = allStudents.filter(s =>
    (s.name || "").toLowerCase().includes(term) ||
    (s.bloodGroup || "").toLowerCase().includes(term)
  );

  if (!filtered.length) {
    directoryList.innerHTML = `<p class="empty-state">No classmates match your search.</p>`;
    return;
  }

  directoryList.innerHTML = `<div class="flat-list">` + filtered.map(s => `
    <div class="directory-row" data-uid="${escapeHtml(s.uid || "")}">
      <div class="avatar">${avatarInner(s)}</div>
      <div class="directory-info">
        <strong>${nameWithBadge(s.name || "Unnamed", s.email)}</strong>
        <div class="directory-sub">Roll: ${escapeHtml(s.roll || "—")}${s.year ? " · " + escapeHtml(s.year) : (s.session ? " · " + escapeHtml(s.session) : "")}</div>
      </div>
      <span class="blood-badge">${escapeHtml(s.bloodGroup || "—")}</span>
      ${s.hidePhone || !s.phone
        ? `<span class="call-btn call-btn-disabled">${s.phone ? "Hidden" : "No number"}</span>`
        : `<a class="call-btn" href="tel:${escapeHtml(s.phone)}" data-no-row-click>Call</a>`}
    </div>
  `).join("") + `</div>`;

  directoryList.querySelectorAll(".directory-row").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest("[data-no-row-click]")) return; // let the Call link work normally
      openUserProfileModal(row.dataset.uid);
    });
  });
}

export function teardownDirectory() {
  if (unsubscribeDirectory) unsubscribeDirectory();
}
