// ============================================================
// RESOURCES.JS — Central Note & Sheet Hub
// Resources live in the "resources" collection:
// { title, category, contributorName, contributorUid, link, createdAt }
// ============================================================
import { db, auth, RESOURCE_CATEGORIES } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where, orderBy, limit, getDocs, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import {
  showToast, escapeHtml, openModal, closeModal, timeAgo, setBtnLoading,
  kebabMenuHtml, wireKebabMenus, confirmDialog, friendlyError
} from "./ui-utils.js";
import { logActivity, deleteActivityForResource } from "./routine.js";
import { triggerPush } from "./push-trigger.js";

const chipRow = document.getElementById("resource-categories");
const resourceList = document.getElementById("resource-list");
const addBtn = document.getElementById("add-resource-btn");

let allResources = [];
let activeCategory = "All";
let unsubscribeResources = null;

// ============================================================
// PAGINATION — same trade-off as the Wall (see wall.js): loading
// the whole Hub in one shot got expensive as more notes/sheets
// piled up, so the realtime listener is capped to a page size and
// "Load more resources" just asks for a bigger page.
// ============================================================
const RESOURCE_PAGE_SIZE = 30;
let resourcePageLimit = RESOURCE_PAGE_SIZE;
let lastLoadedCount = 0;

export function initResources() {
  buildChips();
  addBtn.addEventListener("click", openAddResourceModal);
  subscribeResources();
}

function subscribeResources() {
  if (unsubscribeResources) unsubscribeResources();
  const q = query(collection(db, "resources"), orderBy("createdAt", "desc"), limit(resourcePageLimit));
  unsubscribeResources = onSnapshot(q, (snap) => {
    lastLoadedCount = snap.size;
    allResources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderResources();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load resources.");
    showToast(message, { details: technical });
  });
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
  renderResourceRows(filtered, resourceList, "No resources shared yet in this category.");

  // A full page came back — there may be more resources beyond it.
  // (Switching category chips only ever filters what's already loaded,
  // so the button reflects the loaded set being capped, not the
  // filtered count.) Only the main Hub list paginates this way — a
  // profile's "Notes" tab uses loadUserResources() below instead.
  if (lastLoadedCount === resourcePageLimit) {
    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.type = "button";
    loadMoreBtn.className = "btn-outline full resource-load-more";
    loadMoreBtn.textContent = "Load more resources";
    loadMoreBtn.addEventListener("click", () => {
      setBtnLoading(loadMoreBtn, true, "Loading…");
      resourcePageLimit += RESOURCE_PAGE_SIZE;
      subscribeResources();
    });
    resourceList.appendChild(loadMoreBtn);
  }
}

/** Shared row renderer — used by the main Notes & Sheet Hub list and by a profile's "Notes" tab. */
function renderResourceRows(resources, listEl, emptyMessage) {
  if (!listEl) return;
  if (!resources.length) {
    listEl.innerHTML = `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const uid = auth.currentUser?.uid;
  listEl.innerHTML = `<div class="flat-list">` + resources.map(r => `
    <div class="resource-row" data-res-id="${r.id}">
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
      ${r.contributorUid === uid ? kebabMenuHtml(r.id, [
        { action: "edit", label: "Edit" },
        { action: "delete", label: "Delete", danger: true }
      ]) : ""}
    </div>
  `).join("") + `</div>`;

  wireKebabMenus(listEl, {
    edit: (resId) => openEditResourceModal(resId),
    delete: (resId) => confirmDialog({
      title: "Delete this resource?",
      text: "This note/sheet link will be removed for everyone in the department. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "resources", resId));
        deleteActivityForResource(resId); // best-effort: drop the "shared a note/sheet" notification too
        showToast("Resource deleted.");
      }
    })
  });
}

/** Every resource a given student has contributed — shared by "My Profile" and a classmate's profile "Notes" tab. */
export async function loadUserResources(uid, listEl) {
  if (!listEl) return;
  try {
    const q = query(collection(db, "resources"), where("contributorUid", "==", uid));
    const snap = await getDocs(q);
    const resources = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toDate?.().getTime() || 0) - (a.createdAt?.toDate?.().getTime() || 0));
    renderResourceRows(resources, listEl, "No notes shared yet.");
  } catch (err) {
    listEl.innerHTML = `<p class="empty-state">Couldn't load notes.</p>`;
    const { message, technical } = friendlyError(err, "Couldn't load notes.");
    showToast(message, { details: technical });
  }
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
    const resRef = await addDoc(collection(db, "resources"), {
      title, category, link,
      contributorName: currentProfile.name,
      contributorUid: auth.currentUser.uid,
      createdAt: serverTimestamp()
    });
    closeModal();
    showToast("Resource shared with the department 🎉");
    logActivity({ type: "resource", text: title, resourceId: resRef.id });
    triggerPush({ type: "resource", text: title, actorName: currentProfile.name, resourceId: resRef.id });
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't share resource.");
    showToast(message, { details: technical });
    setBtnLoading(btn, false);
  }
}

function openEditResourceModal(resId) {
  const r = allResources.find(x => x.id === resId);
  if (!r) return;
  const options = RESOURCE_CATEGORIES.map(c => `<option value="${escapeHtml(c)}" ${r.category === c ? "selected" : ""}>${escapeHtml(c)}</option>`).join("");
  openModal(`
    <h3>Edit Note / Sheet</h3>
    <label class="field">
      <span>Title</span>
      <input type="text" id="res-edit-title" value="${escapeHtml(r.title)}" />
    </label>
    <label class="field">
      <span>Category</span>
      <select id="res-edit-category">${options}</select>
    </label>
    <label class="field">
      <span>Link (Google Drive / OneDrive / etc.)</span>
      <input type="url" id="res-edit-link" value="${escapeHtml(r.link)}" />
    </label>
    <button type="button" class="btn-primary full" id="res-edit-save-btn">Save Changes</button>
  `);
  document.getElementById("res-edit-save-btn").addEventListener("click", async (e) => {
    const title = document.getElementById("res-edit-title").value.trim();
    const category = document.getElementById("res-edit-category").value;
    const link = document.getElementById("res-edit-link").value.trim();
    if (!title || !link) return showToast("Please fill in the title and link.");
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "resources", resId), { title, category, link });
      closeModal();
      showToast("Resource updated.");
    } catch (err) {
      const { message, technical } = friendlyError(err, "Couldn't update resource.");
      showToast(message, { details: technical });
      setBtnLoading(e.currentTarget, false);
    }
  });
}

export function teardownResources() {
  if (unsubscribeResources) unsubscribeResources();
}

// ============================================================
// Jump to a specific resource from the Notification tab. If the current
// category chip filter would hide it, switch back to "All" first.
// ============================================================
export function focusResource(resourceId) {
  const target = allResources.find(r => r.id === resourceId);
  if (!target) { showToast("Couldn't find that resource — it may have been deleted."); return; }

  if (activeCategory !== "All" && activeCategory !== target.category) {
    activeCategory = "All";
    chipRow.querySelectorAll(".chip").forEach(c => c.classList.toggle("active", c.dataset.cat === "All"));
    renderResources();
  }

  requestAnimationFrame(() => {
    const el = resourceList.querySelector(`.resource-row[data-res-id="${resourceId}"]`);
    if (!el) { showToast("Couldn't find that resource — it may have been deleted."); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("post-flash");
    setTimeout(() => el.classList.remove("post-flash"), 1600);
  });
}
