import { db, auth, ADMIN_EMAILS } from "./firebase-config.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import {
  collection, addDoc, updateDoc, deleteDoc, doc, query, orderBy, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  escapeHtml, escapeAttr, timeAgo, showToast, setBtnLoading, openModal, closeModal,
  kebabMenuHtml, wireKebabMenus, confirmDialog, skeletonRowsHtml, friendlyError
} from "./ui-utils.js";
import { currentProfile } from "./auth.js";
import { logActivity, deleteActivityForDeadline } from "./routine.js";
import { triggerPush } from "./push-trigger.js";

const DEADLINE_TYPES = ["Assignment", "Quiz", "Exam", "Other"];
const TITLE_LIMIT = 200;
const NOTES_LIMIT = 1000;

const listEl = document.getElementById("deadline-list");
const addBtn = document.getElementById("add-deadline-btn");

let allDeadlines = [];
let unsubscribeDeadlines = null;
let deadlinesLoaded = false;

export function initDeadlines() {
  if (!listEl) return;

  const isAdmin = !!(auth.currentUser && ADMIN_EMAILS.includes(auth.currentUser.email));
  if (addBtn) {
    addBtn.classList.toggle("hidden", !isAdmin);
    if (!addBtn.dataset.wired) {
      addBtn.dataset.wired = "1";
      addBtn.addEventListener("click", openAddDeadlineModal);
    }
  }

  if (unsubscribeDeadlines) return; 
  const q = query(collection(db, "deadlines"), orderBy("dueAt", "asc"));
  unsubscribeDeadlines = onSnapshotWithRetry(q, (snap) => {
    allDeadlines = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    deadlinesLoaded = true;
    renderDeadlines();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load deadlines.");
    showToast(message, { details: technical });
  });
}

export function teardownDeadlines() {
  if (unsubscribeDeadlines) { unsubscribeDeadlines(); unsubscribeDeadlines = null; }
  allDeadlines = [];
  deadlinesLoaded = false;
}

function typeGlyph(type) {
  switch (type) {
    case "Exam": return "📕";
    case "Quiz": return "📝";
    case "Assignment": return "📄";
    default: return "📌";
  }
}

function dueLabel(dueAt) {
  const due = dueAt?.toDate?.();
  if (!due) return "";
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const dueDayStart = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  const nowDayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDiff = Math.round((dueDayStart - nowDayStart) / dayMs);

  if (dayDiff < 0) return `Overdue by ${Math.abs(dayDiff)} day${Math.abs(dayDiff) === 1 ? "" : "s"}`;
  if (dayDiff === 0) return "Due today";
  if (dayDiff === 1) return "Due tomorrow";
  return `Due in ${dayDiff} days`;
}

function formatDueDate(dueAt) {
  const due = dueAt?.toDate?.();
  if (!due) return "";
  return due.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function renderDeadlines() {
  if (!listEl) return;
  if (!allDeadlines.length) {
    listEl.innerHTML = deadlinesLoaded
      ? `<p class="empty-state">No upcoming deadlines posted yet.</p>`
      : skeletonRowsHtml(2);
    return;
  }

  const isOwner = !!(auth.currentUser && ADMIN_EMAILS.includes(auth.currentUser.email));
  listEl.innerHTML = `<div class="flat-list">` + allDeadlines.map(d => {
    const overdue = (d.dueAt?.toDate?.() || 0) < new Date();
    return `
    <div class="deadline-row ${overdue ? "overdue" : ""}" data-deadline-id="${d.id}">
      <div class="deadline-row-icon">${typeGlyph(d.type)}</div>
      <div class="deadline-row-info">
        <span class="deadline-type-chip">${escapeHtml(d.type || "Other")}</span>
        <h4>${escapeHtml(d.title)}</h4>
        <div class="res-meta">${d.course ? escapeHtml(d.course) + " · " : ""}${escapeHtml(formatDueDate(d.dueAt))}</div>
      </div>
      <span class="deadline-due-badge ${overdue ? "overdue" : ""}">${escapeHtml(dueLabel(d.dueAt))}</span>
      ${isOwner ? kebabMenuHtml(d.id, [
        { action: "edit", label: "Edit Deadline" },
        { action: "delete", label: "Delete Deadline", danger: true }
      ]) : ""}
    </div>`;
  }).join("") + `</div>`;

  listEl.querySelectorAll(".deadline-row").forEach(row =>
    row.addEventListener("click", (e) => {
      if (e.target.closest(".kebab-menu")) return;
      openDeadlineDetail(row.dataset.deadlineId);
    }));

  wireKebabMenus(listEl, {
    edit: (id) => openEditDeadlineModal(id),
    delete: (id) => confirmDialog({
      title: "Delete this deadline?",
      text: "This will be removed from the tracker for everyone. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "deadlines", id));
        deleteActivityForDeadline(id); 
        showToast("Deadline deleted.");
      }
    })
  });
}

function openDeadlineDetail(id) {
  const d = allDeadlines.find(x => x.id === id);
  if (!d) return;
  openModal(`
    <span class="deadline-type-chip">${escapeHtml(d.type || "Other")}</span>
    <h3 style="margin-top:8px;">${escapeHtml(d.title)}</h3>
    ${d.course ? `<p class="res-meta" style="margin-bottom:8px;">${escapeHtml(d.course)}</p>` : ""}
    <p class="notice-detail-text"><strong>${escapeHtml(formatDueDate(d.dueAt))}</strong> — ${escapeHtml(dueLabel(d.dueAt))}</p>
    ${d.notes ? `<p class="notice-detail-text">${escapeHtml(d.notes)}</p>` : ""}
    <small>Posted by ${escapeHtml(d.postedByName || "Admin")} · ${timeAgo(d.createdAt)}</small>
  `);
}

