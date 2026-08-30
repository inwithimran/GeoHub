// ============================================================
// MESSAGES.JS — "Messages" page: two sub-tabs.
//
//  - Class Chat: one open room every classmate can read and post in
//    (classChat/{messageId}), rendered as a live chat-bubble feed with
//    a composer pinned to the bottom of the panel.
//  - Direct Messages: a 1:1 inbox. conversations/{conversationId} holds
//    one doc per PAIR of students (id = both uids, sorted + joined —
//    see dmConversationId() below, so both sides always land on the
//    exact same document instead of racing to create duplicates), with
//    a messages subcollection underneath. The list view shows every
//    conversation the signed-in student is part of; tapping one opens
//    its own full-page thread (section-dm-thread — a drill-down page
//    pushed to history, same pattern as post-detail.js/profile-view.js,
//    never a modal).
//
// Both surfaces lean on js/presence.js for "Online"/"Active Xm ago",
// and on the shared profile cache (ui-utils.js) for names/avatars —
// same conventions as wall.js/directory.js, so a classmate's profile
// updates (new photo, name change) repaint everywhere live.
// ============================================================
import { auth, db } from "./firebase-config.js";
import {
  collection, doc, query, where, orderBy, limitToLast, onSnapshot,
  addDoc, updateDoc, setDoc, getDoc, deleteDoc, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import {
  escapeHtml, showToast, friendlyError, avatarInner, nameWithBadge,
  getCachedProfile, ensureProfileLoaded, subscribeToProfileUpdates,
  richTextHtml, wireRichTextClicks, kebabMenuHtml, wireKebabMenus, confirmDialog,
  timeAgo
} from "./ui-utils.js";
import { authorProfile } from "./wall.js";
import { getAllStudents } from "./directory.js";
import { isUserOnline, avatarPresenceDotHtml, presenceTextHtml, paintPresenceUI } from "./presence.js";

// ---------- Shared element refs ----------
const subtabBtns = document.querySelectorAll(".msg-subtab-btn");
const subtabPanels = document.querySelectorAll(".msg-subtab-panel");

const classChatList = document.getElementById("class-chat-list");
const classChatForm = document.getElementById("class-chat-form");
const classChatInput = document.getElementById("class-chat-input");
const classChatSendBtn = document.getElementById("class-chat-send-btn");
const classChatOnlineCount = document.getElementById("class-chat-online-count");

const dmListEl = document.getElementById("dm-conversation-list");
const dmTotalBadges = [
  document.getElementById("dm-total-unread-badge"),
  document.getElementById("msg-nav-badge-bottom"),
  document.getElementById("msg-nav-badge-sidebar")
].filter(Boolean);

const dmThreadHeaderEl = document.getElementById("dm-thread-header");
const dmThreadListEl = document.getElementById("dm-thread-list");
const dmThreadForm = document.getElementById("dm-thread-form");
const dmThreadInput = document.getElementById("dm-thread-input");
const dmThreadSendBtn = document.getElementById("dm-thread-send-btn");
const dmThreadBackBtn = document.getElementById("dm-thread-back-btn");

let goToRouteRef = null;
export function registerDmThreadRouter(goToRoute) { goToRouteRef = goToRoute; }

/** Deterministic conversation id for a pair of students — order-independent. */
function dmConversationId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

// ============================================================
// SUB-TABS — Class Chat / Direct Messages. A plain show/hide toggle,
// same tab pattern as a classmate's Profile page (profile-view.js).
// ============================================================
/** Whether the Class Chat sub-tab (full live room + composer) is the one currently showing — used to also hide the bottom nav for it, same as a DM thread. */
export function isClassChatSubtabActive() {
  return document.querySelector(".msg-subtab-btn.active")?.dataset.msgtab === "class";
}

function syncMessageChatMode() {
  // Only the Messages route ever has this section visible, so it's safe
  // to flip chat-mode straight from a sub-tab click — see app.js's own
  // route-level toggle (which handles every other route, and re-syncs
  // this whenever the Messages route is (re)entered from elsewhere).
  document.getElementById("app-shell")?.classList.toggle("chat-mode", isClassChatSubtabActive());
}

function wireSubtabs() {
  subtabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      subtabBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
      });
      subtabPanels.forEach(p => p.classList.toggle("active", p.dataset.msgtabPanel === btn.dataset.msgtab));
      syncMessageChatMode();
    });
  });
}

