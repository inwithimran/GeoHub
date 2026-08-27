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
import { escapeHtml, timeAgo, showToast } from "./ui-utils.js";

const noticeList = document.getElementById("notice-list");
const adminBox = document.getElementById("admin-notice-box");
const noticeInput = document.getElementById("notice-input");
const noticeUrgent = document.getElementById("notice-urgent");
const noticeSubmit = document.getElementById("notice-submit");
const routineTable = document.getElementById("routine-table");

let unsubscribeNotices = null;

export function initRoutine() {
  // Only show the "post notice" composer to whitelisted CR/admin emails
  if (ADMIN_EMAILS.includes(auth.currentUser.email)) {
    adminBox.classList.remove("hidden");
    noticeSubmit.addEventListener("click", postNotice);
  }

  const q = query(collection(db, "notices"), orderBy("createdAt", "desc"));
  unsubscribeNotices = onSnapshot(q, (snap) => {
    if (snap.empty) {
      noticeList.innerHTML = `<p class="empty-state">No notices posted yet.</p>`;
      return;
    }
    noticeList.innerHTML = snap.docs.map(d => {
      const n = d.data();
      return `
        <div class="notice-item ${n.urgent ? "urgent" : ""}">
          ${n.urgent ? `<span class="urgent-tag">⚠ URGENT</span>` : ""}
          <p>${escapeHtml(n.text)}</p>
          <small>${timeAgo(n.createdAt)}</small>
        </div>`;
    }).join("");
  }, (err) => showToast("Couldn't load notices: " + err.message));

  loadRoutine();
}

async function postNotice() {
  const text = noticeInput.value.trim();
  if (!text) return;
  try {
    await addDoc(collection(db, "notices"), {
      text,
      urgent: noticeUrgent.checked,
      postedBy: auth.currentUser.email,
      createdAt: serverTimestamp()
    });
    noticeInput.value = "";
    noticeUrgent.checked = false;
    showToast("Notice posted.");
  } catch (err) {
    showToast("Couldn't post notice: " + err.message);
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
