// ============================================================
// RESOURCES.JS — Central Note & Sheet Hub
// Resources live in the "resources" collection:
// { title, category, contributorName, contributorUid, link, openCount, createdAt }
// openCount is a simple view/download tally (see bumpResourceOpenCount()),
// bumped by ANY signed-in student who taps Open/Download — not just the
// contributor — so the Hub can surface which notes are actually useful,
// not just recently posted.
// ============================================================
import { db, auth, RESOURCE_CATEGORIES } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, setDoc, query, where, orderBy, limit, getDocs, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import { currentProfile } from "./auth.js";
import {
  showToast, escapeHtml, openModal, closeModal, timeAgo, setBtnLoading,
  kebabMenuHtml, wireKebabMenus, confirmDialog, friendlyError
} from "./ui-utils.js";
import { logActivity, deleteActivityForResource } from "./routine.js";
import { triggerPush } from "./push-trigger.js";
import { uploadImage, uploadRawFile } from "./cloudinary.js";

const MAX_RESOURCE_FILE_BYTES = 20 * 1024 * 1024;

function isAcceptableResourceFile(file) {
  if (!file) return false;
  if (file.size > MAX_RESOURCE_FILE_BYTES) {
    showToast(`"${file.name}" is too large (max 20MB).`);
    return false;
  }
  return true;
}

function extOf(name = "") {
  const match = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(name);
  return match ? match[1].toLowerCase() : "";
}

const chipRow = document.getElementById("resource-categories");
const resourceList = document.getElementById("resource-list");
const addBtn = document.getElementById("add-resource-btn");
const searchInput = document.getElementById("resource-search");

let allResources = [];
let activeCategory = "All";
let unsubscribeResources = null;

// ============================================================
// "SAVE FOR LATER" BOOKMARKS — a student's own private shortlist, kept
// live via users/{uid}/bookmarks/{resourceId} (see firestore.rules —
// owner-only). Each bookmark doc carries a small denormalized copy of
// the resource's title/category/link/etc. (not just the id) so the
// Saved chip's list renders straight from this listener, without
// depending on that resource still being within the main Hub's
// currently-loaded page (see RESOURCE_PAGE_SIZE below) or even still
// existing in `allResources` at all.
// ============================================================
const SAVED_CHIP_KEY = "__saved__";
let savedResources = [];
let savedResourceIds = new Set();
let unsubscribeBookmarks = null;

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
  searchInput?.addEventListener("input", renderResources);
  subscribeResources();
  subscribeBookmarks();
}

function subscribeBookmarks() {
  if (unsubscribeBookmarks) return;
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const q = query(collection(db, "users", uid, "bookmarks"), orderBy("savedAt", "desc"));
  unsubscribeBookmarks = onSnapshotWithRetry(q, (snap) => {
    savedResources = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    savedResourceIds = new Set(savedResources.map(r => r.id));
    renderResources();
  }, (err) => {
    console.warn("Couldn't load saved resources:", err.message);
  });
}

async function toggleBookmark(resId, alreadySaved) {
  const uid = auth.currentUser?.uid;
  if (!uid || !resId) return;
  const ref = doc(db, "users", uid, "bookmarks", resId);
  try {
    if (alreadySaved) {
      await deleteDoc(ref);
    } else {
      const r = allResources.find(x => x.id === resId) || savedResources.find(x => x.id === resId);
      if (!r) return;
      await setDoc(ref, {
        resourceId: resId,
        title: r.title,
        category: r.category,
        link: r.link,
        sourceType: r.sourceType || null,
        fileExt: r.fileExt || null,
        contributorName: r.contributorName || null,
        savedAt: serverTimestamp()
      });
    }
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't update your Saved list.");
    showToast(message, { details: technical });
  }
}

function bookmarkBtnHtml(resId, saved) {
  return `
    <button type="button" class="bookmark-toggle-btn ${saved ? "active" : ""}" data-res-id="${resId}" data-saved="${saved ? "1" : "0"}" aria-pressed="${saved}" aria-label="${saved ? "Remove from Saved" : "Save for later"}">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="${saved ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21 12 16l-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
    </button>`;
}

