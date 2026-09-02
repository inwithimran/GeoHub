import { db, auth } from "./firebase-config.js";
import { onSnapshotWithRetry } from "./realtime-retry.js";
import {
  doc, collection, query, orderBy, deleteDoc
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
  openReactionsModal, wireReactionControl, paintReactionButton, REACTION_EMOJIS, reactionGlyphHtml, reactionLabel,
  pollHtml, wirePoll, togglePinPost, setCommentCountCache, paintCommentCountBtn,
  updateStatsRowVisibility, commentCountLabel, wireCommentReactionControl
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
let pendingComments = [];
let rerenderRef = null;

const unsubscribeProfileUpdates = subscribeToProfileUpdates((uid) => {
  const profile = getCachedProfile(uid);
  if (!profile || !bodyEl) return;
  bodyEl.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
});

const COMMENT_TEXT_LIMIT = 500;

const COMMENT_LONG_PRESS_MS = 420;
const COMMENT_LONG_PRESS_MOVE_TOLERANCE = 10;
const commentDataCache = new Map();

function closeCommentActionMenu() {
  document.querySelector(".msg-action-backdrop")?.remove();
}
document.addEventListener("scroll", closeCommentActionMenu, true);

function wireCommentLongPress(commentsEl, handlers) {
  commentsEl.querySelectorAll(".comment-item:not(.comment-item-pending)").forEach((item) => {
    const body = item.querySelector(".comment-body");
    if (!body || body.dataset.longpressWired) return;
    body.dataset.longpressWired = "1";

    let pressTimer = null;
    let startX = 0, startY = 0;

    const cancelPress = () => clearTimeout(pressTimer);
    const startPress = (e) => {
      startX = e.clientX; startY = e.clientY;
      pressTimer = setTimeout(() => openCommentActionMenu(item, handlers), COMMENT_LONG_PRESS_MS);
    };
    const trackMove = (e) => {
      if (Math.abs(e.clientX - startX) > COMMENT_LONG_PRESS_MOVE_TOLERANCE || Math.abs(e.clientY - startY) > COMMENT_LONG_PRESS_MOVE_TOLERANCE) {
        cancelPress();
      }
    };

    body.addEventListener("pointerdown", startPress);
    body.addEventListener("pointerup", cancelPress);
    body.addEventListener("pointerleave", cancelPress);
    body.addEventListener("pointercancel", cancelPress);
    body.addEventListener("pointermove", trackMove);
    body.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function openCommentActionMenu(item, handlers) {
  closeCommentActionMenu();
  const commentId = item.dataset.commentId;
  const canEdit = item.dataset.canEdit === "1";
  const canDelete = item.dataset.canDelete === "1";
  const isOwn = item.dataset.ownLabel === "1";
  const cached = commentDataCache.get(commentId) || { text: "" };

  const backdrop = document.createElement("div");
  backdrop.className = "msg-action-backdrop";
  backdrop.addEventListener("click", closeCommentActionMenu);

  const menu = document.createElement("div");
  menu.className = "msg-action-menu";
  menu.innerHTML = `
    <button type="button" class="msg-action-item" data-action="copy">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy
    </button>
    ${canEdit ? `<button type="button" class="msg-action-item" data-action="edit">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
      Edit Comment
    </button>` : ""}
    ${canDelete ? `<button type="button" class="msg-action-item danger" data-action="delete">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
      ${isOwn ? "Delete Comment" : "Remove Comment"}
    </button>` : ""}
  `;
  backdrop.appendChild(menu);
  document.body.appendChild(backdrop);

  const itemRect = item.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 8;
  let left = itemRect.left + 38;
  left = Math.min(Math.max(left, 8), window.innerWidth - menuRect.width - 8);
  let top = itemRect.top - menuRect.height - gap;
  if (top < 8) top = Math.min(itemRect.bottom + gap, window.innerHeight - menuRect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  menu.querySelectorAll(".msg-action-item").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      closeCommentActionMenu();
      if (action === "copy") {
        navigator.clipboard?.writeText(cached.text || "")
          .then(() => showToast("Comment copied"))
          .catch(() => showToast("Couldn't copy that comment."));
      } else if (action === "edit") {
        handlers.edit(commentId);
      } else if (action === "delete") {
        handlers.delete(commentId);
      }
    });
  });
}

function wireReplyToggles(commentsEl) {
  commentsEl.querySelectorAll(".comment-replies-toggle").forEach((btn) => {
    if (btn.dataset.toggleWired) return;
    btn.dataset.toggleWired = "1";
    const repliesEl = btn.nextElementSibling;
    if (!repliesEl || !repliesEl.classList.contains("comment-replies")) return;

    btn.addEventListener("click", () => {
      const labelEl = btn.querySelector(".comment-replies-toggle-label");
      const isOpen = !repliesEl.classList.contains("hidden");
      if (isOpen) {
        repliesEl.classList.add("hidden");
        btn.classList.remove("is-expanded");
        if (labelEl) labelEl.textContent = btn.dataset.label;
        return;
      }
      if (btn.dataset.loading === "1") return;
      btn.dataset.loading = "1";
      btn.disabled = true;
      if (labelEl) labelEl.innerHTML = `<span class="btn-spinner dark" aria-hidden="true"></span>`;
      setTimeout(() => {
        repliesEl.classList.remove("hidden");
        btn.classList.add("is-expanded");
        if (labelEl) labelEl.textContent = "Hide replies";
        btn.disabled = false;
        btn.dataset.loading = "0";
      }, 420);
    });
  });
}

export function openPostDetailPage(postId, { fromPopstate = false, replace = false, focusComment = false } = {}) {
  if (!postId || !bodyEl) return;
  teardownPostDetail();
  currentPostId = postId;
  pendingComments = [];

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
  rerenderRef = render;

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
    render();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load comments.");
    showToast(message, { details: technical });
  });
}

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
  rerenderRef = null;
}

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

  const prevReplyChip = container.querySelector(".reply-target-chip");
  const replyTarget = prevReplyChip && !prevReplyChip.classList.contains("hidden")
    ? { id: prevReplyChip.dataset.id, name: prevReplyChip.dataset.name }
    : null;

  const prevExpandedReplies = new Set(
    [...container.querySelectorAll(".comment-replies:not(.hidden)")]
      .map(el => el.dataset.repliesFor)
      .filter(Boolean)
  );

  if (commentsLoaded) setCommentCountCache(postId, comments.length);

  const topLevelComments = comments.filter(c => !c.replyTo);
  const topLevelIds = new Set(topLevelComments.map(c => c.id));
  const repliesByParent = new Map();
  comments.filter(c => c.replyTo).forEach(c => {
    const pid = c.replyTo.id;
    if (!repliesByParent.has(pid)) repliesByParent.set(pid, []);
    repliesByParent.get(pid).push(c);
  });
  const orphanReplies = [];
  [...repliesByParent.keys()].filter(pid => !topLevelIds.has(pid)).forEach((pid) => {
    orphanReplies.push(...repliesByParent.get(pid));
    repliesByParent.delete(pid);
  });
  const pendingTopLevel = pendingComments.filter(p => !p.replyTo);
  const pendingByParent = new Map();
  pendingComments.filter(p => p.replyTo).forEach(p => {
    const pid = p.replyTo.id;
    if (!pendingByParent.has(pid)) pendingByParent.set(pid, []);
    pendingByParent.get(pid).push(p);
  });
  const commentThreadHtml = (c) => {
    const replies = repliesByParent.get(c.id) || [];
    const pendingReplies = pendingByParent.get(c.id) || [];
    const pendingHtml = pendingReplies.map(pendingCommentItemHtml).join("");

    if (!replies.length) {
      return commentItemHtml(c, uid, isOwnPost)
        + (pendingHtml ? `<div class="comment-replies" data-replies-for="${c.id}">${pendingHtml}</div>` : "");
    }

    const repliesHtml = replies.map(r => replyItemHtml(r, uid, isOwnPost, c)).join("") + pendingHtml;
    const forceOpen = prevExpandedReplies.has(c.id) || pendingReplies.length > 0;
    const label = replies.length === 1 ? "View 1 reply" : `View ${replies.length} replies`;
    return commentItemHtml(c, uid, isOwnPost) + `
      <button type="button" class="comment-replies-toggle ${forceOpen ? "is-expanded" : ""}" data-parent-id="${c.id}" data-label="${escapeHtml(label)}">
        <span class="comment-replies-toggle-line" aria-hidden="true"></span>
        <span class="comment-replies-toggle-label">${forceOpen ? "Hide replies" : escapeHtml(label)}</span>
      </button>
      <div class="comment-replies ${forceOpen ? "" : "hidden"}" data-replies-for="${c.id}">${repliesHtml}</div>`;
  };
  const orphanRepliesHtml = orphanReplies.map((c) => {
    const tag = c.replyTo ? `<div class="reply-context">↳ Replying to ${escapeHtml(c.replyTo.authorName || "")} (original comment removed)</div>` : "";
    return commentItemHtml(c, uid, isOwnPost, tag);
  }).join("");

  const commentsHtml = !commentsLoaded
    ? commentSkeletonHtml()
    : (comments.length
        ? topLevelComments.map(commentThreadHtml).join("") + orphanRepliesHtml
        : `<p class="empty-state" style="padding:10px 0;">No comments yet — be the first to reply.</p>`)
      + pendingTopLevel.map(pendingCommentItemHtml).join("");

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
      <div class="post-stats hidden">
        <button type="button" class="post-like-count hidden"></button>
        <button type="button" class="stats-comment-count ${commentsLoaded && comments.length ? "" : "hidden"}">${commentsLoaded ? commentCountLabel(comments.length) : ""}</button>
      </div>
      <div class="post-actions">
        <div class="reaction-control">
          <button type="button" class="post-action-btn reaction-btn" data-id="${postId}">
            <span class="reaction-icon" aria-hidden="true"></span>
            <span>Like</span>
          </button>
          <div class="reaction-picker hidden">
            ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-option ${e === "leaf" ? "reaction-option-leaf" : ""}" data-emoji="${e}" aria-label="${reactionLabel(e)}" title="${reactionLabel(e)}">${reactionGlyphHtml(e)}</button>`).join("")}
          </div>
        </div>
        <button type="button" class="post-action-btn comment-jump-btn">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>
          <span>Comment</span>
        </button>
      </div>
    </article>
    <div class="comments-block">
      ${commentsHtml}
      <div class="reply-target-chip ${replyTarget ? "" : "hidden"}" data-id="${replyTarget ? replyTarget.id : ""}" data-name="${replyTarget ? escapeHtml(replyTarget.name) : ""}">
        Replying to <strong>${replyTarget ? escapeHtml(replyTarget.name) : ""}</strong>
        <button type="button" class="reply-target-cancel" aria-label="Cancel reply">✕</button>
      </div>
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
  const statsCommentBtn = postEl.querySelector(".stats-comment-count");
  statsCommentBtn.addEventListener("click", () => focusCommentInput(container));
  updateStatsRowVisibility(postEl);
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
  comments.forEach((c) => {
    wireCommentReactionControl(commentsEl, postId, c.id, c);
    const countBtn = commentsEl.querySelector(`.comment-reaction-count[data-id="${c.id}"]`);
    if (countBtn) countBtn.addEventListener("click", () => openReactionsModal(c.reactions || {}));
  });
  wireCommentLongPress(commentsEl, {
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
  wireReplyToggles(commentsEl);

  const { getMentions, addMention } = wireMentions(input);
  const sendBtn = commentsEl.querySelector(".comment-send-btn");

  const replyChip = commentsEl.querySelector(".reply-target-chip");
  const replyChipNameEl = replyChip.querySelector("strong");
  const setReplyTarget = (id, name) => {
    replyChip.dataset.id = id || "";
    replyChip.dataset.name = name || "";
    replyChip.classList.toggle("hidden", !id);
    if (replyChipNameEl) replyChipNameEl.textContent = name || "";
  };
  const clearMentionText = (name) => {
    if (!name) return;
    const mentionText = `@${name} `;
    if (input.value.startsWith(mentionText)) {
      input.value = input.value.slice(mentionText.length);
    } else {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      input.value = input.value.replace(new RegExp(`@${escaped}\\s?`), "");
    }
    input.dispatchEvent(new Event("input"));
  };
  replyChip.querySelector(".reply-target-cancel").addEventListener("click", () => {
    clearMentionText(replyChip.dataset.name);
    setReplyTarget(null, null);
    focusCommentInput(container);
  });
  input.addEventListener("input", () => {
    if (replyChip.classList.contains("hidden")) return;
    const mentionName = replyChip.dataset.name;
    if (mentionName && !input.value.includes(`@${mentionName}`)) {
      setReplyTarget(null, null);
    }
  });
  commentsEl.querySelectorAll(".comment-reply-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      setReplyTarget(btn.dataset.id, btn.dataset.name);
      const mentionName = btn.dataset.name;
      const mentionUid = btn.dataset.authorUid;
      if (mentionName && mentionUid && mentionUid !== auth.currentUser.uid) {
        addMention(mentionUid, mentionName);
        const mentionText = `@${mentionName} `;
        if (!input.value.startsWith(mentionText)) input.value = mentionText + input.value;
        input.dispatchEvent(new Event("input"));
      }
      focusCommentInput(container);
      requestAnimationFrame(() => input.setSelectionRange(input.value.length, input.value.length));
    });
  });

  const doSubmit = () => {
    const replying = !replyChip.classList.contains("hidden")
      ? { id: replyChip.dataset.id, authorName: replyChip.dataset.name }
      : null;
    setReplyTarget(null, null);
    submitComment(postId, commentsEl, sendBtn, post.authorUid, getMentions, replying);
  };
  sendBtn.addEventListener("click", doSubmit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSubmit();
  });

  if (focusComment) focusCommentInput(container);
}

