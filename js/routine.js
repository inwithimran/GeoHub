import { db, auth, ADMIN_EMAILS } from "./firebase-config.js";
import {
  collection, addDoc, updateDoc, deleteDoc, query, where, orderBy, limit, serverTimestamp,
  doc, getDoc, getDocs, setDoc
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import {
  escapeHtml, timeAgo, fullDate, showToast, setBtnLoading, openModal, closeModal,
  avatarInner, nameWithBadge, getCachedProfile, kebabMenuHtml, wireKebabMenus, confirmDialog,
  resetScrollForTabs, skeletonRowsHtml, wireCharCounter, ensureProfileLoaded, subscribeToProfileUpdates, friendlyError
} from "./ui-utils.js";
import { currentProfile } from "./auth.js";
import { triggerPush } from "./push-trigger.js";

function posterProfile(uid, fallbackName, fallbackEmail) {
  const cached = getCachedProfile(uid);
  if (!cached) ensureProfileLoaded(uid); 
  return cached || { uid, name: fallbackName, email: fallbackEmail };
}

subscribeToProfileUpdates((uid) => {
  const profile = getCachedProfile(uid);
  if (!profile) return;
  document.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
});

const routineTable = document.getElementById("routine-table");
const editRoutineBtn = document.getElementById("edit-routine-btn");
const notifBadge = document.getElementById("topbar-notif-badge");
const noticeTabBadge = document.getElementById("notice-tab-badge");
const notificationTabBadge = document.getElementById("notification-tab-badge");
const markAllReadBtn = document.getElementById("notif-mark-all-btn");

function readIdsStorageKey(kind) {
  return `geohub_${kind}_read_ids_${auth.currentUser?.uid || "anon"}`;
}
function loadReadIdsLocal(kind) {
  try {
    const raw = JSON.parse(localStorage.getItem(readIdsStorageKey(kind)) || "[]");
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
async function mergeReadIdsFromCloud(kind, idSet) {
  const uid = auth.currentUser?.uid;
  if (!uid) return idSet;
  try {
    const snap = await getDoc(doc(db, "users", uid, "readState", kind));
    if (snap.exists()) {
      const cloudIds = snap.data().ids;
      if (Array.isArray(cloudIds)) cloudIds.forEach(id => idSet.add(id));
    }
  } catch (err) {
    console.warn(`Couldn't sync ${kind} read state from the cloud:`, err.message);
  }
  return idSet;
}
function saveReadIds(kind, idSet) {
  const ids = Array.from(idSet).slice(-400);
  localStorage.setItem(readIdsStorageKey(kind), JSON.stringify(ids));
  const uid = auth.currentUser?.uid;
  if (uid) {
    setDoc(doc(db, "users", uid, "readState", kind), { ids, updatedAt: serverTimestamp() })
      .catch(err => console.warn(`Couldn't save ${kind} read state to the cloud:`, err.message));
  }
}
let noticeReadIds = new Set();
let activityReadIds = new Set();
let dismissedActivityIds = new Set();

export function markNoticeRead(noticeId) {
  if (!noticeId || noticeReadIds.has(noticeId)) return;
  noticeReadIds.add(noticeId);
  saveReadIds("notice", noticeReadIds);
  updateNoticeBadge();
}
function markActivityRead(activityId) {
  if (!activityId || activityReadIds.has(activityId)) return;
  activityReadIds.add(activityId);
  saveReadIds("activity", activityReadIds);
  updateNoticeBadge();
  renderActivityList();
}
function markAllActivityRead() {
  const ids = mergedActivity().filter(visibleToMe).filter(a => !dismissedActivityIds.has(a.id)).map(a => a.id);
  if (!ids.length) return;
  ids.forEach(id => activityReadIds.add(id));
  saveReadIds("activity", activityReadIds);
  updateNoticeBadge();
  renderActivityList();
}
function dismissActivity(activityId) {
  if (!activityId || dismissedActivityIds.has(activityId)) return;
  dismissedActivityIds.add(activityId);
  saveReadIds("activity_dismissed", dismissedActivityIds);
  updateNoticeBadge();
  renderActivityList();
}

let unsubscribeNotices = null;
let unsubscribeActivityPublic = null;
let unsubscribeActivityPrivate = null;
let latestNotices = [];

let latestActivityPublic = [];  
let latestActivityPrivate = []; 
let activityFeedError = null;   
let noticesLoaded = false;        
let activityPublicLoaded = false;  
let activityPrivateLoaded = false; 
let noticesPageWired = false;

const NOTICE_TEXT_LIMIT = 1000;

let goToRouteRef = null;
export function registerNotificationsRouter(goToRoute) { goToRouteRef = goToRoute; }

function mergedActivity() {
  return [...latestActivityPublic, ...latestActivityPrivate]
    .sort((a, b) => (b.createdAt?.toDate?.().getTime() || 0) - (a.createdAt?.toDate?.().getTime() || 0))
    .slice(0, 60);
}

function visibleToMe(a) {
  if (a.type === "comment" || a.type === "reply" || a.type === "like" || a.type === "comment-like" || a.type === "mention") {
    return a.targetUid === auth.currentUser?.uid;
  }
  if (a.actorUid === auth.currentUser?.uid) return false;

  const joinedAt = currentProfile?.createdAt?.toDate?.();
  const postedAt = a.createdAt?.toDate?.();
  if (joinedAt && postedAt && postedAt < joinedAt) return false;
  return true;
}

const BACKGROUND_DETACH_DELAY_MS = 60 * 1000;
let backgroundDetachTimer = null;
let visibilityHandlerAttached = false;

function subscribeNotifications() {
  if (unsubscribeNotices || unsubscribeActivityPublic || unsubscribeActivityPrivate) return;

  const q = query(collection(db, "notices"), orderBy("createdAt", "desc"));
  unsubscribeNotices = onSnapshotWithRetry(q, (snap) => {
    latestNotices = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    noticesLoaded = true;
    updateNoticeBadge();
    renderNoticeTabBody();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load notices.");
    showToast(message, { details: technical });
  });

  const publicQ = query(
    collection(db, "activity"),
    where("type", "in", ["post", "resource", "notice"]),
    limit(200)
  );
  unsubscribeActivityPublic = onSnapshotWithRetry(publicQ, (snap) => {
    latestActivityPublic = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    activityPublicLoaded = true;
    activityFeedError = null;
    updateNoticeBadge();
    renderActivityList();
  }, (err) => {
    console.error("Couldn't load public activity feed:", err.code, err.message);
    activityFeedError = err.code || err.message;
    const { message, technical } = friendlyError(err, "Couldn't load the notification feed.");
    showToast(message, { details: technical });
    latestActivityPublic = [];
    activityPublicLoaded = true;
    renderActivityList();
  });

  const uid = auth.currentUser?.uid;
  if (uid) {
    const privateQ = query(
      collection(db, "activity"),
      where("targetUid", "==", uid),
      limit(200)
    );
    unsubscribeActivityPrivate = onSnapshotWithRetry(privateQ, (snap) => {
      latestActivityPrivate = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      activityPrivateLoaded = true;
      activityFeedError = null;
      updateNoticeBadge();
      renderActivityList();
    }, (err) => {
      console.error("Couldn't load your personal activity feed:", err.code, err.message);
      activityFeedError = err.code || err.message;
      const { message, technical } = friendlyError(err, "Couldn't load the notification feed.");
      showToast(message, { details: technical });
      latestActivityPrivate = [];
      activityPrivateLoaded = true;
      renderActivityList();
    });
  }
}

function unsubscribeNotifications() {
  if (unsubscribeNotices) { unsubscribeNotices(); unsubscribeNotices = null; }
  if (unsubscribeActivityPublic) { unsubscribeActivityPublic(); unsubscribeActivityPublic = null; }
  if (unsubscribeActivityPrivate) { unsubscribeActivityPrivate(); unsubscribeActivityPrivate = null; }
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearTimeout(backgroundDetachTimer);
    backgroundDetachTimer = setTimeout(() => {
      if (document.hidden) unsubscribeNotifications();
    }, BACKGROUND_DETACH_DELAY_MS);
  } else {
    clearTimeout(backgroundDetachTimer);
    subscribeNotifications(); 
  }
}

export function initRoutine() {
  noticeReadIds = loadReadIdsLocal("notice");
  activityReadIds = loadReadIdsLocal("activity");
  dismissedActivityIds = loadReadIdsLocal("activity_dismissed");
  mergeReadIdsFromCloud("notice", noticeReadIds).then(merged => {
    noticeReadIds = merged;
    saveReadIds("notice", noticeReadIds);
    updateNoticeBadge();
    renderNoticeTabBody();
  });
  mergeReadIdsFromCloud("activity", activityReadIds).then(merged => {
    activityReadIds = merged;
    saveReadIds("activity", activityReadIds);
    updateNoticeBadge();
    renderActivityList();
  });
  mergeReadIdsFromCloud("activity_dismissed", dismissedActivityIds).then(merged => {
    dismissedActivityIds = merged;
    saveReadIds("activity_dismissed", dismissedActivityIds);
    updateNoticeBadge();
    renderActivityList();
  });

  const isAdmin = ADMIN_EMAILS.includes(auth.currentUser?.email || "");
  if (isAdmin) subscribeReports();
  document.getElementById("admin-panel-block")?.classList.toggle("hidden", !isAdmin);

  if (editRoutineBtn) {
    editRoutineBtn.classList.toggle("hidden", !isAdmin);
    if (!editRoutineBtn.dataset.wired) {
      editRoutineBtn.dataset.wired = "1";
      editRoutineBtn.addEventListener("click", openRoutineEditorModal);
    }
  }

  subscribeNotifications();
  if (!visibilityHandlerAttached) {
    document.addEventListener("visibilitychange", handleVisibilityChange);
    visibilityHandlerAttached = true;
  }

  subscribeRoutine();
  wireNoticesPageTabs();

  if (markAllReadBtn && !markAllReadBtn.dataset.wired) {
    markAllReadBtn.dataset.wired = "1";
    markAllReadBtn.addEventListener("click", () => {
      markAllActivityRead();
      showToast("All notifications marked as read.");
    });
  }
}

function setBadgeEl(el, count) {
  if (!el) return;
  el.textContent = count > 9 ? "9+" : String(count);
  el.classList.toggle("hidden", count === 0);
}

function updateNoticeBadge() {
  const unreadNotices = latestNotices.filter(n => !noticeReadIds.has(n.id)).length;
  const unreadActivity = mergedActivity().filter(visibleToMe)
    .filter(a => !dismissedActivityIds.has(a.id) && !activityReadIds.has(a.id)).length;
  setBadgeEl(notifBadge, unreadNotices + unreadActivity);
  setBadgeEl(noticeTabBadge, unreadNotices);
  setBadgeEl(notificationTabBadge, unreadActivity);
}

function wireNoticesPageTabs() {
  if (noticesPageWired) return;
  const section = document.getElementById("section-notices");
  if (!section) return;
  noticesPageWired = true;

  const tabBtns = section.querySelectorAll(".notices-page-tab-btn");
  const tabsEl = section.querySelector(".notices-page-tabs");
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
        b.tabIndex = active ? 0 : -1;
      });
      section.querySelectorAll(".notices-page-panel").forEach(p =>
        p.classList.toggle("active", p.dataset.panel === btn.dataset.tab));
      resetScrollForTabs(tabsEl); 
    });
  });
}

