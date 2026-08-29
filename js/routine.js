// ============================================================
// ROUTINE.JS — Weekly Class Routine + the "Notices & Notifications"
// page (its own route — NOT a modal/backdrop sheet — reached by
// tapping the bell icon in the header).
//
// That page has two header tabs:
//   • Notice       — the CR/admin notice board (unchanged data model,
//                     just rendered into a page section instead of a
//                     bottom sheet).
//   • Notification — a live activity feed ("X posted on the Wall",
//                     "Y shared a note", …), backed by a new "activity"
//                     Firestore collection. Other modules call the
//                     exported logActivity() after a successful action
//                     they want to show up here (see wall.js, resources.js).
//
// Routine: single doc at routine/weekly, shape:
//          { Saturday: [{time, subject, room}, ...], Sunday: [...], ... }
//          Create/edit that doc directly in the Firebase Console,
//          or build a small admin form later — reading is wired up here.
// Notices: realtime "notices" collection, posting restricted to
//          emails listed in ADMIN_EMAILS (CR / class admins).
// ============================================================
import { db, auth, ADMIN_EMAILS } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, onSnapshot, query, where, orderBy, limit, serverTimestamp,
  doc, getDoc, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  escapeHtml, timeAgo, fullDate, showToast, setBtnLoading, openModal, closeModal,
  avatarInner, nameWithBadge, getCachedProfile, kebabMenuHtml, wireKebabMenus, confirmDialog
} from "./ui-utils.js";
import { currentProfile } from "./auth.js";
import { triggerPush } from "./push-trigger.js";

/** Resolve a poster's full profile (gender, photo, etc.) from the shared cache when available. */
function posterProfile(uid, fallbackName, fallbackEmail) {
  return getCachedProfile(uid) || { uid, name: fallbackName, email: fallbackEmail };
}

const routineTable = document.getElementById("routine-table");
const notifBadge = document.getElementById("topbar-notif-badge");

const NOTICES_SEEN_KEY = "geohub_notices_seen_at";
const ACTIVITY_SEEN_KEY = "geohub_activity_seen_at";

let unsubscribeNotices = null;
let unsubscribeActivityPublic = null;
let unsubscribeActivityPrivate = null;
let latestNotices = [];
// The "activity" feed is split into two separately-queried, separately-
// listened slices — see the big comment above initRoutine() for why this
// can't be a single onSnapshot the way `notices` is.
let latestActivityPublic = [];   // type in [post, resource, notice] — visible to everyone
let latestActivityPrivate = [];  // type in [comment, like] targeted at ME specifically
let activityFeedError = null;    // last onSnapshot error message, if either half of the feed is currently down
let noticesPageWired = false;

// app.js hands us its router (goToRoute) so clicking a notification can
// jump to another page (Wall / Notes hub / Notice tab), the same pattern
// profile-view.js uses for registerProfilePageRouter.
let goToRouteRef = null;
export function registerNotificationsRouter(goToRoute) { goToRouteRef = goToRoute; }

/** Merge the two slices back into one feed, newest first, capped like the old single query was. */
function mergedActivity() {
  return [...latestActivityPublic, ...latestActivityPrivate]
    .sort((a, b) => (b.createdAt?.toDate?.().getTime() || 0) - (a.createdAt?.toDate?.().getTime() || 0))
    .slice(0, 60);
}

/**
 * "comment" and "like" activity entries are a private "someone interacted
 * with YOUR post" notification — they should only ever be visible to the
 * post's author, never to the whole department. "post" / "resource" /
 * "notice" stay public. (Firestore rules also enforce this server-side —
 * see the query split below for why the client has to respect the same
 * split; this filter is just so the client trusts nothing that slips
 * through.)
 */
function visibleToMe(a) {
  if (a.type === "comment" || a.type === "like") {
    return a.targetUid === auth.currentUser?.uid;
  }
  return true;
}

