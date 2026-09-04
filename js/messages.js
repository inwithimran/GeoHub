import { auth, db } from "./firebase-config.js";
import {
  collection, doc, query, where, orderBy, limitToLast,
  addDoc, updateDoc, setDoc, getDoc, deleteDoc, serverTimestamp, increment,
  arrayUnion, arrayRemove, deleteField
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import { currentProfile, fetchProfile } from "./auth.js";
import {
  escapeHtml, escapeAttr, showToast, friendlyError, avatarInner, nameWithBadge,
  getCachedProfile, cacheUserProfile, ensureProfileLoaded, subscribeToProfileUpdates,
  richTextHtml, wireRichTextClicks, wireKebabMenus, confirmDialog, closeModal,
  timeAgo
} from "./ui-utils.js";
import { authorProfile } from "./wall.js";
import { getAllStudents } from "./directory.js";
import { isUserOnline, avatarPresenceDotHtml, presenceTextHtml, paintPresenceUI } from "./presence.js";
import { triggerPush } from "./push-trigger.js";

const subtabBtns = document.querySelectorAll(".msg-subtab-btn");
const subtabPanels = document.querySelectorAll(".msg-subtab-panel");

const classChatList = document.getElementById("class-chat-list");
const classChatForm = document.getElementById("class-chat-form");
const classChatInput = document.getElementById("class-chat-input");
const classChatSendBtn = document.getElementById("class-chat-send-btn");
const classChatOnlineCount = document.getElementById("class-chat-online-count");

const dmListEl = document.getElementById("dm-conversation-list");
const dmTabBadge = document.getElementById("dm-total-unread-badge");
const classChatTabBadge = document.getElementById("class-chat-unread-badge");
const navTotalBadges = [
  document.getElementById("msg-nav-badge-bottom"),
  document.getElementById("msg-nav-badge-sidebar")
].filter(Boolean);

const dmThreadHeaderEl = document.getElementById("dm-thread-header");
const dmThreadListEl = document.getElementById("dm-thread-list");
const dmThreadForm = document.getElementById("dm-thread-form");
const dmThreadInput = document.getElementById("dm-thread-input");
const dmThreadSendBtn = document.getElementById("dm-thread-send-btn");
const dmThreadBackBtn = document.getElementById("dm-thread-back-btn");
const dmThreadMoreMenu = document.getElementById("dm-thread-more-menu");
const dmThreadBlockItem = document.getElementById("dm-thread-block-item");
const dmThreadBlockedBar = document.getElementById("dm-thread-blocked-bar");
const dmThreadBlockedText = document.getElementById("dm-thread-blocked-text");
const dmThreadUnblockBtn = document.getElementById("dm-thread-unblock-btn");

let goToRouteRef = null;
let goBackToRouteRef = null;
export function registerDmThreadRouter(goToRoute, goBackToRoute) { goToRouteRef = goToRoute; goBackToRouteRef = goBackToRoute; }

function dmConversationId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}

export async function getBlockState(otherUid) {
  const myUid = auth.currentUser?.uid;
  if (!myUid || !otherUid) return { blockedByMe: false, blockedByThem: false };
  const snap = await getDoc(doc(db, "conversations", dmConversationId(myUid, otherUid)));
  const blockedBy = snap.exists() ? (snap.data().blockedBy || []) : [];
  return { blockedByMe: blockedBy.includes(myUid), blockedByThem: blockedBy.includes(otherUid) };
}

function isConversationHiddenForMe(conv) {
  const myUid = auth.currentUser?.uid;
  const deletedAt = conv.deletedFor?.[myUid];
  if (!deletedAt?.toMillis) return false;
  const lastMs = conv.lastMessageAt?.toMillis ? conv.lastMessageAt.toMillis() : 0;
  return deletedAt.toMillis() >= lastMs;
}

function deleteConversationForMe(conversationId) {
  const myUid = auth.currentUser?.uid;
  if (!myUid || !conversationId) return Promise.reject(new Error("no-conversation"));
  return updateDoc(doc(db, "conversations", conversationId), {
    [`deletedFor.${myUid}`]: serverTimestamp()
  });
}

export async function setDmBlocked(otherUid, blocked) {
  const myUid = auth.currentUser?.uid;
  if (!myUid || !otherUid) return;
  const conversationId = await ensureConversation(otherUid);
  await updateDoc(doc(db, "conversations", conversationId), {
    blockedBy: blocked ? arrayUnion(myUid) : arrayRemove(myUid)
  });
}

