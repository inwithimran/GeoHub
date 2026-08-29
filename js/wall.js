// ============================================================
// WALL.JS — Student Wall / Community Feed
// Posts live in the "posts" collection. Each post has a
// "comments" subcollection. Likes are stored as an array of
// uids on the post doc so the like count is always in sync.
// ============================================================
import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot, query, orderBy,
  serverTimestamp, arrayUnion, arrayRemove, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile, fetchProfile } from "./auth.js";
import {
  showToast, escapeHtml, timeAgo, openModal, closeModal,
  setBtnLoading, cacheUserProfile, getCachedProfile, clampableHtml, attachClampToggle,
  avatarInner, nameWithBadge, kebabMenuHtml, wireKebabMenus, confirmDialog
} from "./ui-utils.js";
import { openUserProfilePage } from "./profile-view.js";
import { uploadImages } from "./cloudinary.js";
import { logActivity } from "./routine.js";
import { triggerPush } from "./push-trigger.js";
import { imagePickerHtml, wireImagePicker, postImagesHtml, wireEditImagePicker, wirePostImageViewer } from "./media-picker.js";

const wallList = document.getElementById("wall-list");
const composerTrigger = document.getElementById("composer-trigger");

let unsubscribePosts = null;
// Tracks which posts currently have their comment thread expanded
const openComments = new Set();

/** Resolve a full-enough profile object (for the avatar/badge) from the shared cache, uid, and stored name. */
function authorProfile(uid, fallbackName) {
  const cached = getCachedProfile(uid);
  return cached || { uid, name: fallbackName };
}

/** Wire up the composer + start the realtime post listener. Call once on login. */
export function initWall() {
  composerTrigger.addEventListener("click", openComposerModal);

  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"));
  unsubscribePosts = onSnapshot(q, (snap) => {
    if (snap.empty) {
      wallList.innerHTML = `<p class="empty-state">No posts yet. Be the first to write on the wall.</p>`;
      return;
    }
    wallList.innerHTML = `<div class="flat-list feed-list"></div>`;
    const listEl = wallList.querySelector(".feed-list");
    snap.forEach((docSnap) => renderPost(docSnap.id, docSnap.data(), listEl));
  }, (err) => showToast("Couldn't load the wall: " + err.message));
}