function subscribeResources() {
  if (unsubscribeResources) unsubscribeResources();
  const q = query(collection(db, "resources"), orderBy("createdAt", "desc"), limit(resourcePageLimit));
  unsubscribeResources = onSnapshotWithRetry(q, (snap) => {
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
  ).join("") + `<button class="chip" data-cat="${SAVED_CHIP_KEY}">🔖 Saved</button>`;
  chipRow.querySelectorAll(".chip").forEach(chip => {
    chip.addEventListener("click", () => {
      activeCategory = chip.dataset.cat;
      chipRow.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      renderResources();
    });
  });
}

function matchesResourceSearch(r, term) {
  if (!term) return true;
  return (r.title || "").toLowerCase().includes(term) ||
    (r.category || "").toLowerCase().includes(term) ||
    (r.contributorName || "").toLowerCase().includes(term);
}

function renderResources() {
  const term = (searchInput?.value || "").trim().toLowerCase();

  if (activeCategory === SAVED_CHIP_KEY) {
    const savedFiltered = savedResources.filter(r => matchesResourceSearch(r, term));
    renderResourceRows(savedFiltered, resourceList, term ? "No saved notes match your search." : "No saved notes yet — tap the bookmark icon on any resource to save it for later.", { savedView: true });
    return;
  }

  const filtered = (activeCategory === "All"
    ? allResources
    : allResources.filter(r => r.category === activeCategory)
  ).filter(r => matchesResourceSearch(r, term));
  renderResourceRows(filtered, resourceList, term ? "No resources match your search." : "No resources shared yet in this category.");

  if (!term && lastLoadedCount === resourcePageLimit) {
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

function bumpResourceOpenCount(resId) {
  updateDoc(doc(db, "resources", resId), { openCount: increment(1) }).catch(() => {
  });
}

function renderResourceRows(resources, listEl, emptyMessage, { savedView = false } = {}) {
  if (!listEl) return;
  if (!resources.length) {
    listEl.innerHTML = `<p class="empty-state">${escapeHtml(emptyMessage)}</p>`;
    return;
  }

  const uid = auth.currentUser?.uid;
  listEl.innerHTML = `<div class="flat-list">` + resources.map(r => {
    const saved = savedView ? true : savedResourceIds.has(r.id);
    const metaLine = savedView
      ? `${r.contributorName ? "Shared by " + escapeHtml(r.contributorName) + " · " : ""}Saved ${timeAgo(r.savedAt)}`
      : `Shared by ${escapeHtml(r.contributorName)} · ${timeAgo(r.createdAt)}`;
    const openCount = r.openCount || 0;
    const openCountLabel = r.sourceType === "upload" ? "download" : "view";
    return `
    <div class="resource-row" data-res-id="${r.id}">
      <div class="resource-row-icon">${fileGlyph(r)}</div>
      <div class="resource-row-info">
        <span class="res-cat">${escapeHtml(r.category)}</span>
        <h4>${escapeHtml(r.title)}</h4>
        <div class="res-meta">${metaLine}${openCount > 0 ? ` · <span class="res-open-count" title="${openCount} ${openCountLabel}${openCount === 1 ? "" : "s"}">${openCount} ${openCountLabel}${openCount === 1 ? "" : "s"}</span>` : ""}</div>
      </div>
      ${bookmarkBtnHtml(r.id, saved)}
      <a class="res-link" href="${escapeHtml(r.link)}" target="_blank" rel="noopener" data-res-open-id="${r.id}">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3h7v7"/><path d="M10 14 21 3"/><path d="M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6"/></svg>
        <span>${r.sourceType === "upload" ? "Download" : "Open"}</span>
      </a>
      ${!savedView && r.contributorUid === uid ? kebabMenuHtml(r.id, [
        { action: "edit", label: "Edit" },
        { action: "delete", label: "Delete", danger: true }
      ]) : ""}
    </div>
  `;
  }).join("") + `</div>`;

  listEl.querySelectorAll(".bookmark-toggle-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      toggleBookmark(btn.dataset.resId, btn.dataset.saved === "1");
    });
  });

  listEl.querySelectorAll(".res-link[data-res-open-id]").forEach(a => {
    a.addEventListener("click", () => bumpResourceOpenCount(a.dataset.resOpenId));
  });

  if (savedView) return;

  wireKebabMenus(listEl, {
    edit: (resId) => openEditResourceModal(resId),
    delete: (resId) => confirmDialog({
      title: "Delete this resource?",
      text: "This note/sheet link will be removed for everyone in the department. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "resources", resId));
        deleteActivityForResource(resId);
        showToast("Resource deleted.");
      }
    })
  });
}

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

