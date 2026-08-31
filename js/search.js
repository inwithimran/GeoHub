// ============================================================
// SEARCH.JS — Global Search (topbar search icon -> its own page).
// Searches Wall posts, Notes & Sheet Hub resources, the Notice Board,
// and the Deadline tracker all from one search bar, including
// "#hashtag" search over Wall posts.
//
// Firestore has no built-in full-text search, and this app is a single
// department's worth of data (dozens/hundreds of docs, not millions) —
// so rather than standing up a separate search service, each of the
// four collections is fetched once (capped, newest-first) the first
// time the Search page is opened, cached in memory, and then every
// keystroke just re-filters that in-memory list. That keeps typing
// instant with zero extra Firestore reads per keystroke, at the cost
// of very-old content (beyond the cap) not being searchable — an
// acceptable trade-off for how this app is actually used (finding
// something from recent weeks, not archaeology).
// ============================================================
import { db, auth } from "./firebase-config.js";
import { collection, getDocs, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { escapeHtml, timeAgo, showToast, skeletonRowsHtml } from "./ui-utils.js";

const FETCH_CAP = 300; // per collection

const input = document.getElementById("global-search-input");
const resultsEl = document.getElementById("global-search-results");

let goToRouteRef = null;
export function registerSearchRouter(goToRoute) { goToRouteRef = goToRoute; }

let dataLoaded = false;
let loading = false;
let posts = [];
let resources = [];
let notices = [];
let deadlines = [];
let debounceTimer = null;

export function initGlobalSearch() {
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";
  input.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runSearch, 200);
  });
}

/** Called by app.js's router right before showing the Search page — lazy-loads the searchable data on first visit only. */
export function ensureSearchDataLoaded() {
  if (dataLoaded || loading || !auth.currentUser) return;
  loading = true;
  resultsEl.innerHTML = skeletonRowsHtml(3);
  Promise.all([
    getDocs(query(collection(db, "posts"), orderBy("createdAt", "desc"), limit(FETCH_CAP))),
    getDocs(query(collection(db, "resources"), orderBy("createdAt", "desc"), limit(FETCH_CAP))),
    getDocs(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(FETCH_CAP))),
    getDocs(query(collection(db, "deadlines"), orderBy("dueAt", "desc"), limit(FETCH_CAP)))
  ]).then(([postsSnap, resSnap, noticeSnap, dlSnap]) => {
    posts = postsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    resources = resSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    notices = noticeSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    deadlines = dlSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    dataLoaded = true;
    loading = false;
    renderPlaceholderOrResults();
  }).catch((err) => {
    loading = false;
    resultsEl.innerHTML = `<p class="empty-state">Couldn't load search data. Pull to refresh and try again.</p>`;
    console.warn("Global search: couldn't load data:", err.message);
  });
}

function renderPlaceholderOrResults() {
  if (!input.value.trim()) {
    resultsEl.innerHTML = `<p class="empty-state">Search across the Student Wall, Notes &amp; Sheets, and Notice Board.</p>`;
    return;
  }
  runSearch();
}

