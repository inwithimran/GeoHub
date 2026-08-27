// ============================================================
// WALL.JS — Student Wall / Community Feed
// Posts live in the "posts" collection. Each post has a
// "comments" subcollection. Likes are stored as an array of
// uids on the post doc so the like count is always in sync.
// ============================================================
import { db, auth } from "./firebase-config.js";
import {
  collection, addDoc, doc, updateDoc, onSnapshot, query, orderBy,
  serverTimestamp, arrayUnion, arrayRemove, getDocs
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { currentProfile } from "./auth.js";
import { showToast, escapeHtml, timeAgo, initialsOf } from "./ui-utils.js";

const wallList = document.getElementById("wall-list");
const postInput = document.getElementById("post-input");
const postSubmit = document.getElementById("post-submit");

let unsubscribePosts = null;
// Tracks which posts currently have their comment thread expanded
const openComments = new Set();

/** Wire up the composer + start the realtime post listener. Call once on login. */
export function initWall() {
  postSubmit.addEventListener("click", handleCreatePost);

  const q = query(collection(db, "posts"), orderBy("createdAt", "desc"));
  unsubscribePosts = onSnapshot(q, (snap) => {
    if (snap.empty) {
      wallList.innerHTML = `<p class="empty-state">No posts yet. Be the first to write on the wall.</p>`;
      return;
    }
    wallList.innerHTML = "";
    snap.forEach((docSnap) => renderPost(docSnap.id, docSnap.data()));
  }, (err) => showToast("Couldn't load the wall: " + err.message));
}

async function handleCreatePost() {
  const text = postInput.value.trim();
  if (!text) return;
  if (!currentProfile) return showToast("Your profile hasn't loaded yet — try again in a second.");

  postSubmit.disabled = true;
  try {
    await addDoc(collection(db, "posts"), {
      authorUid: auth.currentUser.uid,
      authorName: currentProfile.name,
      text,
      likes: [],
      createdAt: serverTimestamp()
    });
    postInput.value = "";
  } catch (err) {
    showToast("Couldn't publish your post: " + err.message);
  } finally {
    postSubmit.disabled = false;
  }
}

function renderPost(postId, post) {
  const uid = auth.currentUser.uid;
  const liked = (post.likes || []).includes(uid);
  const likeCount = (post.likes || []).length;

  const el = document.createElement("article");
  el.className = "post-item";
  el.innerHTML = `
    <div class="post-head">
      <div class="avatar">${initialsOf(post.authorName)}</div>
      <div class="post-meta">
        <strong>${escapeHtml(post.authorName || "Classmate")}</strong>
        <small>${timeAgo(post.createdAt)}</small>
      </div>
    </div>
    <p class="post-text">${escapeHtml(post.text)}</p>
    <div class="post-actions">
      <button class="post-action-btn like-btn ${liked ? "liked" : ""}" data-id="${postId}">
        👍 <span class="like-count">${likeCount}</span>
      </button>
      <button class="post-action-btn comment-toggle-btn" data-id="${postId}">💬 Comment</button>
    </div>
    <div class="comments-block hidden" data-comments-for="${postId}"></div>
  `;

  el.querySelector(".like-btn").addEventListener("click", () => toggleLike(postId, liked));
  el.querySelector(".comment-toggle-btn").addEventListener("click", () => toggleComments(postId, el));

  wallList.appendChild(el);

  // Re-open comment thread if it was open before this re-render
  if (openComments.has(postId)) {
    const block = el.querySelector(`[data-comments-for="${postId}"]`);
    block.classList.remove("hidden");
    loadComments(postId, block);
  }
}

async function toggleLike(postId, currentlyLiked) {
  const ref = doc(db, "posts", postId);
  await updateDoc(ref, {
    likes: currentlyLiked ? arrayRemove(auth.currentUser.uid) : arrayUnion(auth.currentUser.uid)
  });
}

function toggleComments(postId, postEl) {
  const block = postEl.querySelector(`[data-comments-for="${postId}"]`);
  const isOpen = !block.classList.contains("hidden");
  if (isOpen) {
    block.classList.add("hidden");
    openComments.delete(postId);
  } else {
    block.classList.remove("hidden");
    openComments.add(postId);
    loadComments(postId, block);
  }
}

async function loadComments(postId, block) {
  block.innerHTML = `<p class="empty-state" style="padding:8px 0;">Loading comments…</p>`;
  const q = query(collection(db, "posts", postId, "comments"), orderBy("createdAt", "asc"));
  const snap = await getDocs(q);

  let html = "";
  snap.forEach((c) => {
    const data = c.data();
    html += `<div class="comment-item"><strong>${escapeHtml(data.authorName)}:</strong>${escapeHtml(data.text)}</div>`;
  });
  if (!snap.size) html = `<p class="empty-state" style="padding:4px 0;">No comments yet.</p>`;

  html += `
    <div class="comment-input-row">
      <input type="text" placeholder="Write a comment…" data-comment-input="${postId}" />
      <button data-comment-send="${postId}">Send</button>
    </div>`;
  block.innerHTML = html;

  block.querySelector(`[data-comment-send="${postId}"]`).addEventListener("click", () => submitComment(postId, block));
  block.querySelector(`[data-comment-input="${postId}"]`).addEventListener("keydown", (e) => {
    if (e.key === "Enter") submitComment(postId, block);
  });
}

async function submitComment(postId, block) {
  const input = block.querySelector(`[data-comment-input="${postId}"]`);
  const text = input.value.trim();
  if (!text) return;
  await addDoc(collection(db, "posts", postId, "comments"), {
    authorUid: auth.currentUser.uid,
    authorName: currentProfile.name,
    text,
    createdAt: serverTimestamp()
  });
  input.value = "";
  loadComments(postId, block); // refresh thread
}

/** Detach the realtime listener (call on logout to avoid leaks). */
export function teardownWall() {
  if (unsubscribePosts) unsubscribePosts();
}
