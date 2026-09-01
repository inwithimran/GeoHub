import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, doc, getDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where,
  serverTimestamp, arrayUnion, arrayRemove, getDocs, deleteField, startAfter, getCountFromServer
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile, fetchProfile } from "./auth.js";
import {
  showToast, escapeHtml, timeAgo, openModal, closeModal,
  setBtnLoading, cacheUserProfile, getCachedProfile, clampableRichHtml, attachClampToggle,
  avatarInner, nameWithBadge, kebabMenuHtml, wireKebabMenus, confirmDialog, isAdminEmail,
  extractHashtags, wireRichTextClicks, wireMentionAutocomplete, skeletonRowsHtml, wireCharCounter,
  ensureProfileLoaded, subscribeToProfileUpdates, friendlyError
} from "./ui-utils.js";
import { openUserProfilePage } from "./profile-view.js";
import { avatarPresenceDotHtml } from "./presence.js";
import { uploadImages } from "./cloudinary.js";
import { logActivity, deleteActivityForPost } from "./routine.js";
import { triggerPush } from "./push-trigger.js";
import { imagePickerHtml, wireImagePicker, postImagesHtml, applyPostImageRatios } from "./media-picker.js";
import { getAllStudents } from "./directory.js";
import { callApi } from "./api-client.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import { enqueueWrite, registerWriteHandler, isNetworkError } from "./write-queue.js";

export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢"];
const DEFAULT_REACTION = "👍";
const OUTLINE_LEAF_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 4c-8 0-16 4-16 13 0 1.5.3 2.6.8 3.4C6 15 11 9 18 6c-6 4-10 10-12.4 13.7.5.2 1 .3 1.4.3C16 20 20 12 20 4z"/></svg>`;

function reactionsOf(post) {
  return post.reactions || Object.fromEntries((post.likes || []).map((uid) => [uid, DEFAULT_REACTION]));
}

const commentCountCache = new Map();

export function setCommentCountCache(postId, count) {
  commentCountCache.set(postId, count);
}

async function fetchCommentCount(postId) {
  if (commentCountCache.has(postId)) return commentCountCache.get(postId);
  try {
    const snap = await getCountFromServer(collection(db, "posts", postId, "comments"));
    const count = snap.data().count;
    commentCountCache.set(postId, count);
    return count;
  } catch {
    return 0;
  }
}

export function commentCountLabel(count) {
  return `${count} ${count === 1 ? "comment" : "comments"}`;
}

export function paintCommentCountBtn(btnEl, count) {
  if (!btnEl) return;
  btnEl.textContent = commentCountLabel(count);
  btnEl.classList.toggle("hidden", count === 0);
  btnEl.dataset.count = String(count);
}

export function updateStatsRowVisibility(root) {
  const statsRow = root.querySelector(".post-stats");
  if (!statsRow) return;
  const likeBtn = statsRow.querySelector(".post-like-count");
  const commentBtn = statsRow.querySelector(".stats-comment-count");
  const hasLikes = likeBtn && !likeBtn.classList.contains("hidden");
  const hasComments = commentBtn && !commentBtn.classList.contains("hidden");
  statsRow.classList.toggle("hidden", !hasLikes && !hasComments);
}

function wireStatsCommentCount(root, postId, initialCount) {
  const btn = root.querySelector(".stats-comment-count");
  if (!btn) return;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const { openPostDetailPage } = await import("./post-detail.js");
    openPostDetailPage(postId, { focusComment: true });
  });
  if (initialCount != null) {
    paintCommentCountBtn(btn, initialCount);
    updateStatsRowVisibility(root);
    return;
  }
  fetchCommentCount(postId).then((count) => {
    if (!document.body.contains(btn)) return;
    paintCommentCountBtn(btn, count);
    updateStatsRowVisibility(root);
  });
}

export function wireMentions(fieldEl, initial = []) {
  const picked = new Map((initial || []).filter(m => m && m.uid && m.name).map(m => [m.name, m]));
  wireMentionAutocomplete(
    fieldEl,
    (query) => {
      const q = query.toLowerCase();
      return getAllStudents().filter((s) =>
        s.uid && s.uid !== auth.currentUser?.uid && (s.name || "").toLowerCase().includes(q));
    },
    (candidate) => picked.set(candidate.name, { uid: candidate.uid, name: candidate.name })
  );
  return {
    getMentions: () => [...picked.values()].filter((m) => fieldEl.value.includes(`@${m.name}`))
  };
}

const wallList = document.getElementById("wall-list");
const composerTrigger = document.getElementById("composer-trigger");

let unsubscribePosts = null;