// ============================================================
// COMPOSER — clicking the trigger row opens a dedicated modal,
// like the "what's on your mind" pattern in professional apps.
// ============================================================
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
      <textarea id="post-input" class="composer-modal-textarea" placeholder="Ask a question or share something with the department…" rows="6" autofocus></textarea>
      ${imagePickerHtml("post-image-input")}
      <p id="post-error" class="form-error"></p>
      <button type="button" id="post-submit" class="btn-primary full raised composer-post-btn">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        <span>Post to Wall</span>
      </button>
    </div>
  `);
  const textarea = document.getElementById("post-input");
  textarea.focus();
  const getImageFiles = wireImagePicker(document.getElementById("modal-body"), "post-image-input");
  document.getElementById("post-submit").addEventListener("click", () => handleCreatePost(getImageFiles));
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleCreatePost(getImageFiles);
  });
}

async function handleCreatePost(getImageFiles) {
  const textarea = document.getElementById("post-input");
  const btn = document.getElementById("post-submit");
  const errorEl = document.getElementById("post-error");
  const text = textarea.value.trim();
  errorEl.textContent = "";

  if (!text) { errorEl.textContent = "Write something before posting."; return; }
  if (!currentProfile) { errorEl.textContent = "Your profile hasn't loaded yet — try again in a second."; return; }

  setBtnLoading(btn, true, "Posting…");
  try {
    const files = getImageFiles ? getImageFiles() : [];
    let images = [];
    if (files.length) {
      setBtnLoading(btn, true, "Uploading photos…");
      images = await uploadImages(files, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
      setBtnLoading(btn, true, "Posting…");
    }
    await addDoc(collection(db, "posts"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      authorEmail: auth.currentUser.email,
      text,
      images,
      likes: [],
      createdAt: serverTimestamp()
    });
    closeModal();
    showToast("Posted to the Student Wall.");
    logActivity({ type: "post", text });
    triggerPush({ type: "post", text, actorName: currentProfile.name });
  } catch (err) {
    errorEl.textContent = "Couldn't publish your post: " + err.message;
    setBtnLoading(btn, false);
  }
}

// ============================================================
// EDIT / DELETE OWN POST — reached via the post's three-dot menu
// ============================================================
export function openEditPostModal(postId, currentText, onSaved, currentImages = []) {
  openModal(`
    <h3>Edit Post</h3>
    <textarea id="post-edit-input" class="composer-modal-textarea" rows="6">${escapeHtml(currentText)}</textarea>
    <div class="media-picker-existing" data-existing-grid="post-edit-image-input"></div>
    ${imagePickerHtml("post-edit-image-input", "Add More Photos")}
    <p id="post-edit-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="post-edit-save-btn">Save Changes</button>
  `);
  const modalBody = document.getElementById("modal-body");
  const { getRemainingUrls, getNewFiles } = wireEditImagePicker(modalBody, "post-edit-image-input", currentImages);

  document.getElementById("post-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("post-edit-input").value.trim();
    const errorEl = document.getElementById("post-edit-error");
    if (!text) { errorEl.textContent = "Post can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      const newFiles = getNewFiles();
      let uploaded = [];
      if (newFiles.length) {
        setBtnLoading(e.currentTarget, true, "Uploading photos…");
        uploaded = await uploadImages(newFiles, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
      }
      const images = [...getRemainingUrls(), ...uploaded];
      await updateDoc(doc(db, "posts", postId), { text, images, editedAt: serverTimestamp() });
      closeModal();
      showToast("Post updated.");
      onSaved?.();
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}

/** Deletes every comment first (so nothing orphaned lingers server-side), then the post itself. */
export async function deletePost(postId, onDeleted) {
  const commentsSnap = await getDocs(collection(db, "posts", postId, "comments"));
  await Promise.all(commentsSnap.docs.map(c => deleteDoc(c.ref)));
  await deleteDoc(doc(db, "posts", postId));
  showToast("Post deleted.");
  onDeleted?.();
}

// ============================================================
// POST RENDERING — flat feed row, no card chrome. Shared by the
// realtime Wall feed AND a profile's "Posts" tab (own or a
// classmate's), so likes/comments/kebab all work identically
// everywhere a post can appear.
// ============================================================
export function renderPost(postId, post, listEl, { onChanged } = {}) {
  const uid = auth.currentUser.uid;
  const liked = (post.likes || []).includes(uid);
  const likeCount = (post.likes || []).length;

  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;
  const el = document.createElement("article");
  el.className = "feed-post";
  el.innerHTML = `
    <div class="post-head">
      <button type="button" class="avatar avatar-btn" data-author="${post.authorUid}">${avatarInner(author)}</button>
      <div class="post-meta">
        <button type="button" class="post-author-name" data-author="${post.authorUid}">${nameWithBadge(post.authorName, post.authorEmail)}</button>
        <small>${timeAgo(post.createdAt)}${post.editedAt ? " · edited" : ""}</small>
      </div>
      ${isOwnPost ? kebabMenuHtml(postId, [
        { action: "edit", label: "Edit Post" },
        { action: "delete", label: "Delete Post", danger: true }
      ]) : ""}
    </div>
    ${clampableHtml(post.text, "post-text")}
    ${postImagesHtml(post.images)}
    <div class="post-actions">
      <button class="post-action-btn leaf-like-btn ${liked ? "liked" : ""}" data-id="${postId}" aria-pressed="${liked}">
        <span class="leaf-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <path d="M20 4c-8 0-16 4-16 13 0 1.5.3 2.6.8 3.4C6 15 11 9 18 6c-6 4-10 10-12.4 13.7.5.2 1 .3 1.4.3C16 20 20 12 20 4z"/>
          </svg>
        </span>
        <span>${liked ? "Liked" : "Like"}</span>
      </button>
      <button class="post-action-btn comment-toggle-btn" data-id="${postId}">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
        <span>Comment</span>
      </button>
      <button type="button" class="post-like-count ${likeCount ? "" : "hidden"}" data-id="${postId}">
        <span class="leaf-mini"></span> ${likeCount} ${likeCount === 1 ? "like" : "likes"}
      </button>
    </div>
    <div class="comments-block hidden" data-comments-for="${postId}"></div>
  `;

  el.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(post.authorUid)));
  el.querySelector(".leaf-like-btn").addEventListener("click", (e) => {
    toggleLike(postId, liked, e.currentTarget);
  });
  el.querySelector(".comment-toggle-btn").addEventListener("click", () => toggleComments(postId, el, post.authorUid));
  el.querySelector(".post-like-count").addEventListener("click", () => openLikesModal(post.likes || []));
  attachClampToggle(el);
  wirePostImageViewer(el);
  wireKebabMenus(el, {
    edit: () => openEditPostModal(postId, post.text, onChanged, post.images || []),
    delete: () => confirmDialog({
      title: "Delete this post?",
      text: "This post and all of its comments will be removed from the Wall. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: () => deletePost(postId, onChanged)
    })
  });

  listEl.appendChild(el);

  // Re-open comment thread if it was open before this re-render
  if (openComments.has(postId)) {
    const block = el.querySelector(`[data-comments-for="${postId}"]`);
    block.classList.remove("hidden");
    loadComments(postId, block, post.authorUid);
  }
}

async function toggleLike(postId, currentlyLiked, btnEl) {
  btnEl.disabled = true;
  btnEl.classList.add("like-pop");
  const ref = doc(db, "posts", postId);
  try {
    await updateDoc(ref, {
      likes: currentlyLiked ? arrayRemove(auth.currentUser.uid) : arrayUnion(auth.currentUser.uid)
    });
  } catch (err) {
    showToast("Couldn't update your like: " + err.message);
  } finally {
    btnEl.disabled = false;
    setTimeout(() => btnEl.classList.remove("like-pop"), 260);
  }
}

// ============================================================
// "WHO LIKED THIS" — resolves each uid to a name via the shared
// profile cache (warmed by directory.js), fetching any it's missing.
// ============================================================
async function openLikesModal(uids) {
  if (!uids.length) return;
  openModal(`<div class="profile-modal-loading"><span class="btn-spinner dark"></span> Loading…</div>`);

  const people = await Promise.all(uids.map(async (uid) => {
    let p = getCachedProfile(uid);
    if (!p) {
      try { p = await fetchProfile(uid); if (p) cacheUserProfile(uid, p); } catch { /* ignore */ }
    }
    return p ? { ...p, uid } : { uid, name: "Classmate" };
  }));

  openModal(`
    <h3>Liked by</h3>
    <div class="flat-list likes-list">
      ${people.map(p => `
        <button type="button" class="directory-row likes-row" data-uid="${p.uid}">
          <div class="avatar">${avatarInner(p)}</div>
          <div class="directory-info"><strong>${nameWithBadge(p.name, p.email)}</strong></div>
        </button>
      `).join("")}
    </div>
  `);
  document.querySelectorAll(".likes-row").forEach(row =>
    row.addEventListener("click", () => {
      // Close the "Liked by" modal WITHOUT letting it pop its own history entry
      // (keepHistory) — otherwise that history.back() races the profile page's
      // own history.pushState and the navigation can silently fail. Instead we
      // replace the modal's entry with the profile page's ({ replace: true }).
      closeModal({ keepHistory: true });
      openUserProfilePage(row.dataset.uid, { replace: true });
    }));
}

// ============================================================
// COMMENTS — professional inline thread (avatar + name + text)
// ============================================================
function toggleComments(postId, postEl, authorUid) {
  const block = postEl.querySelector(`[data-comments-for="${postId}"]`);
  const isOpen = !block.classList.contains("hidden");
  if (isOpen) {
    block.classList.add("hidden");
    openComments.delete(postId);
  } else {
    block.classList.remove("hidden");
    openComments.add(postId);
    loadComments(postId, block, authorUid);
  }
}

async function loadComments(postId, block, authorUid) {
  block.innerHTML = `<p class="empty-state comments-loading"><span class="btn-spinner dark"></span> Loading comments…</p>`;
  const q = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);

  const uid = auth.currentUser.uid;
  let html = "";
  snap.forEach((c) => {
    const data = c.data();
    const author = authorProfile(data.authorUid, data.authorName);
    const isOwnComment = data.authorUid === uid;
    html += `
      <div class="comment-item">
        <button type="button" class="avatar avatar-sm avatar-btn" data-author="${data.authorUid}">${avatarInner(author)}</button>
        <div class="comment-body">
          <button type="button" class="comment-author" data-author="${data.authorUid}">${nameWithBadge(data.authorName, data.authorEmail)}</button>
          <p>${escapeHtml(data.text)}</p>
          <small>${timeAgo(data.createdAt)}${data.editedAt ? " · edited" : ""}</small>
        </div>
        ${isOwnComment ? kebabMenuHtml(c.id, [
          { action: "edit", label: "Edit Comment" },
          { action: "delete", label: "Delete Comment", danger: true }
        ]) : ""}
      </div>`;
  });
  if (!snap.size) html = `<p class="empty-state" style="padding:10px 0;">No comments yet — be the first to reply.</p>`;

  html += `
    <div class="comment-input-row">
      <div class="avatar avatar-sm">${avatarInner(currentProfile || {})}</div>
      <input type="text" placeholder="Write a comment…" data-comment-input="${postId}" />
      <button type="button" class="comment-send-btn" data-comment-send="${postId}">
        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;
  block.innerHTML = html;

  block.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(b.dataset.author)));

  wireKebabMenus(block, {
    edit: (commentId) => openEditCommentModal(postId, commentId, block, authorUid),
    delete: (commentId) => confirmDialog({
      title: "Delete this comment?",
      text: "This comment will be removed from the thread. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "posts", postId, "comments", commentId));
        loadComments(postId, block, authorUid);
      }
    })
  });

  const sendBtn = block.querySelector(`[data-comment-send="${postId}"]`);
  sendBtn.addEventListener("click", () => submitComment(postId, block, sendBtn, authorUid));
  block.querySelector(`[data-comment-input="${postId}"]`).addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitComment(postId, block, sendBtn, authorUid);
  });
}