function reactionsOfPost(post) {
  return post.reactions || Object.fromEntries((post.likes || []).map((u) => [u, "leaf"]));
}


function commentItemHtml(c, uid, isPostOwner, contextTag = "") {
  const author = authorProfile(c.authorUid, c.authorName);
  const isOwnComment = c.authorUid === uid;
  const canDelete = isOwnComment || isPostOwner;
  commentDataCache.set(c.id, { text: c.text || "", mentions: c.mentions || [] });
  const reactions = c.reactions || {};
  const reactionCount = Object.keys(reactions).length;
  const myReaction = reactions[uid] || null;
  return `
    <div class="comment-item" data-comment-id="${c.id}" data-can-edit="${isOwnComment ? "1" : "0"}" data-can-delete="${canDelete ? "1" : "0"}" data-own-label="${isOwnComment ? "1" : "0"}">
      <span class="avatar-presence-wrap">
        <button type="button" class="avatar avatar-sm avatar-btn" data-author="${c.authorUid}" aria-label="View ${escapeHtml(author.name || c.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
        ${avatarPresenceDotHtml(c.authorUid)}
      </span>
      <div class="comment-col">
        <div class="comment-body">
          ${contextTag}
          <button type="button" class="comment-author" data-author="${c.authorUid}">${nameWithBadge(c.authorName, c.authorEmail)}</button>
          <p>${richTextHtml(c.text, c.mentions)}</p>
        </div>
        <div class="comment-foot">
          <div class="comment-reaction-control">
            <button type="button" class="comment-reaction-btn ${myReaction ? "liked" : ""}" data-id="${c.id}" aria-pressed="${!!myReaction}">
              <span class="reaction-icon" aria-hidden="true">${myReaction ? reactionGlyphHtml(myReaction) : ""}</span><span>${reactionLabel(myReaction)}</span>
            </button>
            <div class="reaction-picker hidden">
              ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-option ${e === "leaf" ? "reaction-option-leaf" : ""}" data-emoji="${e}" aria-label="${reactionLabel(e)}" title="${reactionLabel(e)}">${reactionGlyphHtml(e)}</button>`).join("")}
            </div>
          </div>
          <button type="button" class="comment-reply-btn" data-id="${c.id}" data-name="${escapeHtml(c.authorName || "Classmate")}" data-author-uid="${c.authorUid || ""}">Reply</button>
          <small>${timeAgo(c.createdAt)}${c.editedAt ? " · edited" : ""}</small>
          <button type="button" class="comment-reaction-count comment-reaction-badge ${reactionCount ? "" : "hidden"}" data-id="${c.id}"></button>
        </div>
      </div>
    </div>`;
}

function replyItemHtml(c, uid, isPostOwner, parentComment) {
  const author = authorProfile(c.authorUid, c.authorName);
  const isOwnComment = c.authorUid === uid;
  const canDelete = isOwnComment || isPostOwner;
  commentDataCache.set(c.id, { text: c.text || "", mentions: c.mentions || [] });
  const reactions = c.reactions || {};
  const reactionCount = Object.keys(reactions).length;
  const myReaction = reactions[uid] || null;
  const showReplyTag = c.replyTo && c.replyTo.authorUid && parentComment && c.replyTo.authorUid !== parentComment.authorUid;
  return `
    <div class="comment-item comment-item-reply" data-comment-id="${c.id}" data-can-edit="${isOwnComment ? "1" : "0"}" data-can-delete="${canDelete ? "1" : "0"}" data-own-label="${isOwnComment ? "1" : "0"}">
      <span class="avatar-presence-wrap">
        <button type="button" class="avatar avatar-xs avatar-btn" data-author="${c.authorUid}" aria-label="View ${escapeHtml(author.name || c.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
        ${avatarPresenceDotHtml(c.authorUid)}
      </span>
      <div class="comment-col">
        <div class="comment-body">
          ${showReplyTag ? `<div class="reply-context">↳ Replying to ${escapeHtml(c.replyTo.authorName || "")}</div>` : ""}
          <button type="button" class="comment-author" data-author="${c.authorUid}">${nameWithBadge(c.authorName, c.authorEmail)}</button>
          <p>${richTextHtml(c.text, c.mentions)}</p>
        </div>
        <div class="comment-foot">
          <div class="comment-reaction-control">
            <button type="button" class="comment-reaction-btn ${myReaction ? "liked" : ""}" data-id="${c.id}" aria-pressed="${!!myReaction}">
              <span class="reaction-icon" aria-hidden="true">${myReaction ? reactionGlyphHtml(myReaction) : ""}</span><span>${reactionLabel(myReaction)}</span>
            </button>
            <div class="reaction-picker hidden">
              ${REACTION_EMOJIS.map(e => `<button type="button" class="reaction-option ${e === "leaf" ? "reaction-option-leaf" : ""}" data-emoji="${e}" aria-label="${reactionLabel(e)}" title="${reactionLabel(e)}">${reactionGlyphHtml(e)}</button>`).join("")}
            </div>
          </div>
          <button type="button" class="comment-reply-btn" data-id="${c.replyTo.id}" data-name="${escapeHtml(c.authorName || "Classmate")}" data-author-uid="${c.authorUid || ""}">Reply</button>
          <small>${timeAgo(c.createdAt)}${c.editedAt ? " · edited" : ""}</small>
          <button type="button" class="comment-reaction-count comment-reaction-badge ${reactionCount ? "" : "hidden"}" data-id="${c.id}"></button>
        </div>
      </div>
    </div>`;
}

function pendingCommentItemHtml(p) {
  const replyTag = p.replyTo ? `<div class="reply-context">↳ Replying to ${escapeHtml(p.replyTo.authorName || "")}</div>` : "";
  return `
    <div class="comment-item comment-item-pending${p.replyTo ? " comment-item-reply" : ""}">
      <span class="avatar-presence-wrap">
        <span class="avatar ${p.replyTo ? "avatar-xs" : "avatar-sm"}">${avatarInner(currentProfile || {})}</span>
      </span>
      <div class="comment-col">
        <div class="comment-body comment-body-pending">
          ${replyTag}
          <span class="comment-author">${nameWithBadge(currentProfile ? currentProfile.name : "You", currentProfile ? currentProfile.email : "")}</span>
          <p>${escapeHtml(p.text)}</p>
        </div>
        <div class="comment-foot" aria-label="Sending comment">
          <span class="comment-sending-dots"><span></span><span></span><span></span></span>
        </div>
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

