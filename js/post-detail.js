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
  clampableRichHtml, richTextHtml, wireRichTextClicks, attachClampToggle, avatarInner, nameWithBadge,
  kebabMenuHtml, wireKebabMenus, confirmDialog, isAdminEmail, wireCharCounter,
  getCachedProfile, subscribeToProfileUpdates
} from "./ui-utils.js";
import {
  authorProfile, openEditPostModal, deletePost, wireMentions,
  openReactionsModal, wireReactionControl, paintReactionButton, REACTION_EMOJIS,
  pollHtml, wirePoll, togglePinPost
} from "./wall.js";
import { openUserProfilePage } from "./profile-view.js";
import { postImagesHtml, wirePostImageViewer, applyPostImageRatios } from "./media-picker.js";
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

// Same fix as the Wall (see wall.js's refreshAuthorAvatars): the post's own
// author and every commenter's avatar are rendered from whatever's in the
// shared profile cache at the moment; this re-draws them in place as their
// profiles land (Directory listener warming up, or a fetched-on-demand miss)
// instead of leaving a blank/default avatar until the page is reopened.
const unsubscribeProfileUpdates = subscribeToProfileUpdates((uid) => {
  const profile = getCachedProfile(uid);
  if (!profile || !bodyEl) return;
  bodyEl.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
});

// A comment is meant to be a quick reply, not a second post — capped
// well below POST_TEXT_LIMIT in wall.js.
const COMMENT_TEXT_LIMIT = 500;

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
  bodyEl.innerHTML = postDetailSkeletonHtml();

  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = "Post";

  let post = null;
  let comments = [];
  let postLoaded = false;
  let commentsLoaded = false; // stays false until the comments listener's first snapshot, so a skeleton (not "no comments yet") shows while they're in flight
  let titleSet = false;
  let shouldFocusComment = focusComment;

  const render = () => {
    if (postId !== currentPostId) return; // superseded by a newer navigation
    if (!postLoaded) return; // still on the initial skeleton
    if (!post) {
      bodyEl.innerHTML = `<p class="empty-state">This post is no longer available — it may have been deleted.</p>`;
      return;
    }
    renderPostDetail(postId, post, comments, bodyEl, {
      focusComment: shouldFocusComment,
      commentsLoaded,
      onDeleted: () => history.back()
    });
    shouldFocusComment = false; // only auto-focus right after opening, not on every live update
  };

  unsubscribePost = onSnapshot(doc(db, "posts", postId), (snap) => {
    if (postId !== currentPostId) return;
    postLoaded = true;
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
    commentsLoaded = true;
    render();
  }, (err) => showToast("Couldn't load comments: " + err.message));
}

/** Skeleton placeholder for the whole page on first open — a post card
 *  shape followed by a couple of comment-row shapes — swapped for the
 *  real content (see render() above) as soon as the post itself arrives. */
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

/** Skeleton for just the comment thread — reused for the initial page load
 *  and for the "post arrived, comments still loading" gap. */
function commentSkeletonHtml() {
  const row = () => `
    <div class="skeleton-post-head" style="margin:14px 0 0">
      <div class="skeleton-avatar" style="width:30px;height:30px"></div>
      <div class="skeleton-head-lines"><div class="skeleton-line sk-50"></div><div class="skeleton-line sk-90" style="height:8px"></div></div>
    </div>`;
  return `<div class="skeleton-post" style="margin-top:14px">${row()}${row()}</div>`;
}

/** The postId currently open on this page (null if the page isn't open). Lets app.js's
 *  popstate handler tell "closing a modal that was sitting on top of this page" apart
 *  from "actually navigating to a different post", so it only reloads for the latter. */