function fileGlyph(r) {
  if (r.sourceType === "upload" && r.fileExt) {
    return escapeHtml(r.fileExt.slice(0, 4).toUpperCase());
  }
  return escapeHtml((r.category?.[0] || "•").toUpperCase());
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

    <div class="res-source-toggle" role="tablist">
      <button type="button" class="res-source-btn active" data-source="link" role="tab" aria-selected="true">Add a Link</button>
      <button type="button" class="res-source-btn" data-source="upload" role="tab" aria-selected="false">Upload a File</button>
    </div>

    <div id="res-link-wrap" class="field">
      <span>Link (Google Drive / OneDrive / etc.)</span>
      <input type="url" id="res-link" placeholder="https://drive.google.com/…" />
    </div>
    <div id="res-upload-wrap" class="field hidden">
      <span>File (PDF, Word, Excel, PowerPoint, image, up to 20MB)</span>
      <input type="file" id="res-file-input" class="hidden" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.zip,image/*" />
      <button type="button" class="btn-outline full res-file-trigger" id="res-file-trigger">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <span id="res-file-trigger-label">Choose a file…</span>
      </button>
    </div>

    <button type="button" class="btn-primary full" id="res-submit-btn">Publish Resource</button>
  `);
  wireResourceSourceToggle();
  document.getElementById("res-submit-btn").addEventListener("click", submitResource);
}

function wireResourceSourceToggle() {
  const toggleBtns = document.querySelectorAll(".res-source-btn");
  const linkWrap = document.getElementById("res-link-wrap");
  const uploadWrap = document.getElementById("res-upload-wrap");
  const fileInput = document.getElementById("res-file-input");
  const fileTrigger = document.getElementById("res-file-trigger");
  const fileLabel = document.getElementById("res-file-trigger-label");

  toggleBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      toggleBtns.forEach(b => { b.classList.toggle("active", b === btn); b.setAttribute("aria-selected", String(b === btn)); });
      const isUpload = btn.dataset.source === "upload";
      linkWrap.classList.toggle("hidden", isUpload);
      uploadWrap.classList.toggle("hidden", !isUpload);
    });
  });

  fileTrigger?.addEventListener("click", () => fileInput.click());
  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!isAcceptableResourceFile(file)) { fileInput.value = ""; return; }
    fileLabel.textContent = file.name;
  });
}

async function submitResource() {
  const btn = document.getElementById("res-submit-btn");
  const title = document.getElementById("res-title").value.trim();
  const category = document.getElementById("res-category").value;
  const isUploadMode = document.querySelector('.res-source-btn[data-source="upload"]').classList.contains("active");

  if (!title) return showToast("Please fill in the title.");

  let link, sourceType, fileExt = null, fileName = null;
  if (isUploadMode) {
    const file = document.getElementById("res-file-input").files?.[0];
    if (!file) return showToast("Please choose a file to upload.");
    if (!isAcceptableResourceFile(file)) return;
    setBtnLoading(btn, true, "Uploading…");
    try {
      link = file.type?.startsWith("image/")
        ? await uploadImage(file, { maxDim: 2000, quality: 0.85, folder: "geohub/resources" })
        : await uploadRawFile(file, { folder: "geohub/resources" });
    } catch (err) {
      const { message, technical } = friendlyError(err, "Couldn't upload file.");
      showToast(message, { details: technical });
      setBtnLoading(btn, false);
      return;
    }
    sourceType = "upload";
    fileExt = extOf(file.name);
    fileName = file.name;
  } else {
    link = document.getElementById("res-link").value.trim();
    if (!link) return showToast("Please fill in the link.");
    sourceType = "link";
  }

  setBtnLoading(btn, true, "Publishing…");
  try {
    const resRef = await addDoc(collection(db, "resources"), {
      title, category, link, sourceType, fileExt, fileName,
      contributorName: currentProfile.name,
      contributorUid: auth.currentUser.uid,
      openCount: 0,
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
  if (unsubscribeBookmarks) { unsubscribeBookmarks(); unsubscribeBookmarks = null; }
  savedResources = [];
  savedResourceIds = new Set();
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
