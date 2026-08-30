// ============================================================
// DIRECTORY.JS — Classmate Directory
// Reads every doc in "users" (each student's own signup profile
// doubles as their directory entry — no separate collection needed).
// Also doubles as the shared profile cache used across the app.
// ============================================================
import { db } from "./firebase-config.js";
import { collection, onSnapshot } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, showToast, cacheUserProfile, avatarInner, nameWithBadge } from "./ui-utils.js";
import { openUserProfilePage } from "./profile-view.js";

const directoryList = document.getElementById("directory-list");
const searchInput = document.getElementById("directory-search");
// Built once the first batch of profiles arrives (see renderYearChips) —
// a "Year" filter row inserted right above the results, same chip style
// as the Notes & Sheet Hub categories, so a big department can narrow
// the directory down instead of scrolling past everyone.
let yearChipRow = null;
let activeYear = "All";

let allStudents = [];
let unsubscribeDirectory = null;

/** The current classmate list (for @mention autocomplete elsewhere — wall.js, post-detail.js). */
export function getAllStudents() {
  return allStudents;
}

export function initDirectory() {
  searchInput.addEventListener("input", renderDirectory);

  unsubscribeDirectory = onSnapshot(collection(db, "users"), (snap) => {
    allStudents = snap.docs.map(d => {
      const data = d.data();
      cacheUserProfile(d.id, data); // keep the shared cache warm for wall.js / profile-view.js
      return data;
    }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    renderYearChips();
    renderDirectory();
  }, (err) => showToast("Couldn't load classmates: " + err.message));
}

/** Build/refresh the Year filter chips from whichever years are actually in use. */
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
      <div class="avatar">${avatarInner(s)}</div>
      <div class="directory-info">
        <strong>${nameWithBadge(s.name || "Unnamed", s.email)}</strong>
        <div class="directory-sub">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M4 17V7l8-4 8 4v10l-8 4-8-4z"/></svg>
          ${escapeHtml(s.roll || "—")}${s.year ? " · " + escapeHtml(s.year) : (s.session ? " · " + escapeHtml(s.session) : "")}
        </div>
      </div>
      <span class="blood-badge">${escapeHtml(s.bloodGroup || "—")}</span>
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
      if (e.target.closest("[data-no-row-click]")) return; // let the Call link work normally
      openUserProfilePage(row.dataset.uid);
    });
  });
}

export function teardownDirectory() {
  if (unsubscribeDirectory) unsubscribeDirectory();
}
