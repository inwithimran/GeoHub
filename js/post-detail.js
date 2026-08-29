// ============================================================
// POST-DETAIL.JS — a single post's own full-page view ("Post
// Detail"), pushed to browser history like profile-view.js's
// classmate profile page — never a modal. Reached by tapping a
// post's text/photo/empty space/Comment pill on the Wall or on a
// profile's Posts tab (see wall.js's renderPost), or from a
// post-related row in the Notification tab (see routine.js).
//
// The post itself and its comment thread are both realtime
// (onSnapshot), so likes/edits/new comments made by classmates
// while this page is open show up live — same spirit as the Wall,
// just for one post. The comment box lives at the very bottom of
// the thread, below every comment, same as the rest of the app's
// comment UI.
// ============================================================
import { db, auth } from "./firebase-config.js";
import {
  doc, collection, query, orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import {
  showToast, escapeHtml, timeAgo, openModal, closeModal, setBtnLoading,
  clampableHtml, attachClampToggle, avatarInner, nameWithBadge,
  kebabMenuHtml, wireKebabMenus, confirmDialog
} from "./ui-utils.js";
import { authorProfile, openEditPostModal, deletePost, toggleLike, openLikesModal } from "./wall.js";
import { openUserProfilePage } from "./profile-view.js";
import { postImagesHtml, wirePostImageViewer } from "./media-picker.js";
import { triggerPush } from "./push-trigger.js";
import { logActivity } from "./routine.js";

const bodyEl = document.getElementById("post-detail-body");
const backBtn = document.getElementById("post-detail-back-btn");
backBtn?.addEventListener("click", () => history.back());

// app.js hands us its router (goToRoute) so this page participates in the
// normal section/back-button history, same pattern as profile-view.js.
let goToRouteRef = null;
export function registerPostDetailRouter(goToRoute) { goToRouteRef = goToRoute; }

let unsubscribePost = null;
let unsubscribeComments = null;
let currentPostId = null;

/**
 * Open the Post Detail page for `postId`. Pass { focusComment: true } when
 * arriving specifically to reply (tapping "Comment", or a "commented on
 * your post" notification) so the comment box is scrolled to and focused
 * as soon as the post loads.
 */
export function openPostDetailPage(postId, { fromPopstate = false, replace = false, focusComment = false } = {}) {
  if (!postId || !bodyEl) return;
  teardownPostDetail(); // drop any previously-open post's listeners first
  currentPostId = postId;

  if (goToRouteRef) goToRouteRef("post-detail", { fromPopstate, replace, state: { postId } });
  bodyEl.innerHTML = `<div class="profile-modal-loading"><span class="btn-spinner dark"></span> Loading post…</div>`;

  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = "Post";

  let post = null;
  let comments = [];
  let titleSet = false;
  let shouldFocusComment = focusComment;

  const render = () => {
    if (postId !== currentPostId) return; // superseded by a newer navigation
    if (!post) {
      bodyEl.innerHTML = `<p class="empty-state">This post is no longer available — it may have been deleted.</p>`;
      return;
    }
    renderPostDetail(postId, post, comments, bodyEl, {
      focusComment: shouldFocusComment,
      onDeleted: () => history.back()
    });
    shouldFocusComment = false; // only auto-focus right after opening, not on every live update
  };

  unsubscribePost = onSnapshot(doc(db, "posts", postId), (snap) => {
    if (postId !== currentPostId) return;
    if (!snap.exists()) { post = null; render(); return; }
    post = { id: snap.id, ...snap.data() };
    if (!titleSet && topbarTitle) {
      titleSet = true;
      topbarTitle.textContent = `${post.authorName || "Classmate"}’s Post`;
    }
    render();
  }, (err) => showToast("Couldn't load this post: " + err.message));

  const commentsQuery = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
  unsubscribeComments = onSnapshot(commentsQuery, (snap) => {
    if (postId !== currentPostId) return;
    comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }, (err) => showToast("Couldn't load comments: " + err.message));
}

/** Detach the post + comments listeners (call whenever navigating away from this page). */
export function teardownPostDetail() {
  if (unsubscribePost) { unsubscribePost(); unsubscribePost = null; }
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
  currentPostId = null;
}

// ============================================================
// RENDERING — the post card (reusing the same look as a Wall row)
// followed by the full, always-expanded comment thread, with the
// "write a comment" box as the very last element on the page.
// ============================================================
function renderPostDetail(postId, post, comments, container, { focusComment, onDeleted }) {
  const uid = auth.currentUser.uid;
  const liked = (post.likes || []).includes(uid);
  const likeCount = (post.likes || []).length;
  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;

  // A live update (someone else liking/commenting) re-renders this whole
  // container — preserve whatever the person was mid-typing (and focus/
  // cursor position) so it isn't wiped out from under them.
  const prevInput = container.querySelector(".comment-input-row input");
  const draftText = prevInput ? prevInput.value : "";
  const hadFocus = !!prevInput && document.activeElement === prevInput;
  const selStart = prevInput ? prevInput.selectionStart : null;
  const selEnd = prevInput ? prevInput.selectionEnd : null;
  const prevScrollY = window.scrollY;

  const commentsHtml = comments.length
    ? comments.map(c => commentItemHtml(c, uid)).join("")
    : `<p class="empty-state" style="padding:10px 0;">No comments yet — be the first to reply.</p>`;

  container.innerHTML = `
    <article class="feed-post">
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
        <button type="button" class="post-action-btn leaf-like-btn ${liked ? "liked" : ""}" aria-pressed="${liked}">
          <span class="leaf-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="${liked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
              <path d="M20 4c-8 0-16 4-16 13 0 1.5.3 2.6.8 3.4C6 15 11 9 18 6c-6 4-10 10-12.4 13.7.5.2 1 .3 1.4.3C16 20 20 12 20 4z"/>
            </svg>
          </span>
          <span>${liked ? "Liked" : "Like"}</span>
        </button>
        <button type="button" class="post-action-btn comment-jump-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          <span>Comment</span>
        </button>
        <button type="button" class="post-like-count ${likeCount ? "" : "hidden"}">
          <span class="leaf-mini"></span> ${likeCount} ${likeCount === 1 ? "like" : "likes"}
        </button>
      </div>
    </article>
    <div class="comments-block">
      ${commentsHtml}
      <div class="comment-input-row">
        <div class="avatar avatar-sm">${avatarInner(currentProfile || {})}</div>
        <input type="text" placeholder="Write a comment…" />
        <button type="button" class="comment-send-btn">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  `;

  // ---------- restore the in-flight comment draft across the re-render ----------
  const input = container.querySelector(".comment-input-row input");
  if (input && draftText) input.value = draftText;
  if (input && hadFocus) {
    input.focus();
    if (selStart != null) input.setSelectionRange(selStart, selEnd);
  }
  window.scrollTo(0, prevScrollY); // rebuilding the DOM can otherwise snap the page back to the top

  // ---------- post-level wiring ----------
  const postEl = container.querySelector(".feed-post");
  const likeBtn = postEl.querySelector(".leaf-like-btn");
  const likeCountBtn = postEl.querySelector(".post-like-count");

  postEl.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(post.authorUid)));
  likeBtn.addEventListener("click", () => toggleLike(postId, post, likeBtn, likeCountBtn));
  likeCountBtn.addEventListener("click", () => openLikesModal(post.likes || []));
  postEl.querySelector(".comment-jump-btn").addEventListener("click", () => focusCommentInput(container));
  attachClampToggle(postEl);
  wirePostImageViewer(postEl);
  wireKebabMenus(postEl, {
    edit: () => openEditPostModal(postId, post.text, () => {}, post.images || []),
    delete: () => confirmDialog({
      title: "Delete this post?",
      text: "This post and all of its comments will be removed from the Wall. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: () => deletePost(postId, onDeleted)
    })
  });

  // ---------- comment thread wiring ----------
  const commentsEl = container.querySelector(".comments-block");
  commentsEl.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(b.dataset.author)));
  wireKebabMenus(commentsEl, {
    edit: (commentId) => {
      const c = comments.find(x => x.id === commentId);
      openEditCommentModal(postId, commentId, c ? c.text : "");
    },
    delete: (commentId) => confirmDialog({
      title: "Delete this comment?",
      text: "This comment will be removed from the thread. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: () => deleteDoc(doc(db, "posts", postId, "comments", commentId))
    })
  });

  const sendBtn = commentsEl.querySelector(".comment-send-btn");
  sendBtn.addEventListener("click", () => submitComment(postId, commentsEl, sendBtn, post.authorUid));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitComment(postId, commentsEl, sendBtn, post.authorUid);
  });

  if (focusComment) focusCommentInput(container);
}