function truncate(text = "", max = 100) {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function runSearch() {
  if (!dataLoaded) return; // still loading — ensureSearchDataLoaded()'s .then() will call this once ready
  const raw = input.value.trim();
  if (!raw) { resultsEl.innerHTML = `<p class="empty-state">Search across the Student Wall, Notes &amp; Sheets, and Notice Board.</p>`; return; }

  const isHashtag = raw.startsWith("#");
  const q = (isHashtag ? raw.slice(1) : raw).toLowerCase().trim();
  if (!q) { resultsEl.innerHTML = `<p class="empty-state">Search across the Student Wall, Notes &amp; Sheets, and Notice Board.</p>`; return; }

  const matchedPosts = posts.filter(p =>
    isHashtag
      ? (p.hashtags || []).some(h => h.toLowerCase() === q)
      : (p.text || "").toLowerCase().includes(q) || (p.hashtags || []).some(h => h.toLowerCase().includes(q))
  ).slice(0, 25);

  const matchedResources = isHashtag ? [] : resources.filter(r =>
    (r.title || "").toLowerCase().includes(q) || (r.category || "").toLowerCase().includes(q)
  ).slice(0, 25);

  const matchedNotices = isHashtag ? [] : notices.filter(n =>
    (n.text || "").toLowerCase().includes(q)
  ).slice(0, 25);

  const matchedDeadlines = isHashtag ? [] : deadlines.filter(d =>
    (d.title || "").toLowerCase().includes(q) || (d.course || "").toLowerCase().includes(q) || (d.notes || "").toLowerCase().includes(q)
  ).slice(0, 25);

  const totalCount = matchedPosts.length + matchedResources.length + matchedNotices.length + matchedDeadlines.length;
  if (!totalCount) {
    resultsEl.innerHTML = `<p class="empty-state">No results found for “${escapeHtml(raw)}”.</p>`;
    return;
  }

  let html = "";
  if (matchedPosts.length) {
    html += `<div class="search-result-section-title">Wall Posts</div>`;
    html += matchedPosts.map(p => `
      <div class="search-result-row" data-kind="post" data-id="${p.id}">
        <div class="search-result-icon">📝</div>
        <div class="search-result-info">
          <strong>${escapeHtml(p.authorName || "Someone")}</strong>
          <small>${escapeHtml(truncate(p.text || ""))} · ${timeAgo(p.createdAt)}</small>
        </div>
      </div>`).join("");
  }
  if (matchedResources.length) {
    html += `<div class="search-result-section-title">Notes &amp; Sheets</div>`;
    html += matchedResources.map(r => `
      <div class="search-result-row" data-kind="resource" data-id="${r.id}">
        <div class="search-result-icon">📁</div>
        <div class="search-result-info">
          <strong class="search-result-title-full">${escapeHtml(r.title)}</strong>
          <small>${escapeHtml(r.category || "")} · Shared by ${escapeHtml(r.contributorName || "a classmate")}</small>
        </div>
      </div>`).join("");
  }
  if (matchedNotices.length) {
    html += `<div class="search-result-section-title">Notice Board</div>`;
    html += matchedNotices.map(n => `
      <div class="search-result-row" data-kind="notice" data-id="${n.id}">
        <div class="search-result-icon">📢</div>
        <div class="search-result-info">
          <strong>${escapeHtml(truncate(n.text || "", 60))}</strong>
          <small>${timeAgo(n.createdAt)}</small>
        </div>
      </div>`).join("");
  }
  if (matchedDeadlines.length) {
    html += `<div class="search-result-section-title">Deadlines</div>`;
    html += matchedDeadlines.map(d => `
      <div class="search-result-row" data-kind="deadline" data-id="${d.id}">
        <div class="search-result-icon">🗓️</div>
        <div class="search-result-info">
          <strong>${escapeHtml(d.title)}</strong>
          <small>${escapeHtml(d.type || "")}${d.course ? " · " + escapeHtml(d.course) : ""}</small>
        </div>
      </div>`).join("");
  }
  resultsEl.innerHTML = html;

  resultsEl.querySelectorAll(".search-result-row").forEach(row => {
    row.addEventListener("click", () => openResult(row.dataset.kind, row.dataset.id));
  });
}

async function openResult(kind, id) {
  switch (kind) {
    case "post": {
      const { openPostDetailPage } = await import("./post-detail.js");
      openPostDetailPage(id);
      break;
    }
    case "resource": {
      const { focusResource } = await import("./resources.js");
      if (goToRouteRef) goToRouteRef("resources");
      focusResource(id);
      break;
    }
    case "notice": {
      const { openNoticeById } = await import("./routine.js");
      if (goToRouteRef) goToRouteRef("notices");
      openNoticeById(id);
      break;
    }
    case "deadline": {
      const { focusDeadline } = await import("./deadlines.js");
      if (goToRouteRef) goToRouteRef("routine");
      focusDeadline(id);
      break;
    }
    default:
      showToast("Couldn't open that result.");
  }
}