function renderNoticeTabBody() {
  const host = document.getElementById("notice-tab-body");
  if (!host) return; 

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
          <textarea id="notice-input" placeholder="Post an urgent notice to the class…" rows="2" maxlength="${NOTICE_TEXT_LIMIT}"></textarea>
          <label class="checkbox-row">
            <input type="checkbox" id="notice-urgent" /> Mark as urgent
          </label>
          <button id="notice-submit" type="button" class="btn-primary full notice-submit-btn">Post Notice</button>
        </div>` : ""}
      <div id="notice-list"><p class="empty-state">Loading notices…</p></div>
    `;
    if (isAdmin) {
      wireCharCounter(document.getElementById("notice-input"), NOTICE_TEXT_LIMIT);
      document.getElementById("notice-submit").addEventListener("click", postNotice);
    }
  }
  renderNoticesList();
}

let unsubscribeReports = null;
let openReportCount = 0;
let openReports = [];

function subscribeReports() {
  if (unsubscribeReports) return;
  const q = query(collection(db, "reports"), where("resolved", "==", false));
  unsubscribeReports = onSnapshotWithRetry(q, (snap) => {
    openReportCount = snap.size;
    openReports = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    setBadgeEl(document.getElementById("admin-reports-badge"), openReportCount);
    setBadgeEl(document.getElementById("topbar-settings-badge"), openReportCount);
    renderReportsPage();
  }, () => {  });
}

