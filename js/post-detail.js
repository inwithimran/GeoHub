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
import { onSnapshotWithRetry } from "./realtime-retry.js";
import {
  doc, collection, query, orderBy, updateDoc, deleteDoc, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import { callApi } from "./api-client.js";
import {
  showToast, escapeHtml, timeAgo, openModal, closeModal, setBtnLoading,
  clampableRichHtml, richTextHtml, wireRichTextClicks, attachClampToggle, avatarInner, nameWithBadge,
  kebabMenuHtml, wireKebabMenus, confirmDialog, isAdminEmail, wireCharCounter,
  getCachedProfile, subscribeToProfileUpdates, friendlyError
} from "./ui-utils.js";
import {
  authorProfile, openEditPostModal, deletePost, wireMentions,
  openReactionsModal, wireReactionControl, paintReactionButton, REACTION_EMOJIS,
  pollHtml, wirePoll, togglePinPost
} from "./wall.js";
import { openUserProfilePage } from "./profile-view.js";
import { avatarPresenceDotHtml } from "./presence.js";
import { postImagesHtml, wirePostImageViewer, applyPostImageRatios } from "./media-picker.js";
import { triggerPush } from "./push-trigger.js";
import { logActivity } from "./routine.js";

const bodyEl = document.getElementById("post-detail-body");

let goToRouteRef = null;
export function registerPostDetailRouter(goToRoute) { goToRouteRef = goToRoute; }

let unsubscribePost = null;
let unsubscribeComments = null;
let currentPostId = null;

const unsubscribeProfileUpdates = subscribeToProfileUpdates((uid) => {
  const profile = getCachedProfile(uid);
  if (!profile || !bodyEl) return;
  bodyEl.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
});

const COMMENT_TEXT_LIMIT = 500;

export function openPostDetailPage(postId, { fromPopstate = false, replace = false, focusComment = false } = {}) {
  if (!postId || !bodyEl) return;
  teardownPostDetail();
  currentPostId = postId;

  if (goToRouteRef) goToRouteRef("post-detail", { fromPopstate, replace, state: { postId } });
  bodyEl.innerHTML = postDetailSkeletonHtml();

  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = "Post";

  let post = null;
  let comments = [];
  let postLoaded = false;
  let commentsLoaded = false;
  let titleSet = false;
  let shouldFocusComment = focusComment;
  pendingComments = [];

  const render = () => {
    if (postId !== currentPostId) return;
    if (!postLoaded) return;
    if (!post) {
      bodyEl.innerHTML = `<p class="empty-state">This post is no longer available — it may have been deleted.</p>`;
      return;
    }
    renderPostDetail(postId, post, comments, bodyEl, {
      focusComment: shouldFocusComment,
      commentsLoaded,
      onDeleted: () => history.back()
    });
    shouldFocusComment = false;
  };
  triggerRender = render;

  unsubscribePost = onSnapshotWithRetry(doc(db, "posts", postId), (snap) => {
    if (postId !== currentPostId) return;
    postLoaded = true;
    if (!snap.exists()) { post = null; render(); return; }
    post = { id: snap.id, ...snap.data() };
    if (!titleSet && topbarTitle) {
      titleSet = true;
      topbarTitle.textContent = `${post.authorName || "Classmate"}’s Post`;
    }
    render();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load this post.");
    showToast(message, { details: technical });
  });

  const commentsQuery = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
  unsubscribeComments = onSnapshotWithRetry(commentsQuery, (snap) => {
    if (postId !== currentPostId) return;
    comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    commentsLoaded = true;
    const stillPending = [...pendingComments];
    comments.forEach((c) => {
      const i = stillPending.findIndex(p => p.authorUid === c.authorUid && p.text === c.text);
      if (i !== -1) stillPending.splice(i, 1);
    });
    pendingComments = stillPending;
    render();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load comments.");
    showToast(message, { details: technical });
  });
}

let pendingComments = [];
let triggerRender = null;

function postDetailSkeletonHtml() {
  return `
    <div aria-hidden="true">
      <div class="skeleton-post">
        <div class="skeleton-post-head">
          <div class="skeleton-avatar"></div>
          <div class="skeleton-head-lines"><div class="skeleton-line sk-40"></div><div class="skeleton-line sk-25"></div></div>
        </div>
        <div class="skeleton-post-text"><div class="skeleton-line sk-90"></div><div class="skeleton-line sk-70"></div></div>
        <div class="skeleton-block"></div>
      </div>
      ${commentSkeletonHtml()}
    </div>`;
}

function commentSkeletonHtml() {
  const row = () => `
    <div class="skeleton-post-head" style="margin:14px 0 0">
      <div class="skeleton-avatar" style="width:30px;height:30px"></div>
      <div class="skeleton-head-lines"><div class="skeleton-line sk-50"></div><div class="skeleton-line sk-90" style="height:8px"></div></div>
    </div>`;
  return `<div class="skeleton-post" style="margin-top:14px">${row()}${row()}</div>`;
}

export function getOpenPostId() {
  return currentPostId;
}

export function teardownPostDetail() {
  if (unsubscribePost) { unsubscribePost(); unsubscribePost = null; }
  if (unsubscribeComments) { unsubscribeComments(); unsubscribeComments = null; }
  currentPostId = null;
  pendingComments = [];
  triggerRender = null;
}

// ============================================================
// RENDERING — the post card (reusing the same look as a Wall row)
// followed by the full, always-expanded comment thread, with the
// "write a comment" box as the very last element on the page.
// ============================================================
function renderPostDetail(postId, post, comments, container, { focusComment, commentsLoaded, onDeleted }) {
  const uid = auth.currentUser.uid;
  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;
  const isAdmin = isAdminEmail(auth.currentUser.email);

  const prevInput = container.querySelector(".comment-input-row input");
  const draftText = prevInput ? prevInput.value : "";
  const hadFocus = !!prevInput && document.activeElement === prevInput;
  const selStart = prevInput ? prevInput.selectionStart : null;
  const selEnd = prevInput ? prevInput.selectionEnd : null;
  const prevScrollY = window.scrollY;

  const pendingHtml = pendingComments.map(p => pendingCommentItemHtml(p)).join("");
  const commentsHtml = !commentsLoaded
    ? commentSkeletonHtml()
    : (comments.length || pendingComments.length)
      ? comments.map(c => commentItemHtml(c, uid, isOwnPost)).join("") + pendingHtml
      : `<p class="empty-state" style="padding:10px 0;">No comments yet — be the first to reply.</p>`;

  let kebabActions = [];
  if (isOwnPost) kebabActions.push({ action: "edit", label: "Edit Post" });
  if (isAdmin) kebabActions.push({ action: "pin", label: post.pinned ? "Unpin Post" : "Pin Post" });
  if (isOwnPost) kebabActions.push({ action: "delete", label: "Delete Post", danger: true });
  else if (isAdmin) kebabActions.push({ action: "delete", label: "Remove Post (Admin)", danger: true });

  container.innerHTML = `
    <article class="feed-post">
      <div class="post-head">
        <span class="avatar-presence-wrap">
          <button type="button" class="avatar avatar-btn" data-author="${post.authorUid}" aria-label="View ${escapeHtml(author.name || post.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
          ${avatarPresenceDotHtml(post.authorUid)}
        </span>
        <div class="post-meta">
          <button type="button" class="post-author-name" data-author="${post.authorUid}">${nameWithBadge(post.authorName, post.authorEmail)}</button>
          <small>${post.pinned ? "📌 Pinned · " : ""}${timeAgo(post.createdAt)}${post.editedAt ? " · edited" : ""}</small>
        </div>
        ${kebabActions.length ? kebabMenuHtml(postId, kebabActions) : ""}
      </div>
      ${clampableRichHtml(post.text, post.mentions, "post-text")}
      ${postImagesHtml(post.images)}
      ${pollHtml(post)}
      <div class="post-actions">
        <div class="reaction-control">
          <button type="button" class="post-action-btn reaction-btn" data-id="${postId}">
            <span class="reaction-icon" aria-hidden="true"></span>
            <span>Like</span>
          </button>
          <div class="reaction-picker hidden">
            ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-option" data-emoji="${e}">${e}</button>`).join("")}
          </div>
        </div>
        <button type="button" class="post-action-btn comment-jump-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          <span>Comment</span>
          ${post.commentCount ? `<span class="action-count-badge">${post.commentCount}</span>` : ""}
        </button>
        <button type="button" class="post-like-count hidden"></button>
      </div>
    </article>
    <div class="comments-block">
      ${commentsHtml}
      <div class="comment-input-row">
        <div class="avatar avatar-sm">${avatarInner(currentProfile || {})}</div>
        <input type="text" placeholder="Write a comment… (@mention a classmate)" maxlength="${COMMENT_TEXT_LIMIT}" />
        <button type="button" class="comment-send-btn" aria-label="Send comment">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="char-counter comment-char-counter"></div>
    </div>
  `;

  const input = container.querySelector(".comment-input-row input");
  if (input && draftText) input.value = draftText;
  if (input && hadFocus) {
    input.focus();
    if (selStart != null) input.setSelectionRange(selStart, selEnd);
  }
  wireCommentCounter(container, input);
  window.scrollTo(0, prevScrollY);

  const postEl = container.querySelector(".feed-post");
  const reactionBtn = postEl.querySelector(".reaction-btn");
  const likeCountBtn = postEl.querySelector(".post-like-count");

  postEl.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(post.authorUid)));
  wireReactionControl(postEl, postId, post);
  paintReactionButton(reactionBtn, likeCountBtn, post);
  likeCountBtn.addEventListener("click", () => openReactionsModal(reactionsOfPost(post)));
  postEl.querySelector(".comment-jump-btn").addEventListener("click", () => focusCommentInput(container));
  attachClampToggle(postEl);
  wireRichTextClicks(postEl);
  applyPostImageRatios(postEl);
  wirePostImageViewer(postEl);
  wirePoll(postEl, postId, post);
  if (kebabActions.length) {
    wireKebabMenus(postEl, {
      edit: () => openEditPostModal(postId, post.text, () => {}, post.images || [], post.mentions || []),
      pin: () => togglePinPost(postId, !!post.pinned),
      delete: () => confirmDialog({
        title: isOwnPost ? "Delete this post?" : "Remove this post?",
        text: isOwnPost
          ? "This post and all of its comments will be removed from the Wall. This can't be undone."
          : "This will remove the post and its comments from the Wall for everyone. This can't be undone.",
        confirmLabel: isOwnPost ? "Delete" : "Remove",
        onConfirm: () => deletePost(postId, onDeleted)
      })
    });
  }

  const commentsEl = container.querySelector(".comments-block");
  commentsEl.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(b.dataset.author)));
  wireRichTextClicks(commentsEl);
  wireKebabMenus(commentsEl, {
    edit: (commentId) => {
      const c = comments.find(x => x.id === commentId);
      openEditCommentModal(postId, commentId, c ? c.text : "", c ? c.mentions || [] : []);
    },
    delete: (commentId) => confirmDialog({
      title: "Delete this comment?",
      text: "This comment will be removed from the thread. This can't be undone.",
      confirmLabel: "Delete",
      onConfirm: async () => {
        await deleteDoc(doc(db, "posts", postId, "comments", commentId));
        updateDoc(doc(db, "posts", postId), { commentCount: increment(-1) }).catch(() => {});
      }
    })
  });

  const { getMentions } = wireMentions(input);
  const sendBtn = commentsEl.querySelector(".comment-send-btn");
  sendBtn.addEventListener("click", () => submitComment(postId, commentsEl, sendBtn, post.authorUid, getMentions));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitComment(postId, commentsEl, sendBtn, post.authorUid, getMentions);
  });

  if (focusComment) focusCommentInput(container);
}

function reactionsOfPost(post) {
  return post.reactions || Object.fromEntries((post.likes || []).map((u) => [u, "👍"]));
}

function commentItemHtml(c, uid, isPostOwner) {
  const author = authorProfile(c.authorUid, c.authorName);
  const isOwnComment = c.authorUid === uid;
  const canDelete = isOwnComment || isPostOwner;
  const kebabActions = [];
  if (isOwnComment) kebabActions.push({ action: "edit", label: "Edit Comment" });
  if (canDelete) kebabActions.push({ action: "delete", label: isOwnComment ? "Delete Comment" : "Remove Comment", danger: true });
  return `
    <div class="comment-item">
      <span class="avatar-presence-wrap">
        <button type="button" class="avatar avatar-sm avatar-btn" data-author="${c.authorUid}" aria-label="View ${escapeHtml(author.name || c.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
        ${avatarPresenceDotHtml(c.authorUid)}
      </span>
      <div class="comment-body">
        <button type="button" class="comment-author" data-author="${c.authorUid}">${nameWithBadge(c.authorName, c.authorEmail)}</button>
        <p>${richTextHtml(c.text, c.mentions)}</p>
        <small>${timeAgo(c.createdAt)}${c.editedAt ? " · edited" : ""}</small>
      </div>
      ${kebabActions.length ? kebabMenuHtml(c.id, kebabActions) : ""}
    </div>`;
}

function pendingCommentItemHtml(p) {
  return `
    <div class="comment-item comment-item-pending">
      <div class="avatar avatar-sm">${avatarInner(currentProfile || {})}</div>
      <div class="comment-body">
        <span class="comment-author">${nameWithBadge(currentProfile ? currentProfile.name : "You", currentProfile ? currentProfile.email : "")}</span>
        <p>${richTextHtml(p.text, p.mentions)}</p>
        <small class="comment-pending-status"><span class="comment-pending-spinner"></span>Sending…</small>
      </div>
    </div>`;
}

function wireCommentCounter(container, input) {
  const counter = container.querySelector(".comment-char-counter");
  if (!input || !counter) return;
  const update = () => {
    const len = input.value.length;
    counter.textContent = `${len}/${COMMENT_TEXT_LIMIT}`;
    counter.classList.toggle("char-counter-warn", len >= COMMENT_TEXT_LIMIT * 0.9);
  };
  input.addEventListener("input", update);
  update();
}

function focusCommentInput(container) {
  const input = container.querySelector(".comment-input-row input");
  if (!input) return;
  input.scrollIntoView({ behavior: "smooth", block: "center" });
  input.focus();
}

async function submitComment(postId, commentsEl, sendBtn, postAuthorUid, getMentions) {
  if (sendBtn.disabled) return;
  const input = commentsEl.querySelector(".comment-input-row input");
  const text = input.value.trim();
  if (!text) return;
  const mentions = getMentions ? getMentions() : [];

  input.value = "";
  input.dispatchEvent(new Event("input"));
  sendBtn.disabled = true;
  sendBtn.classList.add("is-loading");

  const pendingEntry = { authorUid: auth.currentUser.uid, text, mentions };
  pendingComments.push(pendingEntry);
  if (triggerRender) triggerRender();

  try {
    await callApi("create-comment", { postId, text, mentions });
    if (postAuthorUid && postAuthorUid !== auth.currentUser.uid) {
      logActivity({ type: "comment", text, targetUid: postAuthorUid, postId });
      triggerPush({ type: "comment", text, actorName: currentProfile.name, targetUid: postAuthorUid, postId });
    }
    mentions.forEach((m) => {
      if (!m.uid || m.uid === auth.currentUser.uid) return;
      logActivity({ type: "mention", text, targetUid: m.uid, postId });
      triggerPush({ type: "mention", text, actorName: currentProfile.name, targetUid: m.uid, postId });
    });
  } catch (err) {
    pendingComments = pendingComments.filter(p => p !== pendingEntry);
    if (triggerRender) triggerRender();
    const liveInput = commentsEl.querySelector(".comment-input-row input");
    if (liveInput) { liveInput.value = text; liveInput.dispatchEvent(new Event("input")); }
    const { message, technical } = friendlyError(err, "Couldn't send your comment.");
    showToast(message, { details: technical });
  } finally {
    sendBtn.disabled = false;
    sendBtn.classList.remove("is-loading");
  }
}

// ============================================================
// EDIT OWN COMMENT — reached via the comment's three-dot menu
// ============================================================
function openEditCommentModal(postId, commentId, currentText, currentMentions = []) {
  openModal(`
    <div class="composer-modal">
      <div class="composer-modal-head">
        <div class="avatar">${avatarInner(currentProfile || {})}</div>
        <div>
          <strong>${nameWithBadge(currentProfile ? currentProfile.name : "You", currentProfile ? currentProfile.email : "")}</strong>
          <small>Editing your comment</small>
        </div>
      </div>
      <textarea id="comment-edit-input" class="composer-modal-textarea" rows="3" maxlength="${COMMENT_TEXT_LIMIT}">${escapeHtml(currentText)}</textarea>
      <p id="comment-edit-error" class="form-error"></p>
      <button type="button" class="btn-primary full raised composer-post-btn" id="comment-edit-save-btn">Save Changes</button>
    </div>
  `);
  const { getMentions } = wireMentions(document.getElementById("comment-edit-input"), currentMentions);
  wireCharCounter(document.getElementById("comment-edit-input"), COMMENT_TEXT_LIMIT);
  document.getElementById("comment-edit-save-btn").addEventListener("click", async (e) => {
    const text = document.getElementById("comment-edit-input").value.trim();
    const errorEl = document.getElementById("comment-edit-error");
    if (!text) { errorEl.textContent = "Comment can't be empty."; return; }
    setBtnLoading(e.currentTarget, true, "Saving…");
    try {
      await updateDoc(doc(db, "posts", postId, "comments", commentId), { text, mentions: getMentions(), editedAt: serverTimestamp() });
      closeModal();
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}
