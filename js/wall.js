// ============================================================
// WALL.JS — Student Wall / Community Feed
// Posts live in the "posts" collection. Each post has a
// "comments" subcollection. Likes are stored as an array of
// uids on the post doc so the like count is always in sync.
// ============================================================
import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, doc, getDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, limit, where,
  serverTimestamp, arrayUnion, arrayRemove, getDocs, deleteField, startAfter
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
import { uploadImages } from "./cloudinary.js";
import { logActivity, deleteActivityForPost } from "./routine.js";
import { triggerPush } from "./push-trigger.js";
import { imagePickerHtml, wireImagePicker, postImagesHtml, applyPostImageRatios } from "./media-picker.js";
import { getAllStudents } from "./directory.js";

// ============================================================
// REACTIONS — a small fixed emoji set (kept small on purpose: a
// bigger picker is harder to hit accurately on a phone, and a
// department Wall doesn't need Facebook's full set). A plain tap on
// the button toggles the default 👍; press-and-hold opens the picker
// to pick (or switch to) a specific one. Stored as a uid -> emoji map
// on the post ("reactions"), with "likes" kept alongside as a plain
// array of the same uids purely for back-compat with older code paths
// (the "liked by" count, etc.) — see reactionsOf() for the read side.
// ============================================================
export const REACTION_EMOJIS = ["👍", "❤️", "😂", "😮", "😢"];
const DEFAULT_REACTION = "👍";
const OUTLINE_LEAF_SVG = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 4c-8 0-16 4-16 13 0 1.5.3 2.6.8 3.4C6 15 11 9 18 6c-6 4-10 10-12.4 13.7.5.2 1 .3 1.4.3C16 20 20 12 20 4z"/></svg>`;

/** Read-side reaction map — old posts only ever had a `likes` array, so treat every uid in it as a legacy 👍. */
function reactionsOf(post) {
  return post.reactions || Object.fromEntries((post.likes || []).map((uid) => [uid, DEFAULT_REACTION]));
}

/**
 * Wires @mention autocomplete onto a composer/comment field. Returns
 * getMentions(), which reconciles everyone picked from the dropdown
 * against whatever's still actually in the text at submit time — so
 * deleting an "@Name" after picking it doesn't leave a stale mention
 * (and a stale push notification) behind. `initial` seeds already-
 * -known mentions back in (used when re-opening the Edit Post modal).
 */
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

// ============================================================
// PAGINATION — true cursor-based (startAfter), not "grow the live
// query's limit and resubscribe". That older approach re-fetched every
// already-seen post on each "Load earlier posts" click (even if served
// from Firestore's local cache, it still re-ran the whole listener),
// which got wasteful as both the Wall and its scroll depth grew.
//
// Now only the newest WALL_PAGE_SIZE posts are ever live (onSnapshot) —
// that's the part people are actually looking at, where new posts/likes/
// edits/deletes need to show up in real time. "Load earlier posts" is a
// separate one-shot getDocs() per click, cursored with startAfter() off
// the oldest post loaded so far, and those older posts are appended as
// static data — they won't move if edited/deleted by someone else while
// still on screen (a manual refresh picks that up), which is the
// deliberate trade-off for not re-reading/re-listening to the entire
// scroll depth on every click. Your OWN actions on an older post (like,
// comment, edit, delete) still work and update in place immediately —
// see the optimistic updates throughout this file — this only affects
// picking up someone ELSE'S concurrent change to a post you've already
// scrolled past.
//
// KNOWN EDGE CASE: because the live page and the older pages are two
// separate queries, if enough new posts arrive to push the exact post
// that was the live/older boundary at cursor-time out of the live
// window, that one post can briefly go unrendered until the Wall is
// next reloaded (subscribeWall() recomputes everything fresh). Rare in
// practice, self-heals on reload, and not a data-loss issue — the post
// is still safely in Firestore the whole time.
// ============================================================
const WALL_PAGE_SIZE = 20;
let liveDocs = [];      // newest page — kept live by onSnapshot
let olderDocs = [];     // everything loaded via "Load earlier posts" — static snapshots
let hasMoreOlder = true; // false once a getDocs() page comes back short (reached the very end)
let loadingOlder = false; // guards against a double-click firing two overlapping fetches