function typeOptionsHtml(selected) {
  return DEADLINE_TYPES.map(t => `<option value="${t}" ${t === selected ? "selected" : ""}>${t}</option>`).join("");
}

function parseLocalDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function openAddDeadlineModal() {
  openModal(`
    <h3>Add a Deadline</h3>
    <label class="field">
      <span>Title</span>
      <input type="text" id="dl-title" maxlength="${TITLE_LIMIT}" placeholder="e.g. Climatology Assignment 2 Submission" />
    </label>
    <label class="field">
      <span>Type</span>
      <select id="dl-type">${typeOptionsHtml("Assignment")}</select>
    </label>
    <label class="field">
      <span>Course / Subject (optional)</span>
      <input type="text" id="dl-course" placeholder="e.g. Cartography" />
    </label>
    <label class="field">
      <span>Due date &amp; time</span>
      <input type="datetime-local" id="dl-due" />
    </label>
    <label class="field">
      <span>Notes (optional)</span>
      <textarea id="dl-notes" rows="3" maxlength="${NOTES_LIMIT}" placeholder="Submission format, room number, syllabus, etc."></textarea>
    </label>
    <p id="dl-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="dl-submit-btn">Add Deadline</button>
  `);
  document.getElementById("dl-submit-btn").addEventListener("click", submitDeadline);
}

async function submitDeadline() {
  const btn = document.getElementById("dl-submit-btn");
  const errorEl = document.getElementById("dl-error");
  const title = document.getElementById("dl-title").value.trim();
  const type = document.getElementById("dl-type").value;
  const course = document.getElementById("dl-course").value.trim();
  const notes = document.getElementById("dl-notes").value.trim();
  const dueDate = parseLocalDateTime(document.getElementById("dl-due").value);

  if (!title) { errorEl.textContent = "Please enter a title."; return; }
  if (!dueDate) { errorEl.textContent = "Please pick a due date and time."; return; }
  errorEl.textContent = "";

  setBtnLoading(btn, true, "Adding…");
  try {
    const dlRef = await addDoc(collection(db, "deadlines"), {
      title, type, course, notes,
      dueAt: Timestamp.fromDate(dueDate),
      postedByUid: auth.currentUser.uid,
      postedByName: currentProfile ? currentProfile.name : "Admin",
      createdAt: serverTimestamp(),
      remindedAt: null
    });
    closeModal();
    showToast("Deadline added.");
    logActivity({ type: "deadline", text: title, deadlineId: dlRef.id });
    triggerPush({ type: "deadline", text: title, urgent: false, deadlineId: dlRef.id });
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't add deadline.");
    errorEl.textContent = message;
    if (technical) console.warn(technical);
    setBtnLoading(btn, false);
  }
}

function openEditDeadlineModal(id) {
  const d = allDeadlines.find(x => x.id === id);
  if (!d) return;
  const due = d.dueAt?.toDate?.();
  const localValue = due
    ? new Date(due.getTime() - due.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  openModal(`
    <h3>Edit Deadline</h3>
    <label class="field">
      <span>Title</span>
      <input type="text" id="dl-edit-title" maxlength="${TITLE_LIMIT}" value="${escapeAttr(d.title)}" />
    </label>
    <label class="field">
      <span>Type</span>
      <select id="dl-edit-type">${typeOptionsHtml(d.type)}</select>
    </label>
    <label class="field">
      <span>Course / Subject (optional)</span>
      <input type="text" id="dl-edit-course" value="${escapeAttr(d.course || "")}" />
    </label>
    <label class="field">
      <span>Due date &amp; time</span>
      <input type="datetime-local" id="dl-edit-due" value="${localValue}" />
    </label>
    <label class="field">
      <span>Notes (optional)</span>
      <textarea id="dl-edit-notes" rows="3" maxlength="${NOTES_LIMIT}">${escapeHtml(d.notes || "")}</textarea>
    </label>
    <p id="dl-edit-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="dl-edit-save-btn">Save Changes</button>
  `);
  document.getElementById("dl-edit-save-btn").addEventListener("click", async (e) => {
    const errorEl = document.getElementById("dl-edit-error");
    const title = document.getElementById("dl-edit-title").value.trim();
    const type = document.getElementById("dl-edit-type").value;
    const course = document.getElementById("dl-edit-course").value.trim();
    const notes = document.getElementById("dl-edit-notes").value.trim();
    const dueDate = parseLocalDateTime(document.getElementById("dl-edit-due").value);
    if (!title) { errorEl.textContent = "Please enter a title."; return; }
    if (!dueDate) { errorEl.textContent = "Please pick a due date and time."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      const dueChanged = !d.dueAt || d.dueAt.toDate().getTime() !== dueDate.getTime();
      await updateDoc(doc(db, "deadlines", id), {
        title, type, course, notes,
        dueAt: Timestamp.fromDate(dueDate),
        ...(dueChanged ? { remindedAt: null } : {})
      });
      closeModal();
      showToast("Deadline updated.");
    } catch (err) {
      const { message, technical } = friendlyError(err, "Couldn't update deadline.");
      errorEl.textContent = message;
      if (technical) console.warn(technical);
      setBtnLoading(e.currentTarget, false);
    }
  });
}

export function focusDeadline(deadlineId) {
  requestAnimationFrame(() => {
    const el = listEl?.querySelector(`.deadline-row[data-deadline-id="${deadlineId}"]`);
    if (!el) { showToast("Couldn't find that deadline — it may have been deleted."); return; }
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.add("post-flash");
    setTimeout(() => el.classList.remove("post-flash"), 1600);
  });
}
