// ============================================================
// RESOURCES.JS — Central Note & Sheet Hub
// Resources live in the "resources" collection:
// { title, category, contributorName, link, createdAt }
// ============================================================
import { db, auth, RESOURCE_CATEGORIES } from "./firebase-config.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import { showToast, escapeHtml, openModal, closeModal, timeAgo, setBtnLoading } from "./ui-utils.js";

const chipRow = document.getElementById("resource-categories");
const resourceList = document.getElementById("resource-list");
const addBtn = document.getElementById("add-resource-btn");

let allResources = [];
let activeCategory = "All";
let unsubscribeResources = null;

export function initResources() {
  buildChips();
  addBtn.addEventListener("click", openAddResourceModal);

  const q = query(collection(db, "resources"), orderBy("createdAt", "desc"));
  unsubscribeResources = onSnapshot(q, (snap) => {
    allResources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderResources();
  }, (err) => showToast("Couldn't load resources: " + err.message));
}

function buildChips() {
  const cats = ["All", ...RESOURCE_CATEGORIES];
  chipRow.innerHTML = cats.map(c =>
    `<button class="chip ${c === "All" ? "active" : ""}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`
  ).join("");
  chipRow.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      activeCategory = chip.dataset.cat;
      chipRow.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      renderResources();
    });
  });
}

function renderResources() {
  const filtered = activeCategory === "All"
    ? allResources
    : allResources.filter(r => r.category === activeCategory);

  if (!filtered.length) {
    resourceList.innerHTML = `<p class="empty-state">No resources shared yet in this category.</p>`;
    return;
  }

  resourceList.innerHTML = `<div class="flat-list">` + filtered.map(r => `
    <div class="resource-row">
      <div class="resource-row-icon">${fileGlyph(r.category)}</div>
      <div class="resource-row-info">
        <span class="res-cat">${escapeHtml(r.category)}</span>
        <h4>${escapeHtml(r.title)}</h4>
        <div class="res-meta">Shared by ${escapeHtml(r.contributorName)} · ${timeAgo(r.createdAt)}</div>
      </div>
      <a class="res-link" href="${escapeHtml(r.link)}" target="_blank" rel="noopener">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>
        <span>Open</span>
      </a>
    </div>
  `).join("") + `</div>`;
}

/** Single-letter glyph shown in the leading icon slot, based on category. */
function fileGlyph(category = "") {
  return escapeHtml((category[0] || "•").toUpperCase());
}

function openAddResourceModal() {
  const options = RESOURCE_CATEGORIES.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  openModal(`
    <h3>Share a Note / Sheet</h3>
    <label class="field">
      <span>Title</span>
      <input type="text" id="res-title" placeholder="e.g. Climatology Ch.3 Summary" />
    </label>
    <label class="field">
      <span>Category</span>
      <select id="res-category">${options}</select>
    </label>
    <label class="field">
      <span>Link (Google Drive / OneDrive / etc.)</span>
      <input type="url" id="res-link" placeholder="https://drive.google.com/…" />
    </label>
    <button type="button" class="btn-primary full" id="res-submit-btn">Publish Resource</button>
  `);
  document.getElementById("res-submit-btn").addEventListener("click", submitResource);
}

async function submitResource() {
  const btn = document.getElementById("res-submit-btn");
  const title = document.getElementById("res-title").value.trim();
  const category = document.getElementById("res-category").value;
  const link = document.getElementById("res-link").value.trim();

  if (!title || !link) return showToast("Please fill in the title and link.");

  setBtnLoading(btn, true, "Publishing…");
  try {
    await addDoc(collection(db, "resources"), {
      title, category, link,
      contributorName: currentProfile.name,
      contributorUid: auth.currentUser.uid,
      createdAt: serverTimestamp()
    });
    closeModal();
    showToast("Resource shared with the department 🎉");
  } catch (err) {
    showToast("Couldn't share resource: " + err.message);
    setBtnLoading(btn, false);
  }
}

export function teardownResources() {
  if (unsubscribeResources) unsubscribeResources();
}