// ============================================================
// CLASS CHAT
// ============================================================
const CLASS_CHAT_TEXT_LIMIT = 1000;
let unsubscribeClassChat = null;
let classChatAtBottom = true; // whether the reader is scrolled near the bottom right now

function isNearBottom(el, slack = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

/** Renders a list of {id,...} chat docs (classChat OR one DM thread's messages) into `listEl` as grouped bubbles.
 *  `showNames`: Class Chat is a shared room (many voices), so each new sender needs a name label above their
 *  bubbles. A DM thread is always exactly the two of you — repeating "the other person's name" over and over
 *  is just noise there, so DM rendering passes this false and skips it. */
function renderChatBubbles(listEl, docs, { emptyText, showNames = true }) {
  if (!docs.length) {
    listEl.innerHTML = `<div class="chat-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const myUid = auth.currentUser?.uid;
  let html = "";
  let lastDayKey = null;
  let prevSenderUid = null;
  let prevMs = 0;

  docs.forEach((m) => {
    const uid = m.authorUid || m.senderUid;
    const mine = uid === myUid;
    const ms = m.createdAt?.toDate ? m.createdAt.toDate().getTime() : Date.now();
    const dayKey = new Date(ms).toDateString();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      html += `<div class="chat-day-divider">${escapeHtml(new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</div>`;
      prevSenderUid = null; // always show the header again right after a day divider
    }
    // Group consecutive messages from the same person within 5 minutes —
    // skip re-showing their avatar/name for a tighter, more "chat-like" feel.
    const grouped = prevSenderUid === uid && (ms - prevMs) < 5 * 60 * 1000;
    prevSenderUid = uid;
    prevMs = ms;

    const profile = authorProfile(uid, m.authorName);
    const timeLabel = new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const canDelete = mine; // an admin could be added here too, but a chat message is low-stakes — owner-only keeps this simple
    const kebab = canDelete ? kebabMenuHtml(m.id, [{ action: "delete", label: "Delete message", danger: true }]) : "";

    html += `
      <div class="chat-bubble-row ${mine ? "mine" : ""}" data-msg-id="${escapeHtml(m.id)}">
        ${grouped ? `<span style="width:26px" aria-hidden="true"></span>` : `<span class="avatar" data-author="${escapeHtml(uid || "")}">${avatarInner(profile)}</span>`}
        <div class="chat-bubble-group">
          ${!mine && !grouped && showNames ? `<span class="chat-bubble-name">${nameWithBadge(profile.name || "Classmate", profile.email)}</span>` : ""}
          <div class="chat-bubble">${richTextHtml(m.text || "", [])}</div>
          <div class="chat-bubble-meta"><span>${timeLabel}</span></div>
        </div>
        ${kebab}
      </div>`;
  });

  listEl.innerHTML = html;
  wireRichTextClicks(listEl);
  wireKebabMenus(listEl, {
    delete: (msgId) => confirmDialog({
      title: "Delete this message?",
      text: "This can't be undone.",
      onConfirm: () => listEl.dataset.deleteHandler === "dm"
        ? deleteDmMessage(listEl.dataset.conversationId, msgId)
        : deleteClassChatMessage(msgId)
    })
  });
}

function deleteClassChatMessage(msgId) {
  return deleteDoc(doc(db, "classChat", msgId)).catch((err) => {
    const { message, technical } = friendlyError(err, "Couldn't delete that message.");
    showToast(message, { details: technical });
  });
}

/** "3 classmates online" under the Class Chat header — recomputed from the Directory's live roster + presence. */
function paintClassChatOnlineCount() {
  if (!classChatOnlineCount) return;
  const students = getAllStudents();
  const onlineCount = students.filter(s => isUserOnline(getCachedProfile(s.uid))).length;
  classChatOnlineCount.textContent = onlineCount > 0
    ? `${onlineCount} classmate${onlineCount === 1 ? "" : "s"} online`
    : "";
  classChatOnlineCount.classList.toggle("online-now", onlineCount > 0);
}

function subscribeClassChat() {
  if (unsubscribeClassChat) return;
  // Capped to the most recent 150 messages — a live room doesn't need
  // full history loaded on every open, same pagination trade-off the
  // Wall/Directory already make elsewhere in this app.
  const q = query(collection(db, "classChat"), orderBy("createdAt", "asc"), limitToLast(150));
  unsubscribeClassChat = onSnapshot(q, (snap) => {
    const wasNearBottom = classChatAtBottom || classChatList.dataset.everLoaded !== "1";
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderChatBubbles(classChatList, msgs, { emptyText: "No messages yet — say hello to the class!" });
    classChatList.dataset.everLoaded = "1";
    if (wasNearBottom) classChatList.scrollTop = classChatList.scrollHeight;
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load Class Chat.");
    showToast(message, { details: technical });
  });
  classChatList.addEventListener("scroll", () => { classChatAtBottom = isNearBottom(classChatList); });
}

async function submitClassChat() {
  const text = classChatInput.value.trim();
  if (!text || classChatSendBtn.disabled) return;
  classChatInput.value = "";
  classChatSendBtn.disabled = true;
  classChatAtBottom = true; // sending your own message should always snap the view to it
  try {
    await addDoc(collection(db, "classChat"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile?.name || auth.currentUser.email,
      text,
      createdAt: serverTimestamp()
    });
  } catch (err) {
    classChatInput.value = text; // hand the text back so nothing typed is lost
    const { message, technical } = friendlyError(err, "Couldn't send that message.");
    showToast(message, { details: technical });
  }
}

// ============================================================
// DIRECT MESSAGES — conversation list
// ============================================================
let unsubscribeConversations = null;
let allConversations = [];

function otherParticipant(conv) {
  const myUid = auth.currentUser?.uid;
  return (conv.participants || []).find(uid => uid !== myUid) || null;
}

function paintTotalUnreadBadges() {
  const myUid = auth.currentUser?.uid;
  const total = allConversations.reduce((sum, c) => sum + (Number(c.unread?.[myUid]) || 0), 0);
  dmTotalBadges.forEach(el => {
    el.textContent = total > 99 ? "99+" : String(total);
    el.classList.toggle("hidden", total === 0);
  });
}

function renderConversationList() {
  if (!dmListEl) return;
  const myUid = auth.currentUser?.uid;
  if (!allConversations.length) {
    dmListEl.innerHTML = `<p class="empty-state">No conversations yet — message a classmate from the Directory.</p>`;
    return;
  }
  const sorted = [...allConversations].sort((a, b) =>
    (b.lastMessageAt?.toDate?.().getTime() || 0) - (a.lastMessageAt?.toDate?.().getTime() || 0));

  dmListEl.innerHTML = sorted.map((c) => {
    const uid = otherParticipant(c);
    if (!uid) return "";
    ensureProfileLoaded(uid);
    const profile = getCachedProfile(uid) || { uid, name: "Classmate" };
    const unread = Number(c.unread?.[myUid]) || 0;
    const mineLast = c.lastSenderUid === myUid;
    const previewText = c.lastMessageText
      ? `${mineLast ? "You: " : ""}${c.lastMessageText}`
      : "Say hello 👋";
    return `
      <button type="button" class="dm-conv-row" data-uid="${escapeHtml(uid)}">
        <span class="avatar-presence-wrap">
          <span class="avatar" data-author="${escapeHtml(uid)}">${avatarInner(profile)}</span>
          ${avatarPresenceDotHtml(uid)}
        </span>
        <div class="dm-conv-info">
          <strong>${nameWithBadge(profile.name || "Classmate", profile.email)}</strong>
          <div class="dm-conv-preview ${unread > 0 ? "unread" : ""}">${escapeHtml(previewText)}</div>
        </div>
        <div class="dm-conv-meta">
          <span class="dm-conv-time">${c.lastMessageAt ? timeAgo(c.lastMessageAt) : ""}</span>
          ${unread > 0 ? `<span class="dm-unread-dot">${unread > 99 ? "99+" : unread}</span>` : ""}
        </div>
      </button>`;
  }).join("");

  dmListEl.querySelectorAll(".dm-conv-row").forEach(row => {
    row.addEventListener("click", () => openDmThread(row.dataset.uid));
  });
  paintPresenceUI();
}

function subscribeConversations() {
  if (unsubscribeConversations) return;
  const myUid = auth.currentUser?.uid;
  if (!myUid) return;
  // No orderBy here on purpose — array-contains + orderBy on a different
  // field needs a composite index. Fetching unsorted and sorting client-
  // side (same trade-off directory.js makes for the classmate list) keeps
  // this working with zero Firestore console setup.
  const q = query(collection(db, "conversations"), where("participants", "array-contains", myUid));
  unsubscribeConversations = onSnapshot(q, (snap) => {
    allConversations = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderConversationList();
    paintTotalUnreadBadges();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load your messages.");
    showToast(message, { details: technical });
  });
}

/** Make sure the two-person conversation doc exists; returns its id. Safe to call repeatedly. */
async function ensureConversation(otherUid) {
  const myUid = auth.currentUser.uid;
  const id = dmConversationId(myUid, otherUid);
  const ref = doc(db, "conversations", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      participants: [myUid, otherUid].sort(),
      lastMessageText: "",
      lastMessageAt: serverTimestamp(),
      lastSenderUid: null,
      unread: { [myUid]: 0, [otherUid]: 0 },
      createdAt: serverTimestamp()
    });
  }
  return id;
}

function markConversationRead(conversationId) {
  const myUid = auth.currentUser?.uid;
  if (!myUid || !conversationId) return;
  updateDoc(doc(db, "conversations", conversationId), { [`unread.${myUid}`]: 0 }).catch(() => {});
}

// ============================================================
// DIRECT MESSAGES — one open thread (drill-down page)
// ============================================================
let currentDmUid = null;
let currentDmConversationId = null;
let unsubscribeDmMessages = null;
let dmThreadAtBottom = true;

/** The classmate uid whose thread is currently open (null if the page isn't open) — mirrors getOpenProfileUid()/getOpenPostId(). */
export function getOpenDmUid() { return currentDmUid; }

/** Call whenever navigating away from the thread page. */
export function teardownDmThread() {
  if (unsubscribeDmMessages) unsubscribeDmMessages();
  unsubscribeDmMessages = null;
  currentDmUid = null;
  currentDmConversationId = null;
}

function dmThreadSkeletonHtml() {
  return `<div class="chat-empty" aria-hidden="true">Loading conversation…</div>`;
}

function renderDmThreadHeader(uid) {
  const profile = getCachedProfile(uid) || { uid, name: "Classmate" };
  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = profile.name || "Direct Message";
  dmThreadHeaderEl.innerHTML = `
    <span class="avatar-presence-wrap">
      <span class="avatar" data-author="${escapeHtml(uid)}">${avatarInner(profile)}</span>
      ${avatarPresenceDotHtml(uid)}
    </span>
    <div>
      <span class="dm-thread-header-name">${nameWithBadge(profile.name || "Classmate", profile.email)}</span>
      ${presenceTextHtml(uid, "dm-thread-presence-chip")}
    </div>`;
  paintPresenceUI();
}

/**
 * Open the DM thread with `uid` — used by a Directory row's Message button,
 * a classmate's Profile page Message button, and tapping a row in the
 * Direct Messages conversation list. Creates the conversation doc on first
 * contact between the two students.
 */
export async function openDmThread(uid, { fromPopstate = false, replace = false } = {}) {
  if (!uid || !auth.currentUser || uid === auth.currentUser.uid) return;
  teardownDmThread();
  currentDmUid = uid;

  if (goToRouteRef) goToRouteRef("dm-thread", { fromPopstate, replace, state: { dmUid: uid } });
  dmThreadListEl.innerHTML = dmThreadSkeletonHtml();
  dmThreadAtBottom = true;

  if (!getCachedProfile(uid)) ensureProfileLoaded(uid);
  renderDmThreadHeader(uid);

  let conversationId;
  try {
    conversationId = await ensureConversation(uid);
  } catch (err) {
    dmThreadListEl.innerHTML = `<div class="chat-empty">Couldn't open this conversation.</div>`;
    const { message, technical } = friendlyError(err, "Couldn't open this conversation.");
    showToast(message, { details: technical });
    return;
  }
  if (uid !== currentDmUid) return; // superseded by a newer navigation while awaiting the conversation doc
  currentDmConversationId = conversationId;
  markConversationRead(conversationId);

  const q = query(collection(db, "conversations", conversationId, "messages"), orderBy("createdAt", "asc"));
  unsubscribeDmMessages = onSnapshot(q, (snap) => {
    if (conversationId !== currentDmConversationId) return;
    const wasNearBottom = dmThreadAtBottom || dmThreadListEl.dataset.everLoaded !== "1";
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    dmThreadListEl.dataset.conversationId = conversationId;
    dmThreadListEl.dataset.deleteHandler = "dm";
    renderChatBubbles(dmThreadListEl, msgs, { emptyText: "No messages yet — say hello 👋", showNames: false });
    dmThreadListEl.dataset.everLoaded = "1";
    if (wasNearBottom) dmThreadListEl.scrollTop = dmThreadListEl.scrollHeight;
    // Any incoming message while this thread is open counts as read immediately.
    markConversationRead(conversationId);
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load this conversation.");
    showToast(message, { details: technical });
  });
}

function deleteDmMessage(conversationId, msgId) {
  return deleteDoc(doc(db, "conversations", conversationId, "messages", msgId)).catch((err) => {
    const { message, technical } = friendlyError(err, "Couldn't delete that message.");
    showToast(message, { details: technical });
  });
}

async function submitDmMessage() {
  const text = dmThreadInput.value.trim();
  const conversationId = currentDmConversationId;
  const otherUid = currentDmUid;
  if (!text || !conversationId || !otherUid || dmThreadSendBtn.disabled) return;
  dmThreadInput.value = "";
  dmThreadSendBtn.disabled = true;
  dmThreadAtBottom = true;
  try {
    const myUid = auth.currentUser.uid;
    await addDoc(collection(db, "conversations", conversationId, "messages"), {
      senderUid: myUid,
      text,
      createdAt: serverTimestamp()
    });
    await updateDoc(doc(db, "conversations", conversationId), {
      lastMessageText: text.length > 140 ? text.slice(0, 140) + "…" : text,
      lastMessageAt: serverTimestamp(),
      lastSenderUid: myUid,
      [`unread.${otherUid}`]: increment(1)
    });
  } catch (err) {
    dmThreadInput.value = text;
    const { message, technical } = friendlyError(err, "Couldn't send that message.");
    showToast(message, { details: technical });
  }
}

// ============================================================
// INIT / TEARDOWN
// ============================================================
export function initMessages() {
  wireSubtabs();

  classChatForm?.addEventListener("submit", (e) => { e.preventDefault(); submitClassChat(); });
  classChatInput?.addEventListener("input", () => { classChatSendBtn.disabled = !classChatInput.value.trim(); });
  subscribeClassChat();
  paintClassChatOnlineCount();

  dmThreadForm?.addEventListener("submit", (e) => { e.preventDefault(); submitDmMessage(); });
  dmThreadInput?.addEventListener("input", () => { dmThreadSendBtn.disabled = !dmThreadInput.value.trim(); });
  dmThreadBackBtn?.addEventListener("click", () => history.back());

  subscribeConversations();

  // Keep avatars, the online count, and any open presence text current as
  // profiles/heartbeats change — same "repaint in place" approach as
  // wall.js's refreshAuthorAvatars.
  subscribeToProfileUpdates((uid) => {
    const profile = getCachedProfile(uid);
    if (!profile) return;
    document.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => { el.innerHTML = avatarInner(profile); });
    paintClassChatOnlineCount();
    if (uid === currentDmUid) renderDmThreadHeader(uid);
    if (allConversations.some(c => otherParticipant(c) === uid)) renderConversationList();
  });
  // Presence has no other write to key off of when someone's heartbeat
  // simply goes stale (they closed the tab) — re-check periodically so
  // "Online" -> "Active Xm ago" transitions still show up in this page.
  setInterval(paintClassChatOnlineCount, 20_000);
}

export function teardownMessages() {
  if (unsubscribeClassChat) unsubscribeClassChat();
  unsubscribeClassChat = null;
  if (unsubscribeConversations) unsubscribeConversations();
  unsubscribeConversations = null;
  allConversations = [];
  teardownDmThread();
}