export function getOpenPostId() {
  return currentPostId;
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
function renderPostDetail(postId, post, comments, container, { focusComment, commentsLoaded, onDeleted }) {
  const uid = auth.currentUser.uid;
  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;
  const isAdmin = isAdminEmail(auth.currentUser.email);

  // A live update (someone else liking/commenting) re-renders this whole
  // container — preserve whatever the person was mid-typing (and focus/
  // cursor position) so it isn't wiped out from under them.
  const prevInput = container.querySelector(".comment-input-row input");
  const draftText = prevInput ? prevInput.value : "";
  const hadFocus = !!prevInput && document.activeElement === prevInput;
  const selStart = prevInput ? prevInput.selectionStart : null;
  const selEnd = prevInput ? prevInput.selectionEnd : null;
  const prevScrollY = window.scrollY;

  const commentsHtml = !commentsLoaded
    ? commentSkeletonHtml()
    : comments.length
      ? comments.map(c => commentItemHtml(c, uid, isOwnPost)).join("")
      : `<p class="empty-state" style="padding:10px 0;">No comments yet — be the first to reply.</p>`;

  let kebabActions = [];
  if (isOwnPost) kebabActions.push({ action: "edit", label: "Edit Post" });
  if (isAdmin) kebabActions.push({ action: "pin", label: post.pinned ? "Unpin Post" : "Pin Post" });
  if (isOwnPost) kebabActions.push({ action: "delete", label: "Delete Post", danger: true });
  else if (isAdmin) kebabActions.push({ action: "delete", label: "Remove Post (Admin)", danger: true });

  container.innerHTML = `
    <article class="feed-post">
      <div class="post-head">
        <button type="button" class="avatar avatar-btn" data-author="${post.authorUid}">${avatarInner(author)}</button>
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
        </button>
        <button type="button" class="post-like-count hidden"></button>
      </div>
    </article>
    <div class="comments-block">
      ${commentsHtml}
      <div class="comment-input-row">
        <div class="avatar avatar-sm">${avatarInner(currentProfile || {})}</div>
        <input type="text" placeholder="Write a comment… (@mention a classmate)" maxlength="${COMMENT_TEXT_LIMIT}" />
        <button type="button" class="comment-send-btn">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
      <div class="char-counter comment-char-counter"></div>
    </div>
  `;

  // ---------- restore the in-flight comment draft across the re-render ----------
  const input = container.querySelector(".comment-input-row input");
  if (input && draftText) input.value = draftText;
  if (input && hadFocus) {
    input.focus();
    if (selStart != null) input.setSelectionRange(selStart, selEnd);
  }
  wireCommentCounter(container, input);
  window.scrollTo(0, prevScrollY); // rebuilding the DOM can otherwise snap the page back to the top

  // ---------- post-level wiring ----------
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

  // ---------- comment thread wiring ----------
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
      onConfirm: () => deleteDoc(doc(db, "posts", postId, "comments", commentId))
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

/** Same legacy-likes fallback as wall.js's internal reactionsOf() — kept local since it's not exported. */
function reactionsOfPost(post) {
  return post.reactions || Object.fromEntries((post.likes || []).map((u) => [u, "👍"]));
}

/**
 * `isPostOwner` — true when the person viewing the thread authored the
 * POST itself (not necessarily this comment). They can only ever EDIT
 * their own comments, same as anyone, but may DELETE any comment on their
 * own post — moderating their own thread, same spirit as being able to
 * delete the post itself. See firestore.rules' comments match for the
 * server-side half of this.
 */
function commentItemHtml(c, uid, isPostOwner) {
  const author = authorProfile(c.authorUid, c.authorName);
  const isOwnComment = c.authorUid === uid;
  const canDelete = isOwnComment || isPostOwner;
  const kebabActions = [];
  if (isOwnComment) kebabActions.push({ action: "edit", label: "Edit Comment" });
  if (canDelete) kebabActions.push({ action: "delete", label: isOwnComment ? "Delete Comment" : "Remove Comment", danger: true });
  return `
    <div class="comment-item">
      <button type="button" class="avatar avatar-sm avatar-btn" data-author="${c.authorUid}">${avatarInner(author)}</button>
      <div class="comment-body">
        <button type="button" class="comment-author" data-author="${c.authorUid}">${nameWithBadge(c.authorName, c.authorEmail)}</button>
        <p>${richTextHtml(c.text, c.mentions)}</p>
        <small>${timeAgo(c.createdAt)}${c.editedAt ? " · edited" : ""}</small>
      </div>
      ${kebabActions.length ? kebabMenuHtml(c.id, kebabActions) : ""}
    </div>`;
}

/**
 * Wires the comment box's live "n/limit" counter. Doesn't use the generic
 * wireCharCounter() from ui-utils.js because the counter here sits below
 * the whole avatar/input/send-button row rather than directly after the
 * <input> itself — this re-render (see renderPostDetail) rebuilds that
 * row from scratch every time anyway, so it's rewired fresh each time.
 */
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
  if (sendBtn.disabled) return; // guards against a double-send race (Enter + tap)
  const input = commentsEl.querySelector(".comment-input-row input");
  const text = input.value.trim();
  if (!text) return;
  const mentions = getMentions ? getMentions() : [];

  // Clear the field immediately, BEFORE the write. addDoc()'s optimistic
  // local write can make the comments onSnapshot fire (and re-render this
  // whole box, restoring "draftText" — see renderPostDetail) before this
  // async function ever resumes after `await`. If we only cleared the
  // input afterwards, we'd be clearing a DOM node that re-render had
  // already replaced, so the field visibly kept the typed text. Clearing
  // first means that even if that race happens, the draft it restores is
  // already empty.
  input.value = "";
  input.dispatchEvent(new Event("input")); // refresh the char counter now that the field's been cleared
  sendBtn.disabled = true;
  sendBtn.classList.add("is-loading");
  try {
    await addDoc(collection(db, "posts", postId, "comments"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      authorEmail: auth.currentUser.email,
      text,
      mentions,
      createdAt: serverTimestamp()
    });
    // Only notify the post's author, and never notify someone that they
    // commented on their own post — that's not a meaningful notification.
    if (postAuthorUid && postAuthorUid !== auth.currentUser.uid) {
      logActivity({ type: "comment", text, targetUid: postAuthorUid, postId });
      triggerPush({ type: "comment", text, actorName: currentProfile.name, targetUid: postAuthorUid, postId });
    }
    // @mentions in a comment notify those specific classmates too (never the commenter themself).
    mentions.forEach((m) => {
      if (!m.uid || m.uid === auth.currentUser.uid) return;
      logActivity({ type: "mention", text, targetUid: m.uid, postId });
      triggerPush({ type: "mention", text, actorName: currentProfile.name, targetUid: m.uid, postId });
    });
  } catch (err) {
    // Put the text back so it isn't lost if the write failed.
    const liveInput = commentsEl.querySelector(".comment-input-row input");
    if (liveInput) { liveInput.value = text; liveInput.dispatchEvent(new Event("input")); }
    showToast("Couldn't send your comment: " + err.message);
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
      closeModal(); // the live comments listener redraws the thread with the edit
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}