function renderReportsPage() {
  const listEl = document.getElementById("reports-page-list");
  if (!listEl) return; 
  if (!openReports.length) {
    listEl.innerHTML = `<p class="empty-state">No open reports. 🎉</p>`;
    return;
  }
  listEl.innerHTML = openReports.map(r => `
    <div class="report-row" data-report-id="${escapeHtml(r.id)}" data-post-id="${escapeHtml(r.postId || "")}">
      <p class="report-post-snippet">${escapeHtml(r.postText || "(post text unavailable)")}</p>
      ${r.reason ? `<p class="report-reason">Reason: ${escapeHtml(r.reason)}</p>` : ""}
      <small>Reported by ${escapeHtml(r.reportedByName || "a classmate")} · ${timeAgo(r.createdAt)}</small>
      <div class="report-row-actions">
        <button type="button" class="btn-outline small" data-report-action="view">View Post</button>
        <button type="button" class="btn-outline small" data-report-action="dismiss">Dismiss</button>
        <button type="button" class="btn-outline small danger-solid" data-report-action="remove">Remove Post</button>
      </div>
    </div>`).join("");

  listEl.querySelectorAll(".report-row").forEach(row => {
    const reportId = row.dataset.reportId;
    const postId = row.dataset.postId;
    row.querySelector('[data-report-action="view"]').addEventListener("click", async () => {
      const { openPostDetailPage } = await import("./post-detail.js");
      openPostDetailPage(postId);
    });
    row.querySelector('[data-report-action="dismiss"]').addEventListener("click", async (e) => {
      setBtnLoading(e.currentTarget, true, "…");
      try {
        await updateDoc(doc(db, "reports", reportId), { resolved: true });
      } catch (err) {
        const { message, technical } = friendlyError(err, "Couldn't dismiss.");
        showToast(message, { details: technical });
        setBtnLoading(e.currentTarget, false);
      }
    });
    row.querySelector('[data-report-action="remove"]').addEventListener("click", () => confirmDialog({
      title: "Remove this post?",
      text: "This deletes the reported post (and its comments) from the Wall and closes the report.",
      confirmLabel: "Remove",
      onConfirm: async () => {
        const { deletePost } = await import("./wall.js");
        if (postId) await deletePost(postId, () => {});
        await updateDoc(doc(db, "reports", reportId), { resolved: true });
      }
    }));
  });
}