// Reasonable ceiling on a single post's text — long enough for a real
// question or update, short enough that one runaway post can't blow up
// the feed's layout for everyone scrolling past it.
const POST_TEXT_LIMIT = 3000;

/** Resolve a full-enough profile object (for the avatar/badge) from the shared cache, uid, and stored name. */
export function authorProfile(uid, fallbackName) {
  const cached = getCachedProfile(uid);
  if (!cached) ensureProfileLoaded(uid); // cache miss — kick off a one-off fetch, refreshAuthorAvatars() will pick it up
  return cached || { uid, name: fallbackName };
}

// Re-draws just the avatar(s) for one author, wherever they appear in the
// currently-rendered Wall, once their profile lands in the shared cache
// (whether that's the Directory listener warming up or the ensureProfileLoaded
// fallback above) — so a photo never has to wait for the next full re-render.
function refreshAuthorAvatars(uid) {
  const profile = getCachedProfile(uid);
  if (!profile) return;
  document.querySelectorAll(`.avatar[data-author="${uid}"]`).forEach(el => {
    el.innerHTML = avatarInner(profile);
  });
}

/** Wire up the composer + start the realtime post listener. Call once on login. */
export function initWall() {
  composerTrigger.addEventListener("click", openComposerModal);
  subscribeToProfileUpdates(refreshAuthorAvatars);
  subscribeWall();
}

function subscribeWall() {
  if (unsubscribePosts) unsubscribePosts();
  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(WALL_PAGE_SIZE));
  unsubscribePosts = onSnapshot(q, (snap) => {
    liveDocs = snap.docs;
    renderWallList();
  }, (err) => {
    const { message, technical } = friendlyError(err, "Couldn't load the wall.");
    showToast(message, { details: technical });
  });
}

/** Merge the live page + every "Load earlier" page fetched so far, and (re)draw the feed. */
function renderWallList() {
  if (!liveDocs.length && !olderDocs.length) {
    wallList.innerHTML = `<p class="empty-state">No posts yet. Be the first to write on the wall.</p>`;
    return;
  }
  wallList.innerHTML = `<div class="flat-list feed-list"></div>`;
  const listEl = wallList.querySelector(".feed-list");
  // Pinned posts (admin-set) float to the top of everything loaded so far;
  // everything else keeps newest-first order. Array.prototype.sort is a
  // stable sort, so within "pinned" and within "not pinned" the existing
  // newest-first order (live page, then each older page in fetch order)
  // is preserved exactly.
  const docs = [...liveDocs, ...olderDocs].sort((a, b) => (b.data().pinned ? 1 : 0) - (a.data().pinned ? 1 : 0));
  docs.forEach((docSnap) => renderPost(docSnap.id, docSnap.data(), listEl, { onChanged: () => refreshStaticPost(docSnap.id) }));

  if (hasMoreOlder) {
    const loadMoreBtn = document.createElement("button");
    loadMoreBtn.type = "button";
    loadMoreBtn.className = "btn-outline full wall-load-more";
    loadMoreBtn.textContent = "Load earlier posts";
    loadMoreBtn.addEventListener("click", () => loadOlderPosts(loadMoreBtn));
    wallList.appendChild(loadMoreBtn);
  }
}

/** One-shot fetch of the next page of older posts, cursored right after the last post currently loaded. */
async function loadOlderPosts(btn) {
  if (loadingOlder) return;
  const cursor = olderDocs.length ? olderDocs[olderDocs.length - 1] : liveDocs[liveDocs.length - 1];
  if (!cursor) return;
  loadingOlder = true;
  setBtnLoading(btn, true, "Loading…");
  try {
    const q = query(collection(db, "posts"), orderBy("createdAt", "desc"), startAfter(cursor), limit(WALL_PAGE_SIZE));
    const snap = await getDocs(q);
    olderDocs = olderDocs.concat(snap.docs);
    hasMoreOlder = snap.size === WALL_PAGE_SIZE;
    renderWallList();
  } catch (err) {
    const { message, technical } = friendlyError(err, "Couldn't load earlier posts.");
    showToast(message, { details: technical });
    setBtnLoading(btn, false);
  } finally {
    loadingOlder = false;
  }
}

