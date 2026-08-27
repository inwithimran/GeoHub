// ============================================================
// DIRECTORY.JS — Classmate Directory
// Reads every doc in "users" (each student's own signup profile
// doubles as their directory entry — no separate collection needed).
// ============================================================
import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, initialsOf, showToast } from "./ui-utils.js";

const directoryList = document.getElementById("directory-list");
const searchInput = document.getElementById("directory-search");

let allStudents = [];
let unsubscribeDirectory = null;

export function initDirectory() {
  searchInput.addEventListener("input", renderDirectory);

  unsubscribeDirectory = onSnapshot(collection(db, "users"), (snap) => {
    allStudents = snap.docs.map(d => d.data()).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
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

  directoryList.innerHTML = filtered.map(s => `
    <div class="directory-item">
      <div class="avatar">${initialsOf(s.name)}</div>
      <div class="directory-info">
        <strong>${escapeHtml(s.name || "Unnamed")}</strong>
        <div class="directory-sub">Roll: ${escapeHtml(s.roll || "—")}</div>
      </div>
      <span class="blood-badge">${escapeHtml(s.bloodGroup || "—")}</span>
      ${s.phone ? `<a class="call-btn" href="tel:${escapeHtml(s.phone)}">Call</a>` : ""}
    </div>
  `).join("");
}

export function teardownDirectory() {
  if (unsubscribeDirectory) unsubscribeDirectory();
}