const WALL_PAGE_SIZE = 20;
let liveDocs = [];     
let olderDocs = [];    
let hasMoreOlder = true; 
let loadingOlder = false; 
let wallScrollObserver = null;

const POST_TEXT_LIMIT = 3000;

export function authorProfile(uid, fallbackName) {
  const cached = getCachedProfile(uid);
  if (!cached) ensureProfileLoaded(uid); 
  return cached || { uid, name: fallbackName };
}

function refreshAuthorAvatars(uid) {
  const profile = getCachedProfile(uid);
  if (!profile) return;
  document.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
}

export function initWall(onSnapshotReceived) {
  composerTrigger.addEventListener("click", openComposerModal);
  subscribeToProfileUpdates(refreshAuthorAvatars);
  subscribeWall(onSnapshotReceived);
}

function subscribeWall(onSnapshotReceived) {
  if (unsubscribePosts) unsubscribePosts();
  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(WALL_PAGE_SIZE));
  unsubscribePosts = onSnapshotWithRetry(q, (snap) => {
    liveDocs = snap.docs;
    renderWallList();
    if (onSnapshotReceived) onSnapshotReceived(snap);
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load the wall.");
    showToast(message, { details: technical });
  });
}

function renderWallList() {
  if (!liveDocs.length && !olderDocs.length) {
    wallList.innerHTML = `<p class="empty-state">No posts yet. Be the first to write on the wall.</p>`;
    return;
  }
  wallList.innerHTML = `<div class="flat-list feed-list"></div>`;
  const listEl = wallList.querySelector(".feed-list");
  const docs = [...liveDocs, ...olderDocs].sort((a, b) => (b.data().pinned ? 1 : 0) - (a.data().pinned ? 1 : 0));
  docs.forEach((docSnap) => renderPost(docSnap.id, docSnap.data(), listEl, { onChanged: () => refreshStaticPost(docSnap.id) }));

  if (wallScrollObserver) wallScrollObserver.disconnect();
  if (hasMoreOlder) {
    const sentinel = document.createElement("div");
    sentinel.className = "wall-load-sentinel";
    sentinel.innerHTML = `<span class="btn-spinner dark" aria-hidden="true"></span>`;
    wallList.appendChild(sentinel);
    wallScrollObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) loadOlderPosts();
    }, { rootMargin: "600px 0px" });
    wallScrollObserver.observe(sentinel);
  } else if (docs.length) {
    wallList.insertAdjacentHTML("beforeend", `<p class="wall-feed-end">You're all caught up 🌿</p>`);
  }
}

async function loadOlderPosts() {
  if (loadingOlder || !hasMoreOlder) return;
  const cursor = olderDocs.length ? olderDocs[olderDocs.length - 1] : liveDocs[liveDocs.length - 1];
  if (!cursor) return;
  loadingOlder = true;
  try {
    const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), startAfter(cursor), limit(WALL_PAGE_SIZE));
    const snap = await getDocs(q);
    olderDocs = olderDocs.concat(snap.docs);
    hasMoreOlder = snap.size === WALL_PAGE_SIZE;
    renderWallList();
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't load earlier posts.");
    showToast(message, { details: technical });
  } finally {
    loadingOlder = false;
  }
}

async function refreshStaticPost(postId) {
  if (liveDocs.some((d) => d.id === postId)) return; 
  try {
    const snap = await getDoc(doc(db, "posts", postId));
    olderDocs = snap.exists()
      ? olderDocs.map((d) => (d.id === postId ? snap : d))
      : olderDocs.filter((d) => d.id !== postId);
    renderWallList();
  } catch {  }
}

function openComposerModal() {
  openModal(`
    <div class="composer-modal">
      <div class="composer-modal-head">
        <div class="avatar">${avatarInner(currentProfile || {})}</div>
        <div>
          <strong>${nameWithBadge(currentProfile ? currentProfile.name : "You", currentProfile ? currentProfile.email : "")}</strong>
          <small>Posting to the Student Wall</small>
        </div>
      </div>
      <textarea id="post-input" class="composer-modal-textarea" placeholder="Ask a question or share something with the department… (@mention a classmate, #tag a topic)" rows="6" maxlength="${POST_TEXT_LIMIT}" autofocus></textarea>
      ${imagePickerHtml("post-image-input")}
      <button type="button" class="composer-poll-toggle" id="poll-toggle-btn">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        <span>Add a poll</span>
      </button>
      <div class="poll-builder hidden" id="poll-builder">
        <div class="poll-builder-options" id="poll-options"></div>
        <button type="button" class="poll-add-option-btn" id="poll-add-option">+ Add option</button>
        <p class="modal-hint">Your post text above is the poll question.</p>
      </div>
      <p id="post-error" class="form-error"></p>
      <button type="button" id="post-submit" class="btn-primary full raised composer-post-btn">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <span>Post to Wall</span>
      </button>
    </div>
  `);
  const textarea = document.getElementById("post-input");
  textarea.focus();
  wireCharCounter(textarea, POST_TEXT_LIMIT);
  const { getFiles } = wireImagePicker(document.getElementById("modal-body"), "post-image-input");
  const { getMentions } = wireMentions(textarea);
  const { getPoll, pollEnabled } = wirePollBuilder();
  document.getElementById("post-submit").addEventListener("click", () => handleCreatePost(getFiles, getMentions, getPoll));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreatePost(getFiles, getMentions, getPoll);
  });
}