// A post among the "static" older pages has no live listener of its own,
// so an edit/delete on it (by whoever's viewing it, if they're the owner
// or an admin — see renderPost's kebab menu) wouldn't otherwise show up
// until the whole Wall is reloaded. renderWallList() passes this in as
// every post's `onChanged` so that still happens right away: re-fetch that
// one doc and either swap in its fresh data (edited) or drop it (deleted).
// If the post is actually on the live page, the onSnapshot listener above
// already handles it (usually before this even runs) — that early-return
// just avoids doing redundant work in that case, never a correctness issue
// either way.
async function refreshStaticPost(postId) {
  if (liveDocs.some((d) => d.id === postId)) return; // the live listener already has this one covered
  try {
    const snap = await getDoc(doc(db, "posts", postId));
    olderDocs = snap.exists()
      ? olderDocs.map((d) => (d.id === postId ? snap : d))
      : olderDocs.filter((d) => d.id !== postId);
    renderWallList();
  } catch { /* best-effort — a manual reload still picks up the change */ }
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
      <textarea id="post-input" class="composer-modal-textarea" placeholder="Ask a question or share something with the department… (@mention a classmate, #tag a topic)" rows="6" maxlength="${POST_TEXT_LIMIT}" autofocus></textarea>
      ${imagePickerHtml("post-image-input")}
      <button type="button" class="composer-poll-toggle" id="poll-toggle-btn">
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
        <span>Add a poll</span>
      </button>
      <div class="poll-builder hidden" id="poll-builder">
        <div class="poll-builder-options" id="poll-options">
          <input type="text" class="poll-option-input" placeholder="Option 1" maxlength="80" />
          <input type="text" class="poll-option-input" placeholder="Option 2" maxlength="80" />
        </div>
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

/** Wires the composer's "Add a poll" toggle + dynamic option list. Returns getPoll(), which is null unless the poll is enabled with 2+ filled-in options. */
function wirePollBuilder() {
  const toggleBtn = document.getElementById("poll-toggle-btn");
  const builder = document.getElementById("poll-builder");
  const optionsWrap = document.getElementById("poll-options");
  const addBtn = document.getElementById("poll-add-option");
  let enabled = false;

  toggleBtn.addEventListener("click", () => {
    enabled = !enabled;
    builder.classList.toggle("hidden", !enabled);
    toggleBtn.classList.toggle("active", enabled);
    toggleBtn.querySelector("span").textContent = enabled ? "Remove poll" : "Add a poll";
  });
  addBtn.addEventListener("click", () => {
    if (optionsWrap.children.length >= 6) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "poll-option-input";
    input.maxLength = 80;
    input.placeholder = `Option ${optionsWrap.children.length + 1}`;
    optionsWrap.appendChild(input);
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
  if (btn.disabled) return; // guards against a double-post race (button click + Ctrl/Cmd+Enter)
  const errorEl = document.getElementById("post-error");
  const text = textarea.value.trim();
  errorEl.textContent = "";

  if (!text) { errorEl.textContent = "Write something before posting."; return; }
  if (!currentProfile) { errorEl.textContent = "Your profile hasn't loaded yet — try again in a second."; return; }

  const poll = getPoll ? getPoll() : null;
  const mentions = getMentions ? getMentions() : [];
  const hashtags = extractHashtags(text);

  setBtnLoading(btn, true, "Posting…");
  try {
    const files = getImageFiles ? getImageFiles() : [];
    let images = [];
    if (files.length) {
      setBtnLoading(btn, true, "Uploading photos…");
      images = await uploadImages(files, { maxDim: 1600, quality: 0.78, folder: "geohub/posts" });
      setBtnLoading(btn, true, "Posting…");
    }
    const postRef = await addDoc(collection(db, "posts"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      authorEmail: auth.currentUser.email,
      text,
      images,
      likes: [],
      reactions: {},
      pinned: false,
      hashtags,
      mentions,
      poll,
      createdAt: serverTimestamp()
    });
    closeModal();
    showToast("Posted to the Student Wall.");
    logActivity({ type: "post", text, postId: postRef.id });
    triggerPush({ type: "post", text, actorName: currentProfile.name, postId: postRef.id });
    notifyMentions(mentions, text, postRef.id);
  } catch (err) {
    errorEl.textContent = "Couldn't publish your post: " + err.message;
    setBtnLoading(btn, false);
  }
}

/** Fires a "mentioned you" push + activity entry for everyone @mentioned, except the author themself. */
function notifyMentions(mentions, text, postId) {
  (mentions || []).forEach((m) => {
    if (!m.uid || m.uid === auth.currentUser.uid) return;
    logActivity({ type: "mention", text, targetUid: m.uid, postId });
    triggerPush({ type: "mention", text, actorName: currentProfile.name, targetUid: m.uid, postId });
  });
}

// ============================================================
// EDIT / DELETE OWN POST — reached via the post's three-dot menu
// ============================================================
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

// ============================================================
// REPORT POST — lets a classmate flag a post for the admin/CR to
// review, without giving them any power over the post themselves
// (no edit, no delete — that stays owner/admin-only per the Firestore
// rules). Writes to a "reports" collection only the admin can read.
// ============================================================
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
      // Live bell/report-button badges pick this up via the "reports"
      // listener in routine.js; this push is what reaches the admin even
      // when GeoHub isn't currently open on their device.
      triggerPush({ type: "report", text: reason, actorName: currentProfile ? currentProfile.name : "A classmate", reportId: reportRef.id });
    } catch (err) {
      document.getElementById("report-error").textContent = "Couldn't send report: " + err.message;
      setBtnLoading(e.currentTarget, false);
    }
  });
}