async function submitComment(postId, commentsEl, sendBtn, postAuthorUid, getMentions, replyTarget) {
  if (sendBtn.disabled) return; 
  const input = commentsEl.querySelector(".comment-input-row input");
  const text = input.value.trim();
  if (!text) return;
  const mentions = getMentions ? getMentions() : [];
  const replyTo = replyTarget && replyTarget.id ? { id: replyTarget.id, authorName: replyTarget.authorName } : null;
  
  input.value = "";
  input.dispatchEvent(new Event("input")); 
  sendBtn.disabled = true;
  sendBtn.classList.add("is-loading");

  const tempId = `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingComments.push({ tempId, text, replyTo });
  if (postId === currentPostId && rerenderRef) rerenderRef();

  const liveSendBtn = () => bodyEl?.querySelector(".comment-send-btn");
  const liveSendBtnNow = liveSendBtn();
  if (liveSendBtnNow) { liveSendBtnNow.disabled = true; liveSendBtnNow.classList.add("is-loading"); }

  try {
    const result = await callApi("create-comment", { postId, text, mentions, replyTo: replyTo ? { id: replyTo.id } : undefined });
    if (postAuthorUid && postAuthorUid !== auth.currentUser.uid) {
      logActivity({ type: "comment", text, targetUid: postAuthorUid, postId });
      triggerPush({ type: "comment", text, actorName: currentProfile.name, targetUid: postAuthorUid, postId });
    }
    if (replyTo && result && result.replyTargetUid &&
        result.replyTargetUid !== auth.currentUser.uid && result.replyTargetUid !== postAuthorUid) {
      logActivity({ type: "reply", text, targetUid: result.replyTargetUid, postId });
      triggerPush({ type: "reply", text, actorName: currentProfile.name, targetUid: result.replyTargetUid, postId, commentId: result.id });
    }
    mentions.forEach((m) => {
      if (!m.uid || m.uid === auth.currentUser.uid) return;
      logActivity({ type: "mention", text, targetUid: m.uid, postId });
      triggerPush({ type: "mention", text, actorName: currentProfile.name, targetUid: m.uid, postId });
    });
  } catch (err) {
    const liveInput = bodyEl?.querySelector(".comment-input-row input");
    if (liveInput) { liveInput.value = text; liveInput.dispatchEvent(new Event("input")); }
    const liveChip = bodyEl?.querySelector(".reply-target-chip");
    if (liveChip && replyTo) {
      liveChip.dataset.id = replyTo.id;
      liveChip.dataset.name = replyTo.authorName || "";
      liveChip.classList.remove("hidden");
      const nameEl = liveChip.querySelector("strong");
      if (nameEl) nameEl.textContent = replyTo.authorName || "";
    }
    const { message, technical } = friendlyError(err, "Couldn't send your comment.");
    showToast(message, { details: technical });
  } finally {
    pendingComments = pendingComments.filter((p) => p.tempId !== tempId);
    const btnAfter = liveSendBtn();
    if (btnAfter) { btnAfter.disabled = false; btnAfter.classList.remove("is-loading"); }
    if (postId === currentPostId && rerenderRef) rerenderRef();
  }
}

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
      await callApi("edit-comment", { postId, commentId, text, mentions: getMentions() });
      closeModal(); 
    } catch (err) {
      errorEl.textContent = "Couldn't save changes: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}
