// ============================================================
// ROUTINE.JS — Class Routine & Notice Board
// Notices: realtime "notices" collection, posting restricted to
//          emails listed in ADMIN_EMAILS (CR / class admins).
// Routine: single doc at routine/weekly, shape:
//          { Saturday: [{time, subject, room}, ...], Sunday: [...], ... }
//          Create/edit that doc directly in the Firebase Console,
//          or build a small admin form later — reading is wired up here.
// ============================================================
import { db, auth, ADMIN_EMAILS } from "./firebase-config.js";
import {
  collection, addDoc, onSnapshot, query, orderBy, serverTimestamp,
  doc, getDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, timeAgo, fullDate, showToast, setBtnLoading, openModal, avatarInner, nameWithBadge, getCachedProfile } from "./ui-utils.js";
import { currentProfile } from "./auth.js";

/** Resolve the poster's full profile (gender, etc.) from the shared cache when available. */
function posterProfile(n) {
  return getCachedProfile(n.postedByUid) || { uid: n.postedByUid, name: n.postedByName, email: n.postedBy };
}

const noticeList = document.getElementById("notice-list");
const adminBox = document.getElementById("admin-notice-box");
const noticeInput = document.getElementById("notice-input");
const noticeUrgent = document.getElementById("notice-urgent");
const noticeSubmit = document.getElementById("notice-submit");
const routineTable = document.getElementById("routine-table");

let unsubscribeNotices = null;
let latestNotices = [];

export function initRoutine() {
  // Only show the "post notice" composer to whitelisted CR/admin emails
  if (ADMIN_EMAILS.includes(auth.currentUser.email)) {
    adminBox.classList.remove("hidden");
    noticeSubmit.addEventListener("click", postNotice);
  }

  const q = query(collection(db, "notices"), orderBy("createdAt", "desc"));
  unsubscribeNotices = onSnapshot(q, (snap) => {
    if (snap.empty) {
      latestNotices = [];
      noticeList.innerHTML = `<p class="empty-state">No notices posted yet.</p>`;
      return;
    }
    latestNotices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderNotices();
  }, (err) => showToast("Couldn't load notices: " + err.message));

  loadRoutine();
}

function renderNotices() {
  noticeList.innerHTML = `<div class="notice-flat-list">` + latestNotices.map(n => `
    <button type="button" class="notice-row ${n.urgent ? "urgent" : ""}" data-id="${n.id}">
      <div class="notice-row-top">
        <span class="avatar avatar-sm notice-row-avatar">${avatarInner(posterProfile(n))}</span>
        <div class="notice-row-byline">
          <span class="notice-row-name">${nameWithBadge(n.postedByName || "Admin", n.postedBy)}</span>
          <small>${timeAgo(n.createdAt)}</small>
        </div>
        ${n.urgent ? `<span class="urgent-tag">⚠ Urgent</span>` : ""}
      </div>
      <p class="notice-row-text">${escapeHtml(n.text)}</p>
    </button>
  `).join("") + `</div>`;

  noticeList.querySelectorAll(".notice-row").forEach(row =>
    row.addEventListener("click", () => openNoticeDetail(row.dataset.id)));
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
      ${n.urgent ? `<span class="urgent-tag">⚠ URGENT NOTICE</span>` : `<span class="notice-detail-tag">NOTICE</span>`}
      <p class="notice-detail-text">${escapeHtml(n.text)}</p>
    </div>
  `);
}

async function postNotice() {
  const text = noticeInput.value.trim();
  if (!text) return;
  setBtnLoading(noticeSubmit, true, "Posting…");
  try {
    await addDoc(collection(db, "notices"), {
      text,
      urgent: noticeUrgent.checked,
      postedBy: auth.currentUser.email,
      postedByUid: auth.currentUser.uid,
      postedByName: currentProfile ? currentProfile.name : "Admin",
      createdAt: serverTimestamp()
    });
    noticeInput.value = "";
    noticeUrgent.checked = false;
    showToast("Notice posted.");
  } catch (err) {
    showToast("Couldn't post notice: " + err.message);
  } finally {
    setBtnLoading(noticeSubmit, false);
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