export function initRoutine() {
  const q = query(collection(db, "notices"), orderBy("createdAt", "desc"));
  unsubscribeNotices = onSnapshot(q, (snap) => {
    latestNotices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    updateNoticeBadge();
    renderNoticeTabBody();
  }, (err) => showToast("Couldn't load notices: " + err.message));

  // ----------------------------------------------------------------
  // IMPORTANT: this used to be ONE onSnapshot over the whole "activity"
  // collection with no `where` clause. That silently broke live updates
  // the moment a single "comment" or "like" doc existed anywhere: Firestore
  // security rules are NOT filters — "rules are not filters" is the
  // official Firestore behavior (a query is rejected outright, not
  // filtered down, if it could possibly return a document the rules
  // wouldn't let the caller read). Since comment/like docs are only
  // readable by their targetUid, an unfiltered query over the whole
  // collection became unsafe the instant one existed, so Firestore
  // returned permission-denied for EVERY user's listener — and the old
  // error handler here swallowed that silently as "no activity yet",
  // which is exactly why the badge/list stopped updating live while push
  // (a completely separate, server-side FCM path that never touches these
  // rules) kept working fine. Splitting into two rule-safe queries fixes
  // it: each one only asks for documents the rules already guarantee it
  // can read.
  //
  // NOTE: both queries below combine a `where` with `orderBy` on a
  // different field, so Firestore will require a composite index for
  // each the first time they run — open the browser console, click the
  // link in the error it prints, and it self-creates in a minute. Safe
  // to ignore once created; it only needs doing once per Firebase project.
  // ----------------------------------------------------------------
  const publicQ = query(
    collection(db, "activity"),
    where("type", "in", ["post", "resource", "notice"]),
    orderBy("createdAt", "desc"),
    limit(60)
  );
  unsubscribeActivityPublic = onSnapshot(publicQ, (snap) => {
    latestActivityPublic = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    activityFeedError = null;
    updateNoticeBadge();
    renderActivityList();
  }, (err) => {
    console.error("Couldn't load public activity feed:", err.code, err.message);
    // Surfaced as a toast (not just console.error) because on a phone there's
    // no devtools to check — this is the single most useful diagnostic if the
    // Notification tab ever goes blank again: it will say either
    // "permission-denied" (rules/query mismatch) or "failed-precondition"
    // (missing Firestore composite index — the error also contains a direct
    // link to create it, visible by tapping "Copy error" in most browsers'
    // address bar / share sheet, or by reading it over someone's desktop).
    activityFeedError = err.code || err.message;
    showToast("Notification feed error: " + activityFeedError);
    latestActivityPublic = [];
    renderActivityList();
  });

  const uid = auth.currentUser?.uid;
  if (uid) {
    const privateQ = query(
      collection(db, "activity"),
      where("targetUid", "==", uid),
      orderBy("createdAt", "desc"),
      limit(60)
    );
    unsubscribeActivityPrivate = onSnapshot(privateQ, (snap) => {
      latestActivityPrivate = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      activityFeedError = null;
      updateNoticeBadge();
      renderActivityList();
    }, (err) => {
      console.error("Couldn't load your personal activity feed:", err.code, err.message);
      activityFeedError = err.code || err.message;
      showToast("Notification feed error: " + activityFeedError);
      latestActivityPrivate = [];
      renderActivityList();
    });
  }

  loadRoutine();
  wireNoticesPageTabs();
}

// ============================================================
// UNREAD BADGE — counts both unseen notices AND unseen activity
// entries; either kind lights up the bell. Both are marked "seen"
// together the moment the Notices & Notifications page is opened.
// ============================================================
function updateNoticeBadge() {
  if (!notifBadge) return;
  const noticesSeenAt = Number(localStorage.getItem(NOTICES_SEEN_KEY) || 0);
  const activitySeenAt = Number(localStorage.getItem(ACTIVITY_SEEN_KEY) || 0);
  const unreadNotices = latestNotices.filter(n => (n.createdAt?.toDate?.().getTime() || 0) > noticesSeenAt).length;
  const unreadActivity = mergedActivity().filter(visibleToMe).filter(a => (a.createdAt?.toDate?.().getTime() || 0) > activitySeenAt).length;
  const unread = unreadNotices + unreadActivity;
  notifBadge.textContent = unread > 9 ? "9+" : String(unread);
  notifBadge.classList.toggle("hidden", unread === 0);
}

/** Called by app.js's router the moment the Notices & Notifications page is opened. */
export function markNoticesPageSeen() {
  localStorage.setItem(NOTICES_SEEN_KEY, String(Date.now()));
  localStorage.setItem(ACTIVITY_SEEN_KEY, String(Date.now()));
  updateNoticeBadge();
}