/** Deletes every comment first (so nothing orphaned lingers server-side), then the post itself. */
export async function deletePost(postId, onDeleted) {
  const commentsSnap = await getDocs(collection(db, "posts", postId, "comments"));
  await Promise.all(commentsSnap.docs.map(c => deleteDoc(c.ref)));
  await deleteDoc(doc(db, "posts", postId));
  deleteActivityForPost(postId); // best-effort: drop the "posted"/"liked"/"commented" notifications this post generated
  showToast("Post deleted.");
  onDeleted?.();
}

// ============================================================
// POST RENDERING — flat feed row, no card chrome. Shared by the
// realtime Wall feed AND a profile's "Posts" tab (own or a
// classmate's), so likes/comments/kebab all work identically
// everywhere a post can appear. Tapping the post itself (its text,
// its photos, empty space, or the Comment pill) opens the full Post
// Detail page — only the Like button, the like-count/"liked by"
// pill, the author's avatar/name, and the kebab menu are excluded
// from that, since they're their own controls.
// ============================================================
export function renderPost(postId, post, listEl, { onChanged } = {}) {
  const uid = auth.currentUser.uid;
  const reactions = reactionsOf(post);
  const myReaction = reactions[uid] || null;
  const reactionCount = Object.keys(reactions).length;

  const author = authorProfile(post.authorUid, post.authorName);
  const isOwnPost = post.authorUid === uid;
  // An admin (CR) can remove any post as a moderation action — e.g. after
  // a report — even one they didn't write, and can pin/unpin ANY post
  // (including their own). A student who didn't write the post (and isn't
  // the admin) gets a "Report" option instead of edit/delete.
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
      <button type="button" class="avatar avatar-btn" data-author="${post.authorUid}" aria-label="View ${escapeHtml(author.name || post.authorName || "classmate")}’s profile">${avatarInner(author)}</button>
      <div class="post-meta">
        <button type="button" class="post-author-name" data-author="${post.authorUid}">${nameWithBadge(post.authorName, post.authorEmail)}</button>
        <small>${post.pinned ? "📌 Pinned · " : ""}${timeAgo(post.createdAt)}${post.editedAt ? " · edited" : ""}</small>
      </div>
      ${kebabMenuHtml(postId, kebabActions)}
    </div>
    ${clampableRichHtml(post.text, post.mentions, "post-text")}
    ${postImagesHtml(post.images)}
    ${pollHtml(post)}
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
      <button type="button" class="post-like-count ${reactionCount ? "" : "hidden"}" data-id="${postId}">
        ${reactionSummaryHtml(reactions)}
      </button>
    </div>
  `;

  const reactionBtn = el.querySelector(".reaction-btn");
  const likeCountBtn = el.querySelector(".post-like-count");

  el.querySelectorAll("[data-author]").forEach(b =>
    b.addEventListener("click", () => openUserProfilePage(post.authorUid)));
  wireReactionControl(el, postId, post);
  likeCountBtn.addEventListener("click", () => openReactionsModal(reactionsOf(post)));
  el.querySelector(".comment-toggle-btn").addEventListener("click", async () => {
    const { openPostDetailPage } = await import("./post-detail.js");
    openPostDetailPage(postId, { focusComment: true });
  });
  // Any other tap on the card (text, photos, empty space) opens the Post
  // Detail page — Facebook-style. The controls above are excluded here so
  // they keep doing their own thing instead of also navigating.
  el.addEventListener("click", async (e) => {
    if (e.target.closest(".reaction-control, .post-like-count, .kebab-menu, [data-author], .comment-toggle-btn, .clamp-toggle, .mention-chip, .hashtag-chip, .poll-block")) return;
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

/** Small "👍❤️😂 12" summary pill — top 3 emoji used, by how many people used them, then the total count. */
function reactionSummaryHtml(reactions) {
  const counts = {};
  Object.values(reactions).forEach((e) => { counts[e] = (counts[e] || 0) + 1; });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([e]) => e);
  const total = Object.keys(reactions).length;
  return `<span class="reaction-summary-emojis">${top.join("")}</span> ${total} ${total === 1 ? "reaction" : "reactions"}`;
}

/**
 * Paint a reaction button + its summary pill to match `post`'s reactions.
 * Pulled out of reactToPost() so both it (optimistic update) and any
 * listener-driven re-render can reach the exact same visual result.
 */
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
}

// ============================================================
// REACTION PICKER — a plain tap on the button toggles the default
// 👍 on/off; press-and-hold pops a small emoji row above it to pick
// (or switch to) a specific reaction. Only one picker is ever open
// at a time, closed the same way the kebab-menu dropdowns are.
// ============================================================
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
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (longPressed) { longPressed = false; return; } // the long-press already opened the picker
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

/**
 * Set/change/clear this student's reaction on a post. Updates the button +
 * summary pill immediately (rather than waiting on a re-render), so this
 * looks and feels identical whether it's tapped from the Wall's realtime
 * feed or from a one-shot list like a profile's Posts tab or the Post
 * Detail page. Passing the same emoji the student already has removes it
 * (un-react); `emoji: null` always removes it.
 */
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
    // Only notify on a fresh reaction (not on removing one), and only if
    // someone else's post — never notify a student about their own post.
    if (next && !current && authorUid && authorUid !== uid) {
      logActivity({ type: "like", targetUid: authorUid, postId });
      triggerPush({ type: "like", actorName: currentProfile.name, targetUid: authorUid, postId });
    }
  } catch (err) {
    // Revert the optimistic change if the write actually failed.
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

// ============================================================
// "WHO REACTED" — resolves each uid to a name via the shared
// profile cache (warmed by directory.js), fetching any it's missing.
// ============================================================
export async function openReactionsModal(reactions) {
  const uids = Object.keys(reactions || {});
  if (!uids.length) return;
  openModal(`<h3>Reactions</h3>${skeletonRowsHtml(Math.min(uids.length, 4))}`);

  const people = await Promise.all(uids.map(async (uid) => {
    let p = getCachedProfile(uid);
    if (!p) {
      try { p = await fetchProfile(uid); if (p) cacheUserProfile(uid, p); } catch { /* ignore */ }
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
      // Close the modal WITHOUT letting it pop its own history entry
      // (keepHistory) — otherwise that history.back() races the profile page's
      // own history.pushState and the navigation can silently fail. Instead we
      // replace the modal's entry with the profile page's ({ replace: true }).
      closeModal({ keepHistory: true });
      openUserProfilePage(row.dataset.uid, { replace: true });
    }));
}

// ============================================================
// PIN POST — admin/CR only. Toggling this doesn't touch anything
// else on the post (see firestore.rules), so it works even on a
// post the admin didn't write.
// ============================================================
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

// ============================================================
// POLLS — a post can optionally carry a single-choice poll. Votes
// are stored as { [uid]: optionId } on the post; tapping the option
// you already picked retracts your vote, tapping another switches it.
// ============================================================
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

// ============================================================
// HASHTAGS — tapping a "#tag" chip in a post shows every post that
// carries it. array-contains is a single-field filter, so this needs
// no composite Firestore index (see routine.js's activity queries for
// why that matters — a missing index otherwise fails silently).
// ============================================================
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

/** Detach the realtime listener (call on logout to avoid leaks). */
export function teardownWall() {
  if (unsubscribePosts) unsubscribePosts();
  unsubscribePosts = null;
  liveDocs = [];
  olderDocs = [];
  hasMoreOlder = true; // fresh pagination state on next login
  loadingOlder = false;
}