export function isClassChatSubtabActive() {
  return document.querySelector(".msg-subtab-btn.active")?.dataset.msgtab === "class";
}

function syncMessageChatMode() {
  document.getElementById("app-shell")?.classList.toggle("chat-mode", isClassChatSubtabActive());
}

function wireSubtabs() {
  function activateSubtab(name) {
    subtabBtns.forEach(b => {
      const active = b.dataset.msgtab === name;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", String(active));
    });
    subtabPanels.forEach(p => p.classList.toggle("active", p.dataset.msgtabPanel === name));
    syncMessageChatMode();
    if (name === "class") markClassChatRead();
  }
  subtabBtns.forEach(btn => btn.addEventListener("click", () => activateSubtab(btn.dataset.msgtab)));
  document.getElementById("class-chat-back-btn")?.addEventListener("click", () => activateSubtab("dm"));
}

const CLASS_CHAT_TEXT_LIMIT = 1000;
let unsubscribeClassChat = null;
let classChatAtBottom = true; 
let classChatMessages = [];
let classChatLastReadMs = 0;
let unsubscribeClassChatRead = null;
let dmUnreadTotal = 0;

function isNearBottom(el, slack = 80) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack;
}

function receiptIconHtml(seen, isLast) {
  const label = seen ? "Seen" : "Sent";
  const cls = `chat-receipt${seen ? " seen" : ""}${isLast ? " is-last" : ""}`;
  if (seen) {
    return `<span class="${cls}" title="${label}" aria-label="${label}">
      <svg viewBox="0 0 20 12" width="15" height="9" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M1 6.4L4.6 10L11 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M6.4 6.4L10 10L19 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>`;
  }
  return `<span class="${cls}" title="${label}" aria-label="${label}">
    <svg viewBox="0 0 14 12" width="11" height="9" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 6.4L4.6 10L13 1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  </span>`;
}