async function submitComment(postId, block, sendBtn, authorUid) {
  const input = block.querySelector(`[data-comment-input="${postId}"]`);
  const text = input.value.trim();
  if (!text) return;

  input.disabled = true;
  sendBtn.classList.add("is-loading");
  sendBtn.disabled = true;
  try {
    await addDoc(collection(db, "posts", postId, "comments"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      authorEmail: auth.currentUser.email,
      text,
      createdAt: serverTimestamp()
    });
    input.value = "";
    loadComments(postId, block, authorUid); // refresh thread
    triggerPush({ type: "comment", text, actorName: currentProfile.name, targetUid: authorUid });
  } catch (err) {
    showToast("Couldn't send your comment: " + err.message);
    input.disabled = false;
    sendBtn.classList.remove("is-loading");
    sendBtn.disabled = false;
  }
}

// ============================================================
// EDIT OWN COMMENT — reached via the comment's three-dot menu
// ============================================================
function openEditCommentModal(postId, commentId, block, authorUid) {
  const inputEl = block.querySelector(`[data-kebab-id="${commentId}"]`)?.closest(".comment-item")?.querySelector(".comment-body p");
  const currentText = inputEl ? inputEl.textContent : "";
  openModal(`
    <h3>Edit Comment</h3>
    <textarea id="comment-edit-input" class="composer-modal-textarea" rows="3">${escapeHtml(currentText)}</textarea>
    <p id="comment-edit-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="comment-edit-save-btn">Save Changes</button>
  `);
  document.getElementById("comment-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("comment-edit-input").value.trim();
    const errorEl = document.getElementById("comment-edit-error");
    if (!text) { errorEl.textContent = "Comment can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "posts", postId, "comments", commentId), { text, editedAt: serverTimestamp() });
      closeModal();
      loadComments(postId, block, authorUid);
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}

/** Detach the realtime listener (call on logout to avoid leaks). */
export function teardownWall() {
  if (unsubscribePosts) unsubscribePosts();
}