const POLL_MIN_OPTIONS = 2;
const POLL_MAX_OPTIONS = 6;

function wirePollBuilder() {
  const toggleBtn = document.getElementById("poll-toggle-btn");
  const builder = document.getElementById("poll-builder");
  const optionsWrap = document.getElementById("poll-options");
  const addBtn = document.getElementById("poll-add-option");
  let enabled = false;

  function addRow() {
    const row = document.createElement("div");
    row.className = "poll-option-row";
    row.innerHTML = `
      <span class="poll-option-index"></span>
      <input type="text" class="poll-option-input" maxlength="80" />
      <button type="button" class="poll-option-remove-btn" aria-label="Remove this option">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;
    row.querySelector(".poll-option-remove-btn").addEventListener("click", () => {
      if (optionsWrap.children.length <= POLL_MIN_OPTIONS) return;
      row.remove();
      renumber();
    });
    optionsWrap.appendChild(row);
    renumber();
  }

  function renumber() {
    const rows = [...optionsWrap.querySelectorAll(".poll-option-row")];
    rows.forEach((row, i) => {
      row.querySelector(".poll-option-index").textContent = i + 1;
      row.querySelector(".poll-option-input").placeholder = `Option ${i + 1}`;
      row.querySelector(".poll-option-remove-btn").classList.toggle("is-disabled", rows.length <= POLL_MIN_OPTIONS);
    });
    addBtn.classList.toggle("is-disabled", rows.length >= POLL_MAX_OPTIONS);
  }

  for (let i = 0; i < POLL_MIN_OPTIONS; i++) addRow();

  toggleBtn.addEventListener("click", () => {
    enabled = !enabled;
    builder.classList.toggle("hidden", !enabled);
    toggleBtn.classList.toggle("active", enabled);
    toggleBtn.querySelector("span").textContent = enabled ? "Remove poll" : "Add a poll";
  });
  addBtn.addEventListener("click", () => {
    if (optionsWrap.children.length >= POLL_MAX_OPTIONS) return;
    addRow();
  });

  return {
    pollEnabled: () => enabled,
    getPoll: () => {
      if (!enabled) return null;
      const options = [...optionsWrap.querySelectorAll(".poll-option-input")]
        .map((el, i) => ({ id: `opt${i}`, text: el.value.trim() }))
        .filter((o) => o.text);
      return options.length >= 2 ? { options, votes: {} } : null;
    }
  };
}

async function handleCreatePost(getImageFiles, getMentions, getPoll) {
  const textarea = document.getElementById("post-input");
  const btn = document.getElementById("post-submit");
  if (btn.disabled) return; 
  const errorEl = document.getElementById("post-error");
  const text = textarea.value.trim();
  errorEl.textContent = "";

  if (!text) { errorEl.textContent = "Write something before posting."; return; }
  if (!currentProfile) { errorEl.textContent = "Your profile hasn't loaded yet — try again in a second."; return; }

  const poll = getPoll ? getPoll() : null;
  const mentions = getMentions ? getMentions() : [];
  const files = getImageFiles ? getImageFiles() : [];

  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    await queuePost({ text, images: files, mentions, poll, authorName: currentProfile.name });
    closeModal();
    showToast("You're offline — this post will send automatically once you're back online.");
    return;
  }

  setBtnLoading(btn, true, "Posting…");
  try {
    let images = [];
    if (files.length) {
      setBtnLoading(btn, true, "Uploading photos…");
      images = await uploadImages(files, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
      setBtnLoading(btn, true, "Posting…");
    }
    const { id: postId } = await callApi("create-post", { text, images, mentions, poll });
    closeModal();
    showToast("Posted to the Student Wall.");
    logActivity({ type: "post", text, postId });
    triggerPush({ type: "post", text, actorName: currentProfile.name, postId });
    notifyMentions(mentions, text, postId);
  } catch (err) {
    if (isNetworkError(err)) {
      await queuePost({ text, images: files, mentions, poll, authorName: currentProfile.name });
      closeModal();
      showToast("Couldn't reach the network — this post is queued and will send automatically once you're back online.");
      return;
    }
    errorEl.textContent = "Couldn't publish your post: " + err.message;
    setBtnLoading(btn, false);
  }
}

function queuePost({ text, images, mentions, poll, authorName }) {
  return enqueueWrite("create-post", { text, images, mentions, poll, authorName });
}

registerWriteHandler("create-post", async (payload) => {
  let images = [];
  if (payload.images && payload.images.length) {
    images = await uploadImages(payload.images, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
  }
  const { id: postId } = await callApi("create-post", {
    text: payload.text, images, mentions: payload.mentions, poll: payload.poll
  }, { skipClientCooldown: true });
  showToast("A queued post just went out to the Student Wall.");
  logActivity({ type: "post", text: payload.text, postId });
  triggerPush({ type: "post", text: payload.text, actorName: payload.authorName, postId });
  notifyMentions(payload.mentions, payload.text, postId);
});

function notifyMentions(mentions, text, postId) {
  (mentions || []).forEach((m) => {
    if (!m.uid || m.uid === auth.currentUser.uid) return;
    logActivity({ type: "mention", text, targetUid: m.uid, postId });
    triggerPush({ type: "mention", text, actorName: currentProfile.name, targetUid: m.uid, postId });
  });
}

export function openEditPostModal(postId, currentText, onSaved, currentImages = [], currentMentions = []) {
  openModal(`
    <div class="composer-modal">
      <div class="composer-modal-head">
        <div class="avatar">${avatarInner(currentProfile || {})}</div>
        <div>
          <strong>${nameWithBadge(currentProfile ? currentProfile.name : "You", currentProfile ? currentProfile.email : "")}</strong>
          <small>Editing your post</small>
        </div>
      </div>
      <textarea id="post-edit-input" class="composer-modal-textarea" rows="6" maxlength="${POST_TEXT_LIMIT}">${escapeHtml(currentText)}</textarea>
      ${imagePickerHtml("post-edit-image-input")}
      <p id="post-edit-error" class="form-error"></p>
      <button type="button" class="btn-primary full raised composer-post-btn" id="post-edit-save-btn">Save Changes</button>
    </div>
  `);
  const modalBody = document.getElementById("modal-body");
  const { getRemainingUrls, getFiles } = wireImagePicker(modalBody, "post-edit-image-input", { existingImages: currentImages });
  const { getMentions } = wireMentions(document.getElementById("post-edit-input"), currentMentions);
  wireCharCounter(document.getElementById("post-edit-input"), POST_TEXT_LIMIT);

  document.getElementById("post-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("post-edit-input").value.trim();
    const errorEl = document.getElementById("post-edit-error");
    if (!text) { errorEl.textContent = "Post can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      const newFiles = getFiles();
      let uploaded = [];
      if (newFiles.length) {
        setBtnLoading(e.currentTarget, true, "Uploading photos…");
        uploaded = await uploadImages(newFiles, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
      }
      const images = [...getRemainingUrls(), ...uploaded];
      const mentions = getMentions();
      const hashtags = extractHashtags(text);
      await updateDoc(doc(db, "posts", postId), { text, images, mentions, hashtags, editedAt: serverTimestamp() });
      closeModal();
      showToast("Post updated.");
      onSaved?.();
      notifyMentions(mentions.filter(m => !currentMentions.some(c => c.uid === m.uid)), text, postId);
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}

async function reportPost(postId, post) {
  openModal(`
    <h3>Report this post</h3>
    <p class="modal-hint">This sends a note to the class admin/CR — it won't notify or affect the post's author.</p>
    <textarea id="report-reason-input" class="composer-modal-textarea" rows="3" placeholder="What's wrong with this post? (optional)"></textarea>
    <p id="report-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="report-submit-btn">Send Report</button>
  `);
  document.getElementById("report-submit-btn").addEventListener("click", async (e) => {
    setBtnLoading(e.currentTarget, true, "Sending…");
    try {
      const reason = document.getElementById("report-reason-input").value.trim();
      const reportRef = await addDoc(collection(db, "reports"), {
        postId,
        postAuthorUid: post.authorUid,
        postText: (post.text || "").slice(0, 300),
        reason,
        reportedByUid: auth.currentUser.uid,
        reportedByName: currentProfile ? currentProfile.name : "A classmate",
        createdAt: serverTimestamp(),
        resolved: false
      });
      closeModal();
      showToast("Report sent to the admin. Thanks for flagging it.");
      triggerPush({ type: "report", text: reason, actorName: currentProfile ? currentProfile.name : "A classmate", reportId: reportRef.id });
    } catch (err) {
      document.getElementById("report-error").textContent = "Couldn't send report: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}

export async function deletePost(postId, onDeleted) {
  const commentsSnap = await getDocs(collection(db, "posts", postId, "comments"));
  await Promise.all(commentsSnap.docs.map(c => deleteDoc(c.ref)));
  await deleteDoc(doc(db, "posts", postId));
  deleteActivityForPost(postId); 
  showToast("Post deleted.");
  onDeleted?.();
}

export function renderPost(postId, post, listEl, { onChanged } = {}) {
  const uid = auth.currentUser.uid;
  const reactions = reactionsOf(post);
  const myReaction = reactions[uid] || null;
  const reactionCount = Object.keys(reactions).length;

  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;
  const isAdmin = isAdminEmail(auth.currentUser.email);
  const el = document.createElement("article");
  el.className = "feed-post" + (post.pinned ? " feed-post-pinned" : "");
  el.dataset.postId = postId;
  let kebabActions = [];
  if (isOwnPost) kebabActions.push({ action: "edit", label: "Edit Post" });
  if (isAdmin) kebabActions.push({ action: "pin", label: post.pinned ? "Unpin Post" : "Pin Post" });
  if (isOwnPost) kebabActions.push({ action: "delete", label: "Delete Post", danger: true });
  else if (isAdmin) kebabActions.push({ action: "delete", label: "Remove Post (Admin)", danger: true });
  else kebabActions.push({ action: "report", label: "Report Post" });

  el.innerHTML = `
    <div class="post-head">
      <span class="avatar-presence-wrap">
        <button type="button" class="avatar avatar-btn" data-author="${post.authorUid}" aria-label="View ${escapeHtml(author.name || post.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
        ${avatarPresenceDotHtml(post.authorUid)}
      </span>
      <div class="post-meta">
        <button type="button" class="post-author-name" data-author="${post.authorUid}">${nameWithBadge(post.authorName, post.authorEmail)}</button>
        <small>${post.pinned ? "📌 Pinned · " : ""}${timeAgo(post.createdAt)}${post.editedAt ? " · edited" : ""}</small>
      </div>
      ${kebabMenuHtml(postId, kebabActions)}
    </div>
    ${clampableRichHtml(post.text, post.mentions, "post-text")}
    ${postImagesHtml(post.images)}
    ${pollHtml(post)}
    <div class="post-stats hidden">
      <button type="button" class="post-like-count ${reactionCount ? "" : "hidden"}" data-id="${postId}">
        ${reactionSummaryHtml(reactions)}
      </button>
      <button type="button" class="stats-comment-count hidden" data-id="${postId}"></button>
    </div>
    <div class="post-actions">
      <div class="reaction-control">
        <button type="button" class="post-action-btn reaction-btn ${myReaction ? "liked" : ""}" data-id="${postId}" aria-pressed="${!!myReaction}">
          <span class="reaction-icon" aria-hidden="true">${myReaction || OUTLINE_LEAF_SVG}</span>
          <span>${myReaction ? "Reacted" : "Like"}</span>
        </button>
        <div class="reaction-picker hidden">
          ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-option" data-emoji="${e}">${e}</button>`).join("")}
        </div>
      </div>
      <button class="post-action-btn comment-toggle-btn" data-id="${postId}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span>Comment</span>
      </button>
    </div>
  `;

  const reactionBtn = el.querySelector(".reaction-btn");
  const likeCountBtn = el.querySelector(".post-like-count");

  el.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(post.authorUid)));
  wireReactionControl(el, postId, post);
  likeCountBtn.addEventListener("click", () => openReactionsModal(reactionsOf(post)));
  wireStatsCommentCount(el, postId);
  updateStatsRowVisibility(el);
  el.querySelector(".comment-toggle-btn").addEventListener("click", async () => {
    const { openPostDetailPage } = await import("./post-detail.js");
    openPostDetailPage(postId, { focusComment: true });
  });
  el.addEventListener("click", async (e) => {
    if (e.target.closest(".reaction-control, .post-stats, .kebab-menu, [data-author], .comment-toggle-btn, .clamp-toggle, .mention-chip, .hashtag-chip, .poll-block")) return;
    const { openPostDetailPage } = await import("./post-detail.js");
    openPostDetailPage(postId);
  });
  attachClampToggle(el);
  wireRichTextClicks(el);
  applyPostImageRatios(el);
  wirePoll(el, postId, post);
  wireKebabMenus(el, {
    edit: () => openEditPostModal(postId, post.text, onChanged, post.images || [], post.mentions || []),
    pin: () => togglePinPost(postId, !!post.pinned),
    delete: () => confirmDialog({
      title: isOwnPost ? "Delete this post?" : "Remove this post?",
      text: isOwnPost
        ? "This post and all of its comments will be removed from the Wall. This can't be undone."
        : "This will remove the post and its comments from the Wall for everyone. This can't be undone.",
      confirmLabel: isOwnPost ? "Delete" : "Remove",
      onConfirm: () => deletePost(postId, onChanged)
    }),
    report: () => reportPost(postId, post)
  });

  listEl.appendChild(el);
}

function reactionSummaryHtml(reactions) {
  const counts = {};
  Object.values(reactions).forEach((e) => { counts[e] = (counts[e] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  const total = Object.keys(reactions).length;
  return `<span class="reaction-summary-emojis">${top.join("")}</span> ${total} ${total === 1 ? "reaction" : "reactions"}`;
}

export function paintReactionButton(btnEl, countEl, post) {
  const uid = auth.currentUser.uid;
  const reactions = reactionsOf(post);
  const mine = reactions[uid] || null;
  btnEl.classList.toggle("liked", !!mine);
  btnEl.setAttribute("aria-pressed", String(!!mine));
  const iconEl = btnEl.querySelector(".reaction-icon");
  if (iconEl) iconEl.innerHTML = mine || OUTLINE_LEAF_SVG;
  const label = btnEl.querySelectorAll(":scope > span")[1];
  if (label) label.textContent = mine ? "Reacted" : "Like";
  const total = Object.keys(reactions).length;
  countEl.classList.toggle("hidden", total === 0);
  countEl.innerHTML = reactionSummaryHtml(reactions);
  const scopeEl = countEl.closest(".feed-post") || countEl.closest("article") || document;
  updateStatsRowVisibility(scopeEl);
}

function closeAllReactionPickers() {
  document.querySelectorAll(".reaction-picker").forEach(p => p.classList.add("hidden"));
}
document.addEventListener("click", closeAllReactionPickers);

export function wireReactionControl(root, postId, post) {
  const btn = root.querySelector(".reaction-btn");
  const picker = root.querySelector(".reaction-picker");
  const countEl = root.querySelector(".post-like-count");
  let pressTimer = null;
  let longPressed = false;

  const startPress = () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      closeAllReactionPickers();
      picker.classList.remove("hidden");
    }, 380);
  };
  const cancelPress = () => clearTimeout(pressTimer);

  btn.addEventListener("pointerdown", startPress);
  btn.addEventListener("pointerup", cancelPress);
  btn.addEventListener("pointerleave", cancelPress);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (longPressed) { longPressed = false; return; }
    const mine = reactionsOf(post)[auth.currentUser.uid] || null;
    reactToPost(postId, post, mine ? null : DEFAULT_REACTION, btn, countEl);
  });
  picker.querySelectorAll(".reaction-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      picker.classList.add("hidden");
      reactToPost(postId, post, opt.dataset.emoji, btn, countEl);
    });
  });
}

export async function reactToPost(postId, post, emoji, btnEl, countEl) {
  const uid = auth.currentUser.uid;
  const current = reactionsOf(post)[uid] || null;
  const next = (emoji && emoji !== current) ? emoji : null;
  const authorUid = post.authorUid;

  post.reactions = { ...reactionsOf(post) };
  if (next) post.reactions[uid] = next; else delete post.reactions[uid];
  post.likes = Object.keys(post.reactions);
  paintReactionButton(btnEl, countEl, post);

  btnEl.disabled = true;
  btnEl.classList.add("like-pop");
  const ref = doc(db, "posts", postId);
  try {
    await updateDoc(ref, {
      likes: next ? arrayUnion(uid) : arrayRemove(uid),
      [`reactions.${uid}`]: next ? next : deleteField()
    });
    if (next && !current && authorUid && authorUid !== uid) {
      logActivity({ type: "like", targetUid: authorUid, postId });
      triggerPush({ type: "like", actorName: currentProfile.name, targetUid: authorUid, postId });
    }
  } catch (err) {
    post.reactions = { ...reactionsOf(post) };
    if (current) post.reactions[uid] = current; else delete post.reactions[uid];
    post.likes = Object.keys(post.reactions);
    paintReactionButton(btnEl, countEl, post);
    const { message, technical } = friendlyError(err, "Couldn't update your reaction.");
    showToast(message, { details: technical });
  } finally {
    btnEl.disabled = false;
    setTimeout(() => btnEl.classList.remove("like-pop"), 260);
  }
}

export async function openReactionsModal(reactions) {
  const uids = Object.keys(reactions || {});
  if (!uids.length) return;
  openModal(`<h3>Reactions</h3>${skeletonRowsHtml(Math.min(uids.length, 4))}`);

  const people = await Promise.all(uids.map(async (uid) => {
    let p = getCachedProfile(uid);
    if (!p) {
      try { p = await fetchProfile(uid); if (p) cacheUserProfile(uid, p); } catch {}
    }
    return p ? { ...p, uid, emoji: reactions[uid] } : { uid, name: "Classmate", emoji: reactions[uid] };
  }));

  openModal(`
    <h3>Reactions</h3>
    <div class="flat-list likes-list">
      ${people.map(p => `
        <button type="button" class="directory-row likes-row" data-uid="${p.uid}">
          <div class="avatar">${avatarInner(p)}</div>
          <div class="directory-info"><strong>${nameWithBadge(p.name, p.email)}</strong></div>
          <span class="reaction-emoji-tag">${p.emoji}</span>
        </button>
      `).join("")}
    </div>
  `);
  document.querySelectorAll(".likes-row").forEach(row =>
    row.addEventListener("click", () => {
      closeModal({ keepHistory: true });
      openUserProfilePage(row.dataset.uid, { replace: true });
    }));
}

export function paintCommentReactionButton(btnEl, countEl, comment) {
  const uid = auth.currentUser.uid;
  const reactions = comment.reactions || {};
  const mine = reactions[uid] || null;
  btnEl.classList.toggle("liked", !!mine);
  btnEl.setAttribute("aria-pressed", String(!!mine));
  const iconEl = btnEl.querySelector(".reaction-icon");
  if (iconEl) iconEl.innerHTML = mine || OUTLINE_LEAF_SVG;
  const label = btnEl.querySelectorAll(":scope > span")[1];
  if (label) label.textContent = mine ? "Reacted" : "Like";
  const total = Object.keys(reactions).length;
  if (countEl) {
    countEl.classList.toggle("hidden", total === 0);
    countEl.innerHTML = reactionSummaryHtml(reactions);
  }
}

export function wireCommentReactionControl(root, postId, commentId, comment) {
  const btn = root.querySelector(`.comment-reaction-btn[data-id="${commentId}"]`);
  if (!btn) return;
  const control = btn.closest(".comment-reaction-control");
  const picker = control.querySelector(".reaction-picker");
  const countEl = root.querySelector(`.comment-reaction-count[data-id="${commentId}"]`);
  let pressTimer = null;
  let longPressed = false;

  const startPress = () => {
    longPressed = false;
    pressTimer = setTimeout(() => {
      longPressed = true;
      closeAllReactionPickers();
      picker.classList.remove("hidden");
    }, 380);
  };
  const cancelPress = () => clearTimeout(pressTimer);

  btn.addEventListener("pointerdown", startPress);
  btn.addEventListener("pointerup", cancelPress);
  btn.addEventListener("pointerleave", cancelPress);
  btn.addEventListener("contextmenu", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (longPressed) { longPressed = false; return; }
    const mine = (comment.reactions || {})[auth.currentUser.uid] || null;
    reactToComment(postId, commentId, comment, mine ? null : DEFAULT_REACTION, btn, countEl);
  });
  picker.querySelectorAll(".reaction-option").forEach((opt) => {
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      picker.classList.add("hidden");
      reactToComment(postId, commentId, comment, opt.dataset.emoji, btn, countEl);
    });
  });
  paintCommentReactionButton(btn, countEl, comment);
}

export async function reactToComment(postId, commentId, comment, emoji, btnEl, countEl) {
  const uid = auth.currentUser.uid;
  const current = (comment.reactions || {})[uid] || null;
  const next = (emoji && emoji !== current) ? emoji : null;
  const authorUid = comment.authorUid;
  const text = comment.text || "";

  comment.reactions = { ...(comment.reactions || {}) };
  if (next) comment.reactions[uid] = next; else delete comment.reactions[uid];
  paintCommentReactionButton(btnEl, countEl, comment);

  btnEl.disabled = true;
  btnEl.classList.add("like-pop");
  const ref = doc(db, "posts", postId, "comments", commentId);
  try {
    await updateDoc(ref, { [`reactions.${uid}`]: next ? next : deleteField() });
    if (next && !current && authorUid && authorUid !== uid) {
      logActivity({ type: "comment-like", text, targetUid: authorUid, postId });
      triggerPush({ type: "comment-like", text, actorName: currentProfile.name, targetUid: authorUid, postId, commentId });
    }
  } catch (err) {
    comment.reactions = { ...(comment.reactions || {}) };
    if (current) comment.reactions[uid] = current; else delete comment.reactions[uid];
    paintCommentReactionButton(btnEl, countEl, comment);
    const { message, technical } = friendlyError(err, "Couldn't update your reaction.");
    showToast(message, { details: technical });
  } finally {
    btnEl.disabled = false;
    setTimeout(() => btnEl.classList.remove("like-pop"), 260);
  }
}

export async function togglePinPost(postId, wasPinned) {
  try {
    await updateDoc(doc(db, "posts", postId), {
      pinned: !wasPinned,
      pinnedAt: wasPinned ? deleteField() : serverTimestamp()
    });
    showToast(wasPinned ? "Post unpinned." : "Post pinned to the top of the Wall.");
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't update pin.");
    showToast(message, { details: technical });
  }
}

export function pollHtml(post) {
  const poll = post.poll;
  if (!poll || !poll.options) return "";
  const uid = auth.currentUser.uid;
  const votes = poll.votes || {};
  const myVote = votes[uid] || null;
  const total = Object.keys(votes).length;
  const counts = {};
  Object.values(votes).forEach((optId) => { counts[optId] = (counts[optId] || 0) + 1; });
  return `
    <div class="poll-block">
      ${poll.options.map((opt) => {
        const count = counts[opt.id] || 0;
        const pct = total ? Math.round((count / total) * 100) : 0;
        const mine = myVote === opt.id;
        return `
          <button type="button" class="poll-option ${mine ? "voted" : ""}" data-option-id="${escapeHtml(opt.id)}">
            <span class="poll-option-fill" style="width:${pct}%"></span>
            <span class="poll-option-label">${escapeHtml(opt.text)}${mine ? " ✓" : ""}</span>
            <span class="poll-option-pct">${total ? pct + "%" : ""}</span>
          </button>`;
      }).join("")}
      <small class="poll-total-votes">${total} ${total === 1 ? "vote" : "votes"}</small>
    </div>`;
}

export function wirePoll(container, postId, post) {
  const pollEl = container.querySelector(".poll-block");
  if (!pollEl) return;
  pollEl.querySelectorAll(".poll-option").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      votePoll(postId, post, btn.dataset.optionId);
    });
  });
}

export async function votePoll(postId, post, optionId) {
  const uid = auth.currentUser.uid;
  const votes = (post.poll && post.poll.votes) || {};
  const current = votes[uid] || null;
  const next = current === optionId ? null : optionId;
  try {
    await updateDoc(doc(db, "posts", postId), {
      [`poll.votes.${uid}`]: next ? next : deleteField()
    });
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't record your vote.");
    showToast(message, { details: technical });
  }
}

export async function openHashtagResults(tag) {
  openModal(`<h3>#${escapeHtml(tag)}</h3>${skeletonRowsHtml(3)}`);
  let posts;
  try {
    const snap = await getDocs(query(collection(db, "posts"), where("hashtags", "array-contains", tag)));
    posts = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  } catch (err) {
    openModal(`<h3>#${escapeHtml(tag)}</h3><p class="empty-state">Couldn't load posts: ${escapeHtml(err.message)}</p>`);
    return;
  }
  if (!posts.length) {
    openModal(`<h3>#${escapeHtml(tag)}</h3><p class="empty-state">No posts with this tag yet.</p>`);
    return;
  }
  openModal(`
    <h3>#${escapeHtml(tag)}</h3>
    <div class="flat-list hashtag-results-list">
      ${posts.map(p => `
        <button type="button" class="directory-row hashtag-result-row" data-post-id="${p.id}">
          <div class="avatar" data-author="${p.authorUid}">${avatarInner(authorProfile(p.authorUid, p.authorName))}</div>
          <div class="directory-info">
            <strong>${nameWithBadge(p.authorName, p.authorEmail)}</strong>
            <small class="hashtag-result-snippet">${escapeHtml((p.text || "").slice(0, 90))}</small>
          </div>
        </button>
      `).join("")}
    </div>
  `);
  document.querySelectorAll(".hashtag-result-row").forEach((row) => {
    row.addEventListener("click", async () => {
      closeModal({ keepHistory: true });
      const { openPostDetailPage } = await import("./post-detail.js");
      openPostDetailPage(row.dataset.postId, { replace: true });
    });
  });
}

export function teardownWall() {
  if (unsubscribePosts) unsubscribePosts();
  unsubscribePosts = null;
  if (wallScrollObserver) wallScrollObserver.disconnect();
  wallScrollObserver = null;
  liveDocs = [];
  olderDocs = [];
  hasMoreOlder = true; 
  loadingOlder = false;
}