function renderChatBubbles(listEl, docs, { emptyText, showNames = true, seenUpToMs = null }) {
  if (!docs.length) {
    listEl.innerHTML = `<div class="chat-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const myUid = auth.currentUser?.uid;
  let html = "";
  let lastDayKey = null;
  let prevSenderUid = null;
  let prevMs = 0;

  docs.forEach((m, idx) => {
    const uid = m.authorUid || m.senderUid;
    const mine = uid === myUid;
    const ms = m.createdAt?.toDate ? m.createdAt.toDate().getTime() : Date.now();
    const dayKey = new Date(ms).toDateString();
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      html += `<div class="chat-day-divider">${escapeHtml(new Date(ms).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }))}</div>`;
      prevSenderUid = null; 
    }
    const grouped = prevSenderUid === uid && (ms - prevMs) < 5 * 60 * 1000;
    prevSenderUid = uid;
    prevMs = ms;

    const profile = authorProfile(uid, m.authorName);
    const timeLabel = new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const canDelete = mine; 
    const showReceipt = mine && seenUpToMs != null;
    const isLastMine = mine && idx === docs.length - 1;
    const seen = showReceipt && ms <= seenUpToMs;
    messageTextCache.set(m.id, m.text || "");
    html += `
      <div class="chat-bubble-row ${mine ? "mine" : ""}" data-msg-id="${escapeAttr(m.id)}" data-can-delete="${canDelete ? "1" : "0"}">
        ${grouped ? `<span style="width:26px" aria-hidden="true"></span>` : `<span class="avatar" data-author="${escapeAttr(uid || "")}">${avatarInner(profile)}</span>`}
        <div class="chat-bubble-group">
          ${!mine && !grouped && showNames ? `<span class="chat-bubble-name">${nameWithBadge(profile.name || "Classmate", profile.email)}</span>` : ""}
          <div class="chat-bubble">${richTextHtml(m.text || "", [])}</div>
          <div class="chat-bubble-meta"><span>${timeLabel}</span>${showReceipt ? receiptIconHtml(seen, isLastMine) : ""}</div>
        </div>
      </div>`;
  });

  listEl.innerHTML = html;
  wireRichTextClicks(listEl);
  wireMessageLongPress(listEl);
}

const LONG_PRESS_MS = 420;
const LONG_PRESS_MOVE_TOLERANCE = 10; 
const messageTextCache = new Map(); 

function closeMessageActionMenu() {
  document.querySelector(".msg-action-backdrop")?.remove();
}
document.addEventListener("scroll", closeMessageActionMenu, true);

function wireMessageLongPress(listEl) {
  listEl.querySelectorAll(".chat-bubble-row").forEach((row) => {
    const bubble = row.querySelector(".chat-bubble");
    if (!bubble || bubble.dataset.longpressWired) return;
    bubble.dataset.longpressWired = "1";

    let pressTimer = null;
    let startX = 0, startY = 0;

    const cancelPress = () => clearTimeout(pressTimer);
    const startPress = (e) => {
      startX = e.clientX; startY = e.clientY;
      pressTimer = setTimeout(() => openMessageActionMenu(row), LONG_PRESS_MS);
    };
    const trackMove = (e) => {
      if (Math.abs(e.clientX - startX) > LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - startY) > LONG_PRESS_MOVE_TOLERANCE) {
        cancelPress();
      }
    };

    bubble.addEventListener("pointerdown", startPress);
    bubble.addEventListener("pointerup", cancelPress);
    bubble.addEventListener("pointerleave", cancelPress);
    bubble.addEventListener("pointercancel", cancelPress);
    bubble.addEventListener("pointermove", trackMove);
    bubble.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function openMessageActionMenu(row) {
  closeMessageActionMenu();
  const text = messageTextCache.get(row.dataset.msgId) || "";
  const canDelete = row.dataset.canDelete === "1";
  const mine = row.classList.contains("mine");

  const backdrop = document.createElement("div");
  backdrop.className = "msg-action-backdrop";
  backdrop.addEventListener("click", closeMessageActionMenu);

  const menu = document.createElement("div");
  menu.className = "msg-action-menu";
  menu.innerHTML = `
    <button type="button" class="msg-action-item" data-action="copy">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy
    </button>
    ${canDelete ? `<button type="button" class="msg-action-item danger" data-action="delete">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      Delete
    </button>` : ""}
  `;
  backdrop.appendChild(menu);
  document.body.appendChild(backdrop);

  const rowRect = row.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 8;
  let left = mine ? rowRect.right - menuRect.width : rowRect.left;
  left = Math.min(Math.max(left, 8), window.innerWidth - menuRect.width - 8);
  let top = rowRect.top - menuRect.height - gap; 
  if (top < 8) top = Math.min(rowRect.bottom + gap, window.innerHeight - menuRect.height - 8); 
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll(".msg-action-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      closeMessageActionMenu();
      if (action === "copy") {
        navigator.clipboard?.writeText(text)
          .then(() => showToast("Message copied"))
          .catch(() => showToast("Couldn't copy that message."));
      } else if (action === "delete") {
        confirmDialog({
          title: "Delete this message?",
          text: "This can't be undone.",
          onConfirm: () => {
            const listEl = row.closest(".chat-scroll");
            const msgId = row.dataset.msgId;
            if (listEl?.dataset.deleteHandler === "dm") deleteDmMessage(listEl.dataset.conversationId, msgId);
            else deleteClassChatMessage(msgId);
          }
        });
      }
    });
  });
}

function deleteClassChatMessage(msgId) {
  return deleteDoc(doc(db, "classChat", msgId)).catch((err) => {
    const { message, technical } = friendlyError(err, "Couldn't delete that message.");
    showToast(message, { details: technical });
  });
}

function paintClassChatOnlineCount() {
  if (!classChatOnlineCount) return;
  const students = getAllStudents();
  const onlineCount = students.filter(s => isUserOnline(getCachedProfile(s.uid))).length;
  classChatOnlineCount.textContent = onlineCount > 0
    ? `${onlineCount} classmate${onlineCount === 1 ? "" : "s"} online`
    : "";
  classChatOnlineCount.classList.toggle("online-now", onlineCount > 0);
}

function paintNavTotalBadge() {
  const total = dmUnreadTotal + classChatUnreadCount();
  navTotalBadges.forEach(el => {
    el.textContent = total > 99 ? "99+" : String(total);
    el.classList.toggle("hidden", total === 0);
  });
}

function classChatUnreadCount() {
  const myUid = auth.currentUser?.uid;
  return classChatMessages.filter(m =>
    m.authorUid !== myUid && (m.createdAt?.toMillis?.() || 0) > classChatLastReadMs
  ).length;
}

function paintClassChatBadge() {
  const count = classChatUnreadCount();
  if (classChatTabBadge) {
    classChatTabBadge.textContent = count > 99 ? "99+" : String(count);
    classChatTabBadge.classList.toggle("hidden", count === 0);
  }
  paintNavTotalBadge();
}

function markClassChatRead() {
  const myUid = auth.currentUser?.uid;
  if (!myUid) return;
  classChatLastReadMs = Date.now(); 
  paintClassChatBadge();
  setDoc(doc(db, "classChatReads", myUid), { lastReadAt: serverTimestamp() }, { merge: true }).catch(() => {});
}

function subscribeClassChatRead() {
  const myUid = auth.currentUser?.uid;
  if (!myUid || unsubscribeClassChatRead) return;
  unsubscribeClassChatRead = onSnapshotWithRetry(doc(db, "classChatReads", myUid), (snap) => {
    const lastReadAt = snap.data()?.lastReadAt;

    if (snap.metadata.hasPendingWrites && lastReadAt == null) return;
    classChatLastReadMs = snap.exists() ? (lastReadAt?.toMillis?.() || 0) : 0;
    paintClassChatBadge();
  }, () => {  });
}

function subscribeClassChat() {
  if (unsubscribeClassChat) return;
  const q = query(collection(db, "classChat"), orderBy("createdAt", "asc"), limitToLast(150));
  unsubscribeClassChat = onSnapshotWithRetry(q, (snap) => {
    const wasNearBottom = classChatAtBottom || classChatList.dataset.everLoaded !== "1";
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    classChatMessages = msgs;
    renderChatBubbles(classChatList, msgs, { emptyText: "No messages yet — say hello to the department!" });
    classChatList.dataset.everLoaded = "1";
    if (wasNearBottom) classChatList.scrollTop = classChatList.scrollHeight;
    if (isClassChatSubtabActive()) markClassChatRead();
    else paintClassChatBadge();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load Department Chat.");
    showToast(message, { details: technical });
  });
  classChatList.addEventListener("scroll", () => { classChatAtBottom = isNearBottom(classChatList); });
}

async function submitClassChat() {
  const text = classChatInput.value.trim();
  if (!text || classChatSendBtn.disabled) return;
  classChatInput.value = "";
  classChatSendBtn.disabled = true;
  classChatAtBottom = true; 
  try {
    const msgRef = await addDoc(collection(db, "classChat"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile?.name || auth.currentUser.email,
      text,
      createdAt: serverTimestamp()
    });
    triggerPush({
      type: "classChat",
      text,
      actorName: currentProfile?.name || auth.currentUser.email,
      messageId: msgRef.id
    });
  } catch (err) {
    classChatInput.value = text; 
    const { message, technical } = friendlyError(err, "Couldn't send that message.");
    showToast(message, { details: technical });
  }
}

let unsubscribeConversations = null;
let allConversations = [];

function otherParticipant(conv) {
  const myUid = auth.currentUser?.uid;
  return (conv.participants || []).find(uid => uid !== myUid) || null;
}

function paintTotalUnreadBadges() {
  const myUid = auth.currentUser?.uid;
  dmUnreadTotal = allConversations.reduce((sum, c) => sum + (Number(c.unread?.[myUid]) || 0), 0);
  if (dmTabBadge) {
    dmTabBadge.textContent = dmUnreadTotal > 99 ? "99+" : String(dmUnreadTotal);
    dmTabBadge.classList.toggle("hidden", dmUnreadTotal === 0);
  }
  paintNavTotalBadge();
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
      <button type="button" class="dm-conv-row" data-uid="${escapeAttr(uid)}">
        <span class="avatar-presence-wrap">
          <span class="avatar" data-author="${escapeHtml(uid)}">${avatarInner(profile)}</span>
          ${avatarPresenceDotHtml(uid, { label: true })}
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
  const q = query(collection(db, "conversations"), where("participants", "array-contains", myUid));
  unsubscribeConversations = onSnapshotWithRetry(q, (snap) => {
    allConversations = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(c => !isConversationHiddenForMe(c));
    renderConversationList();
    paintTotalUnreadBadges();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load your messages.");
    showToast(message, { details: technical });
  });
}

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
  updateDoc(doc(db, "conversations", conversationId), {
    [`unread.${myUid}`]: 0,
    [`lastReadAt.${myUid}`]: serverTimestamp()
  }).catch(() => {});
}

const DM_TYPING_RESEND_MS = 2500;
const DM_TYPING_IDLE_MS = 3000;
const DM_TYPING_STALE_MS = 6000;
let dmOtherReadAtMs = 0;
let dmOtherTypingUntilMs = 0;
let dmTypingIdleTimer = null;
let dmTypingCheckInterval = null;
let dmLastTypingSentAt = 0;

function dmTypingIndicatorEl() {
  return document.getElementById("dm-typing-indicator");
}

function paintDmTypingIndicator() {
  const el = dmTypingIndicatorEl();
  if (!el) return;
  el.classList.toggle("hidden", Date.now() >= dmOtherTypingUntilMs);
}

function sendMyTypingSignal(conversationId) {
  if (!conversationId || !auth.currentUser) return;
  const now = Date.now();
  if (now - dmLastTypingSentAt > DM_TYPING_RESEND_MS) {
    dmLastTypingSentAt = now;
    updateDoc(doc(db, "conversations", conversationId), {
      [`typing.${auth.currentUser.uid}`]: serverTimestamp()
    }).catch(() => {});
  }
  clearTimeout(dmTypingIdleTimer);
  dmTypingIdleTimer = setTimeout(() => clearMyTypingSignal(conversationId), DM_TYPING_IDLE_MS);
}

function clearMyTypingSignal(conversationId) {
  clearTimeout(dmTypingIdleTimer);
  dmTypingIdleTimer = null;
  dmLastTypingSentAt = 0;
  if (!conversationId || !auth.currentUser) return;
  updateDoc(doc(db, "conversations", conversationId), {
    [`typing.${auth.currentUser.uid}`]: deleteField()
  }).catch(() => {});
}

let currentDmUid = null;
let currentDmConversationId = null;
let unsubscribeDmMessages = null;
let unsubscribeDmConversation = null;
let dmThreadAtBottom = true;
const dmMessageCache = new Map();
const dmReadCache = new Map();
export function getOpenDmUid() { return currentDmUid; }

export function isDmThreadOpenWith(otherUid) {
  if (!otherUid || currentDmUid !== otherUid) return false;
  return !document.getElementById("section-dm-thread")?.classList.contains("hidden");
}

export function isClassChatOpen() {
  if (!isClassChatSubtabActive()) return false;
  return !document.getElementById("section-message")?.classList.contains("hidden");
}

export function teardownDmThread() {
  const conversationId = currentDmConversationId;
  if (unsubscribeDmMessages) unsubscribeDmMessages();
  if (unsubscribeDmConversation) unsubscribeDmConversation();
  unsubscribeDmMessages = null;
  unsubscribeDmConversation = null;
  currentDmUid = null;
  currentDmConversationId = null;
  dmOtherReadAtMs = 0;
  dmOtherTypingUntilMs = 0;
  if (dmTypingCheckInterval) clearInterval(dmTypingCheckInterval);
  dmTypingCheckInterval = null;
  clearMyTypingSignal(conversationId);
  paintDmTypingIndicator();
}

function dmThreadSkeletonHtml() {
  return `<div class="chat-empty" aria-hidden="true">Loading conversation…</div>`;
}

function paintDmBlockState(otherUid, blockedBy) {
  const myUid = auth.currentUser?.uid;
  const blockedByMe = blockedBy.includes(myUid);
  const blockedByThem = blockedBy.includes(otherUid);
  const blocked = blockedByMe || blockedByThem;

  dmThreadForm?.classList.toggle("hidden", blocked);
  dmThreadBlockedBar?.classList.toggle("hidden", !blocked);
  if (blocked && dmThreadBlockedText) {
    dmThreadBlockedText.textContent = blockedByMe
      ? "You've blocked this classmate."
      : "You can't message this classmate right now.";
  }
  dmThreadUnblockBtn?.classList.toggle("hidden", !blockedByMe);

  if (dmThreadBlockItem) {
    dmThreadBlockItem.textContent = blockedByMe ? "Unblock this classmate" : "Block this classmate";
    dmThreadBlockItem.classList.toggle("danger", !blockedByMe);
    dmThreadBlockItem.dataset.blocked = blockedByMe ? "1" : "0";
  }
  dmThreadMoreMenu?.classList.toggle("is-blocking", blockedByMe);
}

function renderDmThreadHeader(uid) {
  const profile = getCachedProfile(uid) || { uid, name: "Classmate" };
  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = profile.name || "Private Message";
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

function renderDmThreadNotFound() {
  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = "Private Message";
  dmThreadHeaderEl.innerHTML = `<div><span class="dm-thread-header-name">Classmate not found</span></div>`;
  dmThreadListEl.innerHTML = `<div class="chat-empty">This classmate couldn't be found — the link may be old or mistyped.</div>`;
  dmThreadListEl.dataset.everLoaded = "1";
  dmThreadForm?.classList.add("hidden");
  dmThreadBlockedBar?.classList.add("hidden");
}