// ============================================================
// PAGE SHELL — tab switching between Notice / Notification.
// Wired once; the two panels themselves are re-rendered live by
// the realtime listeners above whenever their data changes.
// ============================================================
function wireNoticesPageTabs() {
  if (noticesPageWired) return;
  const section = document.getElementById("section-notices");
  if (!section) return;
  noticesPageWired = true;

  const tabBtns = section.querySelectorAll(".notices-page-tab-btn");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.toggle("active", b === btn));
      section.querySelectorAll(".notices-page-panel").forEach(p =>
        p.classList.toggle("active", p.dataset.panel === btn.dataset.tab));
    });
  });
}

// ============================================================
// NOTICE TAB
// ============================================================
function renderNoticeTabBody() {
  const host = document.getElementById("notice-tab-body");
  if (!host) return; // page not in the DOM yet

  if (!host.dataset.shellBuilt) {
    const isAdmin = !!(auth.currentUser && ADMIN_EMAILS.includes(auth.currentUser.email));
    host.dataset.shellBuilt = "1";
    host.innerHTML = `
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
          <button id="view-reports-btn" type="button" class="btn-outline full">
            <span id="view-reports-label">Reported Posts</span>
          </button>
        </div>` : ""}
      <div id="notice-list"><p class="empty-state">Loading notices…</p></div>
    `;
    if (isAdmin) {
      document.getElementById("notice-submit").addEventListener("click", postNotice);
      document.getElementById("view-reports-btn").addEventListener("click", openReportsModal);
      watchOpenReportCount();
    }
  }
  renderNoticesList();
}

// ============================================================
// ADMIN — REPORTED POSTS. A student's "Report Post" action (see
// wall.js) writes here; only the admin can read this collection
// (enforced in firestore.rules), so this whole block quietly does
// nothing for a non-admin.
// ============================================================
let unsubscribeReportCount = null;

/** Keeps the "Reported Posts (n)" button label live while the Notice tab is open. */
function watchOpenReportCount() {
  if (unsubscribeReportCount) return;
  const q = query(collection(db, "reports"), where("resolved", "==", false));
  unsubscribeReportCount = onSnapshot(q, (snap) => {
    const label = document.getElementById("view-reports-label");
    if (label) label.textContent = snap.empty ? "Reported Posts" : `Reported Posts (${snap.size})`;
  }, () => { /* not admin, or offline — button just keeps its default label */ });
}

async function openReportsModal() {
  openModal(`<h3>Reported Posts</h3><div id="reports-modal-list"><p class="empty-state">Loading…</p></div>`);
  const listEl = document.getElementById("reports-modal-list");
  try {
    // NOTE: this where()+orderBy() combo needs a composite Firestore index.
    // The very first time this runs, Firestore will throw an error containing
    // a direct link to auto-create that index in the console — click it once
    // and the query works from then on.
    const q = query(collection(db, "reports"), where("resolved", "==", false), orderBy("createdAt", "desc"));
    const snap = await getDocs(q);
    if (snap.empty) {
      listEl.innerHTML = `<p class="empty-state">No open reports. 🎉</p>`;
      return;
    }
    listEl.innerHTML = `<div class="flat-list">` + snap.docs.map(d => {
      const r = d.data();
      return `
        <div class="report-row" data-report-id="${escapeHtml(d.id)}" data-post-id="${escapeHtml(r.postId || "")}">
          <p class="report-post-snippet">${escapeHtml(r.postText || "(post text unavailable)")}</p>
          ${r.reason ? `<p class="report-reason">Reason: ${escapeHtml(r.reason)}</p>` : ""}
          <small>Reported by ${escapeHtml(r.reportedByName || "a classmate")} · ${timeAgo(r.createdAt)}</small>
          <div class="report-row-actions">
            <button type="button" class="btn-outline small" data-report-action="view">View Post</button>
            <button type="button" class="btn-outline small" data-report-action="dismiss">Dismiss</button>
            <button type="button" class="btn-outline small danger-solid" data-report-action="remove">Remove Post</button>
          </div>
        </div>`;
    }).join("") + `</div>`;

    listEl.querySelectorAll(".report-row").forEach(row => {
      const reportId = row.dataset.reportId;
      const postId = row.dataset.postId;
      row.querySelector('[data-report-action="view"]').addEventListener("click", async () => {
        closeModal();
        const { openPostDetailPage } = await import("./post-detail.js");
        openPostDetailPage(postId);
      });
      row.querySelector('[data-report-action="dismiss"]').addEventListener("click", async (e) => {
        setBtnLoading(e.currentTarget, true, "…");
        try {
          await updateDoc(doc(db, "reports", reportId), { resolved: true });
          row.remove();
        } catch (err) { showToast("Couldn't dismiss: " + err.message); setBtnLoading(e.currentTarget, false); }
      });
      row.querySelector('[data-report-action="remove"]').addEventListener("click", () => confirmDialog({
        title: "Remove this post?",
        text: "This deletes the reported post (and its comments) from the Wall and closes the report.",
        confirmLabel: "Remove",
        onConfirm: async () => {
          const { deletePost } = await import("./wall.js");
          if (postId) await deletePost(postId, () => {});
          await updateDoc(doc(db, "reports", reportId), { resolved: true });
          row.remove();
        }
      }));
    });
  } catch (err) {
    listEl.innerHTML = `<p class="empty-state">Couldn't load reports: ${escapeHtml(err.message)}</p>`;
  }
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
        <span class="avatar avatar-sm notice-row-avatar">${avatarInner(posterProfile(n.postedByUid, n.postedByName, n.postedBy))}</span>
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
        <span class="avatar avatar-lg">${avatarInner(posterProfile(n.postedByUid, n.postedByName, n.postedBy))}</span>
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
    <textarea id="notice-edit-input" class="composer-modal-textarea" rows="4">${escapeHtml(n.text)}</textarea>
    <label class="checkbox-row">
      <input type="checkbox" id="notice-edit-urgent" ${n.urgent ? "checked" : ""} /> Mark as urgent
    </label>
    <p id="notice-edit-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="notice-edit-save-btn">Save Changes</button>
  `);
  document.getElementById("notice-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("notice-edit-input").value.trim();
    if (!text) { document.getElementById("notice-edit-error").textContent = "Notice text can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "notices", noticeId), {
        text, urgent: document.getElementById("notice-edit-urgent").checked
      });
      closeModal(); // the live "notices" listener already re-renders the page underneath
      showToast("Notice updated.");
    } catch (err) {
      document.getElementById("notice-edit-error").textContent = "Couldn't update notice: " + err.message;
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
  const wasUrgent = urgent.checked;
  setBtnLoading(submit, true, "Posting…");
  try {
    const noticeRef = await addDoc(collection(db, "notices"), {
      text,
      urgent: wasUrgent,
      postedBy: auth.currentUser.email,
      postedByUid: auth.currentUser.uid,
      postedByName: currentProfile ? currentProfile.name : "Admin",
      createdAt: serverTimestamp()
    });
    input.value = "";
    urgent.checked = false;
    showToast("Notice posted.");
    logActivity({ type: "notice", text, noticeId: noticeRef.id });
    triggerPush({ type: "notice", text, urgent: wasUrgent, noticeId: noticeRef.id });
  } catch (err) {
    showToast("Couldn't post notice: " + err.message);
  } finally {
    setBtnLoading(submit, false);
  }
}

// ============================================================
// NOTIFICATION TAB — a live feed of department activity (new wall
// posts, new shared notes, …). Any module can add an entry with
// logActivity() right after its own write succeeds; this tab just
// reads the resulting "activity" collection.
// ============================================================

/**
 * Best-effort activity log entry — never blocks or fails the action that
 * triggered it. postId/resourceId/noticeId identify the actual content the
 * notification is about, so clicking it in the Notification tab can jump
 * straight to that content instead of just opening the actor's profile.
 */
export async function logActivity({ type, text = "", targetUid = null, postId = null, resourceId = null, noticeId = null }) {
  if (!auth.currentUser) return;
  try {
    await addDoc(collection(db, "activity"), {
      type,
      text,
      targetUid,
      postId,
      resourceId,
      noticeId,
      actorUid: auth.currentUser.uid,
      actorName: currentProfile ? currentProfile.name : (auth.currentUser.email || "Someone"),
      actorEmail: auth.currentUser.email,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("Couldn't log activity:", err.message);
  }
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function activityLine(a) {
  const quoted = a.text ? ` — “${escapeHtml(truncate(a.text, 90))}”` : "";
  switch (a.type) {
    case "post": return `posted on the Student Wall${quoted}`;
    case "resource": return `shared a note/sheet${a.text ? `: <strong>${escapeHtml(truncate(a.text, 70))}</strong>` : ""}`;
    case "comment": return `commented on a post${quoted}`;
    case "like": return `liked your post`;
    case "notice": return `posted a notice${quoted}`;
    default: return escapeHtml(a.text || "did something on GeoHub");
  }
}

function renderActivityList() {
  const host = document.getElementById("notification-list");
  if (!host) return;

  const activity = mergedActivity().filter(visibleToMe);

  // Distinguish "genuinely nothing has happened yet" from "the feed failed to
  // load" — these used to look identical ("No recent activity yet."), which is
  // exactly what made the underlying permission/index bug invisible. Showing
  // the raw Firestore error code here means the fix (or next bug) is visible
  // on the phone itself, no devtools needed.
  if (activityFeedError) {
    host.innerHTML = `<p class="empty-state">Couldn't load notifications (${escapeHtml(activityFeedError)}). Pull to refresh, or tell your admin this code.</p>`;
    return;
  }

  if (!activity.length) {
    host.innerHTML = `<p class="empty-state">No recent activity yet.</p>`;
    return;
  }

  host.innerHTML = `<div class="notice-flat-list">` + activity.map((a, i) => `
    <div class="notice-row activity-row" data-index="${i}">
      <div class="notice-row-top">
        <span class="avatar avatar-sm">${avatarInner(posterProfile(a.actorUid, a.actorName, a.actorEmail))}</span>
        <div class="notice-row-byline">
          <span class="notice-row-name">${nameWithBadge(a.actorName || "Someone", a.actorEmail)}</span>
          <small>${timeAgo(a.createdAt)}</small>
        </div>
      </div>
      <p class="notice-row-text">${activityLine(a)}</p>
    </div>
  `).join("") + `</div>`;

  host.querySelectorAll(".activity-row").forEach(row => {
    const a = activity[Number(row.dataset.index)];
    if (!a) return;
    row.addEventListener("click", () => openActivityDestination(a));
  });
}