function renderNoticesList() {
  const noticeList = document.getElementById("notice-list");
  if (!noticeList) return;

  if (!latestNotices.length) {
    noticeList.innerHTML = noticesLoaded
      ? `<p class="empty-state">No notices posted yet.</p>`
      : skeletonRowsHtml(3);
    return;
  }

  const uid = auth.currentUser.uid;
  noticeList.innerHTML = `<div class="notice-flat-list">` + latestNotices.map(n => `
    <div class="notice-row ${n.urgent ? "urgent" : ""}" data-id="${n.id}">
      <div class="notice-row-top">
        <span class="avatar avatar-sm notice-row-avatar" data-author="${n.postedByUid}">${avatarInner(posterProfile(n.postedByUid, n.postedByName, n.postedBy))}</span>
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
      if (e.target.closest(".kebab-menu")) return; 
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
        deleteActivityForNotice(noticeId); 
        showToast("Notice deleted.");
      }
    })
  });
}

export function openNoticeById(noticeId) {
  switchToNoticeTab();
  openNoticeDetail(noticeId);
}

function openNoticeDetail(noticeId) {
  const n = latestNotices.find(x => x.id === noticeId);
  if (!n) return;
  markNoticeRead(noticeId); 
  openModal(`
    <div class="notice-detail-modal">
      <div class="notice-detail-head">
        <span class="avatar avatar-lg" data-author="${n.postedByUid}">${avatarInner(posterProfile(n.postedByUid, n.postedByName, n.postedBy))}</span>
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
    <textarea id="notice-edit-input" class="composer-modal-textarea" rows="4" maxlength="${NOTICE_TEXT_LIMIT}">${escapeHtml(n.text)}</textarea>
    <label class="checkbox-row">
      <input type="checkbox" id="notice-edit-urgent" ${n.urgent ? "checked" : ""} /> Mark as urgent
    </label>
    <p id="notice-edit-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="notice-edit-save-btn">Save Changes</button>
  `);
  wireCharCounter(document.getElementById("notice-edit-input"), NOTICE_TEXT_LIMIT);
  document.getElementById("notice-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("notice-edit-input").value.trim();
    if (!text) { document.getElementById("notice-edit-error").textContent = "Notice text can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "notices", noticeId), {
        text, urgent: document.getElementById("notice-edit-urgent").checked
      });
      closeModal(); 
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
    input.dispatchEvent(new Event("input")); 
    showToast("Notice posted.");
    logActivity({ type: "notice", text, noticeId: noticeRef.id });
    triggerPush({ type: "notice", text, urgent: wasUrgent, noticeId: noticeRef.id });
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't post notice.");
    showToast(message, { details: technical });
  } finally {
    setBtnLoading(submit, false);
  }
}

export async function logActivity({ type, text = "", targetUid = null, postId = null, resourceId = null, noticeId = null, deadlineId = null }) {
  if (!auth.currentUser) return;
  try {
    await addDoc(collection(db, "activity"), {
      type,
      text,
      targetUid,
      postId,
      resourceId,
      noticeId,
      deadlineId,
      actorUid: auth.currentUser.uid,
      actorName: currentProfile ? currentProfile.name : (auth.currentUser.email || "Someone"),
      actorEmail: auth.currentUser.email,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    console.warn("Couldn't log activity:", err.message);
  }
}

async function deleteActivityMatching(field, value) {
  if (!value) return;
  try {
    const snap = await getDocs(query(collection(db, "activity"), where(field, "==", value)));
    await Promise.all(snap.docs.map(d => deleteDoc(d.ref)));
  } catch (err) {
    console.warn(`Couldn't clean up activity where ${field}=${value}:`, err.message);
  }
}
export function deleteActivityForPost(postId) { return deleteActivityMatching("postId", postId); }
export function deleteActivityForResource(resourceId) { return deleteActivityMatching("resourceId", resourceId); }
export function deleteActivityForNotice(noticeId) { return deleteActivityMatching("noticeId", noticeId); }
export function deleteActivityForDeadline(deadlineId) { return deleteActivityMatching("deadlineId", deadlineId); }

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function activityLine(a) {
  const quoted = a.text ? ` — “${escapeHtml(truncate(a.text, 90))}”` : "";
  switch (a.type) {
    case "post": return `shared a new post on the Student Wall${quoted}`;
    case "resource": return `shared a new resource in Notes &amp; Sheets${a.text ? `: <strong>${escapeHtml(truncate(a.text, 70))}</strong>` : ""}`;
    case "comment": return `commented on your post${quoted}`;
    case "reply": return `replied to your comment${quoted}`;
    case "like": return `reacted to your post`;
    case "comment-like": return `reacted to your comment${quoted}`;
    case "mention": return `mentioned you${quoted}`;
    case "notice": return `posted a new notice${quoted}`;
    case "routine": return `updated the weekly class routine${quoted}`;
    case "deadline": return `posted a new deadline${a.text ? `: <strong>${escapeHtml(truncate(a.text, 70))}</strong>` : ""}`;
    default: return escapeHtml(a.text || "did something on GeoHub");
  }
}