function commentItemHtml(c, uid) {
  const author = authorProfile(c.authorUid, c.authorName);
  const isOwnComment = c.authorUid === uid;
  return `
    <div class="comment-item">
      <button type="button" class="avatar avatar-sm avatar-btn" data-author="${c.authorUid}">${avatarInner(author)}</button>
      <div class="comment-body">
        <button type="button" class="comment-author" data-author="${c.authorUid}">${nameWithBadge(c.authorName, c.authorEmail)}</button>
        <p>${escapeHtml(c.text)}</p>
        <small>${timeAgo(c.createdAt)}${c.editedAt ? " · edited" : ""}</small>
      </div>
      ${isOwnComment ? kebabMenuHtml(c.id, [
        { action: "edit", label: "Edit Comment" },
        { action: "delete", label: "Delete Comment", danger: true }
      ]) : ""}
    </div>`;
}

function focusCommentInput(container) {
  const input = container.querySelector(".comment-input-row input");
  if (!input) return;
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();
}

async function submitComment(postId, commentsEl, sendBtn, postAuthorUid) {
  if (sendBtn.disabled) return; // guards against a double-send race (Enter + tap)
  const input = commentsEl.querySelector(".comment-input-row input");
  const text = input.value.trim();
  if (!text) return;

  sendBtn.disabled = true;
  sendBtn.classList.add("is-loading");
  try {
    await addDoc(collection(db, "posts", postId, "comments"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      authorEmail: auth.currentUser.email,
      text,
      createdAt: serverTimestamp()
    });
    input.value = ""; // the live listener redraws the thread with the new comment
    // Only notify the post's author, and never notify someone that they
    // commented on their own post — that's not a meaningful notification.
    if (postAuthorUid && postAuthorUid !== auth.currentUser.uid) {
      logActivity({ type: "comment", text, targetUid: postAuthorUid, postId });
      triggerPush({ type: "comment", text, actorName: currentProfile.name, targetUid: postAuthorUid, postId });
    }
  } catch (err) {
    showToast("Couldn't send your comment: " + err.message);
  } finally {
    sendBtn.disabled = false;
    sendBtn.classList.remove("is-loading");
  }
}

// ============================================================
// EDIT OWN COMMENT — reached via the comment's three-dot menu
// ============================================================
function openEditCommentModal(postId, commentId, currentText) {
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
      closeModal(); // the live comments listener redraws the thread with the edit
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}