// ============================================================
// Clicking a notification should land on whatever it's actually about
// (the post that got liked/commented on, the shared resource, the
// notice) rather than always opening the actor's profile.
// ============================================================
async function openActivityDestination(a) {
  switch (a.type) {
    case "post":
    case "like":
    case "comment": {
      if (!a.postId) return; // older entries logged before postId existed
      const { openPostDetailPage } = await import("./post-detail.js");
      openPostDetailPage(a.postId, { focusComment: a.type === "comment" });
      break;
    }
    case "resource": {
      if (!a.resourceId) return;
      const { focusResource } = await import("./resources.js");
      if (goToRouteRef) goToRouteRef("resources");
      focusResource(a.resourceId);
      break;
    }
    case "notice": {
      if (goToRouteRef) goToRouteRef("notices");
      switchToNoticeTab();
      if (a.noticeId) openNoticeDetail(a.noticeId);
      break;
    }
    default: {
      if (!a.actorUid) return;
      const { openUserProfilePage } = await import("./profile-view.js");
      openUserProfilePage(a.actorUid);
    }
  }
}

/** Switches the Notices & Notifications page over to its "Notice" tab. */
function switchToNoticeTab() {
  const section = document.getElementById("section-notices");
  if (!section) return;
  const tabBtn = section.querySelector('.notices-page-tab-btn[data-tab="notice"]');
  tabBtn?.click();
}

// ============================================================
// WEEKLY ROUTINE
// ============================================================
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
  if (unsubscribeActivityPublic) unsubscribeActivityPublic();
  if (unsubscribeActivityPrivate) unsubscribeActivityPrivate();
  if (unsubscribeReportCount) unsubscribeReportCount();
  unsubscribeActivityPublic = null;
  unsubscribeActivityPrivate = null;
  unsubscribeReportCount = null;
  latestNotices = [];
  latestActivityPublic = [];
  latestActivityPrivate = [];
  activityFeedError = null;
  const host = document.getElementById("notice-tab-body");
  if (host) { delete host.dataset.shellBuilt; host.innerHTML = ""; }
}