function renderActivityList() {
  const host = document.getElementById("notification-list");
  if (!host) return;

  const activity = mergedActivity().filter(visibleToMe).filter(a => !dismissedActivityIds.has(a.id));

  if (activityFeedError) {
    host.innerHTML = `<p class="empty-state">Couldn't load notifications (${escapeHtml(activityFeedError)}). Pull to refresh, or tell your admin this code.</p>`;
    return;
  }

  if (!activityPublicLoaded || !activityPrivateLoaded) {
    host.innerHTML = skeletonRowsHtml(4);
    return;
  }

  if (!activity.length) {
    host.innerHTML = `<p class="empty-state">No recent activity yet.</p>`;
    return;
  }

  host.innerHTML = `<div class="notice-flat-list">` + activity.map((a, i) => {
    const unread = !activityReadIds.has(a.id);
    return `
    <div class="activity-row ${unread ? "unread" : "read"}" data-index="${i}">
      ${unread ? `<span class="activity-unread-dot"></span>` : ""}
      <div class="notice-row-top">
        <span class="avatar avatar-sm" data-author="${a.actorUid}">${avatarInner(posterProfile(a.actorUid, a.actorName, a.actorEmail))}</span>
        <div class="notice-row-byline">
          <span class="notice-row-name">${nameWithBadge(a.actorName || "Someone", a.actorEmail)}</span>
          <small>${timeAgo(a.createdAt)}</small>
        </div>
        ${kebabMenuHtml(a.id, [{ action: "delete", label: "Delete Notification", danger: true }])}
      </div>
      <p class="notice-row-text">${activityLine(a)}</p>
    </div>
  `;
  }).join("") + `</div>`;

  host.querySelectorAll(".activity-row").forEach(row => {
    const a = activity[Number(row.dataset.index)];
    if (!a) return;
    row.addEventListener("click", (e) => {
      if (e.target.closest(".kebab-menu")) return; 
      markActivityRead(a.id); 
      openActivityDestination(a);
    });
  });

  wireKebabMenus(host, {
    delete: (activityId) => dismissActivity(activityId)
  });
}

