// ============================================================
// ROUTINE.JS — Weekly Class Routine + Notice Board
// Routine: single doc at routine/weekly, shape:
//          { Saturday: [{time, subject, room}, ...], Sunday: [...], ... }
//          Create/edit that doc directly in the Firebase Console,
//          or build a small admin form later — reading is wired up here.
//          The Routine tab itself shows ONLY this weekly table.
// Notices: realtime "notices" collection, posting restricted to
//          emails listed in ADMIN_EMAILS (CR / class admins).
//          Notices no longer live in the Routine tab — they open
//          from the notification bell in the header, which also
//          carries an unread-count badge.
// ============================================================
import { db, auth, ADMIN_EMAILS } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp,
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  escapeHtml, timeAgo, fullDate, showToast, setBtnLoading, openModal,
  avatarInner, nameWithBadge, getCachedProfile, kebabMenuHtml, wireKebabMenus, confirmDialog
} from "./ui-utils.js";
import { currentProfile } from "./auth.js";

/** Resolve the poster's full profile (gender, etc.) from the shared cache when available. */
function posterProfile(n) {
  return getCachedProfile(n.postedByUid) || { uid: n.postedByUid, name: n.postedByName, email: n.postedBy };
}

const routineTable = document.getElementById("routine-table");
const notifBadge = document.getElementById("topbar-notif-badge");

const NOTICES_SEEN_KEY = "geohub_notices_seen_at";

let unsubscribeNotices = null;
let latestNotices = [];

export function initRoutine() {
  const q = query(collection(db, "notices"), orderBy("createdAt", "desc"));
  unsubscribeNotices = onSnapshot(q, (snap) => {
    latestNotices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateNoticeBadge();
    if (document.getElementById("notices-panel-marker")) {
      renderNoticesList(); // panel is open right now — keep it live
    }
  }, (err) => showToast("Couldn't load notices: " + err.message));

  loadRoutine();
}

// ============================================================
// UNREAD BADGE — a notice counts as unread until the panel that
// shows it has been opened at least once after it was posted.
// ============================================================
function updateNoticeBadge() {
  if (!notifBadge) return;
  const seenAt = Number(localStorage.getItem(NOTICES_SEEN_KEY) || 0);
  const unread = latestNotices.filter(n => (n.createdAt?.toDate?.().getTime() || 0) > seenAt).length;
  notifBadge.textContent = unread > 9 ? "9+" : String(unread);
  notifBadge.classList.toggle("hidden", unread === 0);
}

// ============================================================
// NOTIFICATION PANEL — opened from the bell icon in the header.
// Shows the admin composer (for CR/admins only) plus the full
// notice list, each with an edit/delete menu for the poster.
// ============================================================
export function openNoticesPanel() {
  const isAdmin = ADMIN_EMAILS.includes(auth.currentUser.email);
  openModal(`
    <div class="notices-modal" id="notices-panel-marker">
      <h3>Notices</h3>
      ${isAdmin ? `
        <div class="admin-notice-box">
          <span class="admin-notice-label">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            Admin · Post to Notice Board
          </span>
          <textarea id="notice-input" placeholder="Post an urgent notice to the class…" rows="2"></textarea>
          <label class="checkbox-row">
            <input type="checkbox" id="notice-urgent" /> Mark as urgent
          </label>
          <button id="notice-submit" type="button" class="btn-primary full notice-submit-btn">Post Notice</button>
        </div>` : ""}
      <div id="notice-list"><p class="empty-state">Loading notices…</p></div>
    </div>
  `);
  if (isAdmin) document.getElementById("notice-submit").addEventListener("click", postNotice);
  renderNoticesList();

  // Everything currently loaded counts as "seen" the moment the panel opens.
  localStorage.setItem(NOTICES_SEEN_KEY, String(Date.now()));
  updateNoticeBadge();
}

function renderNoticesList() {
  const noticeList = document.getElementById("notice-list");
  if (!noticeList) return;

  if (!latestNotices.length) {
    noticeList.innerHTML = `<p class="empty-state">No notices posted yet.</p>`;
    return;
  }

  const uid = auth.currentUser.uid;
  noticeList.innerHTML = `<div class="notice-flat-list">` + latestNotices.map(n => `
    <div class="notice-row ${n.urgent ? "urgent" : ""}" data-id="${n.id}">
      <div class="notice-row-top">
        <span class="avatar avatar-sm notice-row-avatar">${avatarInner(posterProfile(n))}</span>
        <div class="notice-row-byline">
          <span class="notice-row-name">${nameWithBadge(n.postedByName || "Admin", n.postedBy)}</span>
          <small>${timeAgo(n.createdAt)}</small>
        </div>
        ${n.urgent ? `<span class="urgent-tag"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M10.3 3.9 1.8 18.5a1.8 1.8 0 0 0 1.55 2.7h17.3a1.8 1.8 0 0 0 1.55-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/><circle cx="12" cy="16.3" r="1"/></svg>Urgent</span>` : ""}
        ${n.postedByUid === uid ? kebabMenuHtml(n.id, [
          { action: "edit", label: "Edit Notice" },
          { action: "delete", label: "Delete Notice", danger: true }
        ]) : ""}
      </div>
      <p class="notice-row-text">${escapeHtml(n.text)}</p>
    </div>
  `).join("") + `</div>`;

  noticeList.querySelectorAll(".notice-row").forEach(row =>
    row.addEventListener("click", (e) => {
      if (e.target.closest(".kebab-menu")) return; // let the kebab handle its own click
      openNoticeDetail(row.dataset.id);
    }));

  wireKebabMenus(noticeList, {
    edit: (noticeId) => openEditNoticeModal(noticeId),
    delete: (noticeId) => confirmDialog({
      title: "Delete this notice?",
      text: "This notice will be removed from the board for everyone. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "notices", noticeId));
        showToast("Notice deleted.");
      }
    })
  });
}