export async function openDmThread(uid, { fromPopstate = false, replace = false } = {}) {
  if (!uid || !auth.currentUser || uid === auth.currentUser.uid) return;
  teardownDmThread();
  currentDmUid = uid;
  const likelyConversationId = dmConversationId(auth.currentUser.uid, uid);
  dmOtherReadAtMs = dmReadCache.get(likelyConversationId) || 0;
  dmOtherTypingUntilMs = 0;

  if (goToRouteRef) goToRouteRef("dm-thread", { fromPopstate, replace, state: { dmUid: uid } });
  
  let profile = getCachedProfile(uid);
  if (!profile) {
    try {
      profile = await fetchProfile(uid);
      if (profile) cacheUserProfile(uid, profile);
    } catch (err) {
      if (uid !== currentDmUid) return; 
      renderDmThreadNotFound();
      const { message, technical } = friendlyError(err, "Couldn't open this conversation.");
      showToast(message, { details: technical });
      return;
    }
  }
  if (uid !== currentDmUid) return; 
  if (!profile) {
    renderDmThreadNotFound();
    return;
  }

  const cachedMsgs = dmMessageCache.get(likelyConversationId);
  if (cachedMsgs) {
    dmThreadListEl.dataset.conversationId = likelyConversationId;
    dmThreadListEl.dataset.deleteHandler = "dm";
    renderChatBubbles(dmThreadListEl, cachedMsgs, { emptyText: "No messages yet — say hello 👋", showNames: false, seenUpToMs: dmOtherReadAtMs });
    dmThreadListEl.dataset.everLoaded = "1";
    dmThreadListEl.scrollTop = dmThreadListEl.scrollHeight;
  } else {
    dmThreadListEl.innerHTML = dmThreadSkeletonHtml();
    dmThreadListEl.dataset.everLoaded = "0";
  }
  dmThreadAtBottom = true;
  dmThreadForm?.classList.remove("hidden");
  dmThreadBlockedBar?.classList.add("hidden");
  dmThreadMoreMenu?.classList.remove("is-blocking");

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
  if (uid !== currentDmUid) return; 
  currentDmConversationId = conversationId;
  markConversationRead(conversationId);
  if (dmTypingCheckInterval) clearInterval(dmTypingCheckInterval);
  dmTypingCheckInterval = setInterval(paintDmTypingIndicator, 1000);

  unsubscribeDmConversation = onSnapshotWithRetry(doc(db, "conversations", conversationId), (snap) => {
    if (conversationId !== currentDmConversationId) return;
    const data = snap.data() || {};
    paintDmBlockState(uid, data.blockedBy || []);
    dmOtherReadAtMs = data.lastReadAt?.[uid]?.toMillis?.() || 0;
    dmReadCache.set(conversationId, dmOtherReadAtMs);
    const otherTypingMs = data.typing?.[uid]?.toMillis?.() || 0;
    dmOtherTypingUntilMs = otherTypingMs ? otherTypingMs + DM_TYPING_STALE_MS : 0;
    paintDmTypingIndicator();
    const cached = dmMessageCache.get(conversationId);
    if (cached) renderChatBubbles(dmThreadListEl, cached, { emptyText: "No messages yet — say hello 👋", showNames: false, seenUpToMs: dmOtherReadAtMs });
  });

  const q = query(collection(db, "conversations", conversationId, "messages"), orderBy("createdAt", "asc"));
  unsubscribeDmMessages = onSnapshotWithRetry(q, (snap) => {
    if (conversationId !== currentDmConversationId) return;
    const wasNearBottom = dmThreadAtBottom || dmThreadListEl.dataset.everLoaded !== "1";
    const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    dmMessageCache.set(conversationId, msgs);
    dmThreadListEl.dataset.conversationId = conversationId;
    dmThreadListEl.dataset.deleteHandler = "dm";
    renderChatBubbles(dmThreadListEl, msgs, { emptyText: "No messages yet — say hello 👋", showNames: false, seenUpToMs: dmOtherReadAtMs });
    dmThreadListEl.dataset.everLoaded = "1";
    if (wasNearBottom) dmThreadListEl.scrollTop = dmThreadListEl.scrollHeight;
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
  if (dmThreadForm?.classList.contains("hidden")) return; 
  dmThreadInput.value = "";
  dmThreadSendBtn.disabled = true;
  dmThreadAtBottom = true;
  clearMyTypingSignal(conversationId);
  try {
    const myUid = auth.currentUser.uid;
    const msgRef = await addDoc(collection(db, "conversations", conversationId, "messages"), {
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
    triggerPush({
      type: "dm",
      text,
      actorName: currentProfile?.name || auth.currentUser.email,
      targetUid: otherUid,
      conversationId,
      messageId: msgRef.id
    });
  } catch (err) {
    dmThreadInput.value = text;
    const { message, technical } = friendlyError(err, "Couldn't send that message.");
    showToast(message, { details: technical });
  }
}

export function initMessages() {
  wireSubtabs();

  classChatForm?.addEventListener("submit", (e) => { e.preventDefault(); submitClassChat(); });
  classChatInput?.addEventListener("input", () => { classChatSendBtn.disabled = !classChatInput.value.trim(); });
  subscribeClassChat();
  subscribeClassChatRead();
  paintClassChatOnlineCount();

  dmThreadForm?.addEventListener("submit", (e) => { e.preventDefault(); submitDmMessage(); });
  dmThreadInput?.addEventListener("input", () => {
    dmThreadSendBtn.disabled = !dmThreadInput.value.trim();
    if (dmThreadInput.value.trim()) sendMyTypingSignal(currentDmConversationId);
    else clearMyTypingSignal(currentDmConversationId);
  });

  wireKebabMenus(document.getElementById("dm-thread-header-row"), {
    block: () => {
      const otherUid = currentDmUid;
      if (!otherUid) return;
      const alreadyBlocked = dmThreadBlockItem?.dataset.blocked === "1";
      if (alreadyBlocked) {
        setDmBlocked(otherUid, false).catch((err) => {
          const { message, technical } = friendlyError(err, "Couldn't unblock this classmate.");
          showToast(message, { details: technical });
        });
        return;
      }
      const name = getCachedProfile(otherUid)?.name || "this classmate";
      confirmDialog({
        title: "Block this classmate?",
        text: `${name} won't be able to send you messages until you unblock them.`,
        confirmLabel: "Block",
        onConfirm: () => setDmBlocked(otherUid, true)
      });
    },
    "delete-conversation": () => {
      const conversationId = currentDmConversationId;
      if (!conversationId) return;
      const name = getCachedProfile(currentDmUid)?.name || "this classmate";
      confirmDialog({
        title: "Delete this conversation?",
        text: `This will remove your conversation with ${name} from your chat list. ${name} will still be able to see it on their side.`,
        confirmLabel: "Delete",
        onConfirm: () => deleteConversationForMe(conversationId).then(() => {
          closeModal({ keepHistory: true });
          if (goToRouteRef) goToRouteRef("message", { replace: true });
        })
      });
    }
  });
  dmThreadUnblockBtn?.addEventListener("click", () => {
    if (currentDmUid) setDmBlocked(currentDmUid, false).catch((err) => {
      const { message, technical } = friendlyError(err, "Couldn't unblock this classmate.");
      showToast(message, { details: technical });
    });
  });
  dmThreadBackBtn?.addEventListener("click", () => {
    const from = history.state?.from;
    if (from && goBackToRouteRef) goBackToRouteRef(from);
    else history.back();
  });

  subscribeConversations();

  subscribeToProfileUpdates((uid) => {
    const profile = getCachedProfile(uid);
    if (!profile) return;
    document.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => { el.innerHTML = avatarInner(profile); });
    paintClassChatOnlineCount();
    if (uid === currentDmUid) renderDmThreadHeader(uid);
    if (allConversations.some(c => otherParticipant(c) === uid)) renderConversationList();
  });
  setInterval(paintClassChatOnlineCount, 20_000);
}

export function teardownMessages() {
  if (unsubscribeClassChat) unsubscribeClassChat();
  unsubscribeClassChat = null;
  if (unsubscribeClassChatRead) unsubscribeClassChatRead();
  unsubscribeClassChatRead = null;
  if (unsubscribeConversations) unsubscribeConversations();
  unsubscribeConversations = null;
  allConversations = [];
  teardownDmThread();
}