async function openActivityDestination(a) {
  switch (a.type) {
    case "post":
    case "like":
    case "comment":
    case "reply":
    case "comment-like":
    case "mention": {
      if (!a.postId) return; 
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
    case "deadline": {
      if (goToRouteRef) goToRouteRef("routine");
      if (a.deadlineId) {
        const { focusDeadline } = await import("./deadlines.js");
        focusDeadline(a.deadlineId);
      }
      break;
    }
    case "routine": {
      if (goToRouteRef) goToRouteRef("routine");
      break;
    }
    default: {
      if (!a.actorUid) return;
      const { openUserProfilePage } = await import("./profile-view.js");
      openUserProfilePage(a.actorUid);
    }
  }
}

function switchToNoticeTab() {
  const section = document.getElementById("section-notices");
  if (!section) return;
  const tabBtn = section.querySelector('.notices-page-tab-btn[data-tab="notice"]');
  tabBtn?.click();
}

const DAY_ORDER = ["Saturday", "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
let latestRoutineData = null;
let unsubscribeRoutineDoc = null;

function subscribeRoutine() {
  if (unsubscribeRoutineDoc) return;
  unsubscribeRoutineDoc = onSnapshotWithRetry(doc(db, "routine", "weekly"), (snap) => {
    latestRoutineData = snap.exists() ? snap.data() : null;
    renderRoutineTable();
  }, () => {
    routineTable.innerHTML = `<p class="empty-state">Couldn't load routine.</p>`;
  });
}

function renderRoutineTable() {
  if (!latestRoutineData) {
    routineTable.innerHTML = `<p class="empty-state">Routine has not been published yet.</p>`;
    return;
  }
  let html = "";
  DAY_ORDER.forEach(day => {
    const slots = latestRoutineData[day];
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
}

function slotRowHtml(s = {}) {
  return `
    <div class="routine-editor-slot-row">
      <input type="text" class="routine-editor-input rt-time" placeholder="9:00–10:20" value="${escapeHtml(s.time || "")}" />
      <input type="text" class="routine-editor-input rt-subject" placeholder="Subject" value="${escapeHtml(s.subject || "")}" />
      <input type="text" class="routine-editor-input rt-room" placeholder="Room" value="${escapeHtml(s.room || "")}" />
      <button type="button" class="routine-editor-remove-btn" data-remove-slot aria-label="Remove this class">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
}

function dayEditorHtml(day, slots) {
  const rows = slots.map(s => slotRowHtml(s)).join("");
  return `
    <div class="routine-editor-day" data-day="${escapeHtml(day)}">
      <div class="routine-editor-day-head">
        <h4>${escapeHtml(day)}</h4>
        <button type="button" class="routine-editor-add-slot-btn" data-add-slot>
          <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add class
        </button>
      </div>
      <div class="routine-editor-slot-list">${rows}</div>
    </div>`;
}

function openRoutineEditorModal() {
  const data = latestRoutineData || {};
  openModal(`
    <h3>Edit Weekly Routine</h3>
    <p class="routine-editor-hint">Add class times for each day. A day left with no classes won't be shown on the routine.</p>
    <div id="routine-editor-days">
      ${DAY_ORDER.map(day => dayEditorHtml(day, data[day] || [])).join("")}
    </div>
    <p id="routine-editor-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="routine-editor-save-btn">Save &amp; Notify Class</button>
  `);
  wireRoutineEditor();
}

function wireRoutineEditor() {
  const host = document.getElementById("routine-editor-days");
  host.querySelectorAll(".routine-editor-day").forEach(dayEl => {
    dayEl.querySelector("[data-add-slot]").addEventListener("click", () => {
      dayEl.querySelector(".routine-editor-slot-list").insertAdjacentHTML("beforeend", slotRowHtml());
    });
  });
  host.addEventListener("click", (e) => {
    const removeBtn = e.target.closest("[data-remove-slot]");
    if (removeBtn) removeBtn.closest(".routine-editor-slot-row").remove();
  });
  document.getElementById("routine-editor-save-btn").addEventListener("click", saveRoutine);
}

async function saveRoutine() {
  const btn = document.getElementById("routine-editor-save-btn");
  const errorEl = document.getElementById("routine-editor-error");
  const host = document.getElementById("routine-editor-days");
  const payload = { updatedAt: serverTimestamp() };
  let hasAnySlot = false;

  for (const dayEl of host.querySelectorAll(".routine-editor-day")) {
    const day = dayEl.dataset.day;
    const slots = [];
    for (const row of dayEl.querySelectorAll(".routine-editor-slot-row")) {
      const time = row.querySelector(".rt-time").value.trim();
      const subject = row.querySelector(".rt-subject").value.trim();
      const room = row.querySelector(".rt-room").value.trim();
      if (!time && !subject && !room) continue; 
      if (!time || !subject) {
        errorEl.textContent = `${day}: please fill in both time and subject, or remove that row.`;
        return;
      }
      slots.push({ time, subject, room });
    }
    if (slots.length) { payload[day] = slots; hasAnySlot = true; }
  }

  errorEl.textContent = "";
  setBtnLoading(btn, true, "Saving…");
  try {
   
    await setDoc(doc(db, "routine", "weekly"), payload);
    closeModal();
    showToast("Routine updated.");
    if (hasAnySlot) {
      logActivity({ type: "routine", text: "The weekly class routine was updated." });
      triggerPush({ type: "routine", text: "The weekly class routine was updated." });
    }
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't update routine.");
    errorEl.textContent = message;
    if (technical) console.warn(technical);
    setBtnLoading(btn, false);
  }
}

export function teardownRoutine() {
  unsubscribeNotifications(); 
  if (unsubscribeReports) unsubscribeReports();
  unsubscribeReports = null;
  if (unsubscribeRoutineDoc) { unsubscribeRoutineDoc(); unsubscribeRoutineDoc = null; }
  latestRoutineData = null;
  clearTimeout(backgroundDetachTimer);
  if (visibilityHandlerAttached) {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    visibilityHandlerAttached = false;
  }
  openReportCount = 0;
  openReports = [];
  latestNotices = [];
  latestActivityPublic = [];
  latestActivityPrivate = [];
  activityFeedError = null;
  noticesLoaded = false;
  activityPublicLoaded = false;
  activityPrivateLoaded = false;
  noticeReadIds = new Set();
  activityReadIds = new Set();
  dismissedActivityIds = new Set();
  const host = document.getElementById("notice-tab-body");
  if (host) { delete host.dataset.shellBuilt; host.innerHTML = ""; }
}