function openNoticeDetail(noticeId) {
  const n = latestNotices.find(x => x.id === noticeId);
  if (!n) return;
  openModal(`
    <div class="notice-detail-modal">
      <div class="notice-detail-head">
        <span class="avatar avatar-lg">${avatarInner(posterProfile(n))}</span>
        <div>
          <div class="notice-detail-name">${nameWithBadge(n.postedByName || "Admin", n.postedBy)}</div>
          <small>${fullDate(n.createdAt) || "Just now"}</small>
        </div>
      </div>
      ${n.urgent ? `<span class="urgent-tag"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4"/><path d="M10.3 3.9 1.8 18.5a1.8 1.8 0 0 0 1.55 2.7h17.3a1.8 1.8 0 0 0 1.55-2.7L13.7 3.9a1.8 1.8 0 0 0-3.4 0z"/><circle cx="12" cy="16.3" r="1"/></svg>Urgent Notice</span>` : `<span class="notice-detail-tag">NOTICE</span>`}
      <p class="notice-detail-text">${escapeHtml(n.text)}</p>
    </div>
  `);
}

function openEditNoticeModal(noticeId) {
  const n = latestNotices.find(x => x.id === noticeId);
  if (!n) return;
  openModal(`
    <h3>Edit Notice</h3>
    <label class="field">
      <span>Notice text</span>
      <textarea id="notice-edit-input" rows="4">${escapeHtml(n.text)}</textarea>
    </label>
    <label class="checkbox-row">
      <input type="checkbox" id="notice-edit-urgent" ${n.urgent ? "checked" : ""} /> Mark as urgent
    </label>
    <button type="button" class="btn-primary full" id="notice-edit-save-btn">Save Changes</button>
  `);
  document.getElementById("notice-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("notice-edit-input").value.trim();
    if (!text) return showToast("Notice text can't be empty.");
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "notices", noticeId), {
        text, urgent: document.getElementById("notice-edit-urgent").checked
      });
      showToast("Notice updated.");
      openNoticesPanel();
    } catch (err) {
      showToast("Couldn't update notice: " + err.message);
      setBtnLoading(e.currentTarget, false);
    }
  });
}

async function postNotice() {
  const input = document.getElementById("notice-input");
  const urgent = document.getElementById("notice-urgent");
  const submit = document.getElementById("notice-submit");
  const text = input.value.trim();
  if (!text) return;
  setBtnLoading(submit, true, "Posting…");
  try {
    await addDoc(collection(db, "notices"), {
      text,
      urgent: urgent.checked,
      postedBy: auth.currentUser.email,
      postedByUid: auth.currentUser.uid,
      postedByName: currentProfile ? currentProfile.name : "Admin",
      createdAt: serverTimestamp()
    });
    input.value = "";
    urgent.checked = false;
    showToast("Notice posted.");
  } catch (err) {
    showToast("Couldn't post notice: " + err.message);
  } finally {
    setBtnLoading(submit, false);
  }
}

async function loadRoutine() {
  try {
    const snap = await getDoc(doc(db, "routine", "weekly"));
    if (!snap.exists()) {
      routineTable.innerHTML = `<p class="empty-state">Routine has not been published yet.</p>`;
      return;
    }
    const data = snap.data();
    const dayOrder = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
    let html = "";
    dayOrder.forEach(day => {
      const slots = data[day];
      if (!slots || !slots.length) return;
      html += `<div class="routine-day"><h4>${day}</h4>` +
        slots.map(s => `
          <div class="routine-slot">
            <span>${escapeHtml(s.time)}</span>
            <span>${escapeHtml(s.subject)}${s.room ? " · " + escapeHtml(s.room) : ""}</span>
          </div>`).join("") +
        `</div>`;
    });
    routineTable.innerHTML = html || `<p class="empty-state">Routine has not been published yet.</p>`;
  } catch (err) {
    routineTable.innerHTML = `<p class="empty-state">Couldn't load routine.</p>`;
  }
}

export function teardownRoutine() {
  if (unsubscribeNotices) unsubscribeNotices();
}
