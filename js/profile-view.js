// ============================================================
// PROFILE-VIEW.JS — a classmate's profile as a full drill-down
// page (its own route, pushed to browser history — never a
// modal), used from the Student Wall (tapping a post/comment
// author) and the Classmate Directory (tapping a directory row).
// Also exports loadUserPosts(), shared with "My Profile" in
// app.js so both the student's own profile and a classmate's
// profile show the same Info / Posts tabbed layout.
// Respects each student's own privacy choices — a hidden phone
// number never renders a working Call button.
// ============================================================
import { auth, db, COLLEGE_NAME } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { fetchProfile } from "./auth.js";
import {
  escapeHtml, getCachedProfile, cacheUserProfile, avatarInner, nameWithBadge,
  isAdminEmail, fullDate, showToast, resetScrollForTabs, friendlyError
} from "./ui-utils.js";
import { loadUserResources } from "./resources.js";
import { renderPost } from "./wall.js";
import { presenceTextHtml } from "./presence.js";
import { openDmThread } from "./messages.js";

const cardEl = document.getElementById("user-profile-card");

// app.js hands us its router (goToRoute) so this page participates in the
// normal section/back-button history exactly like the 5 main sections do.
// (The page's own Back button now lives in the shared app bar —
// #topbar-back-btn in app.js — rather than on this page.)
let goToRouteRef = null;
export function registerProfilePageRouter(goToRoute) { goToRouteRef = goToRoute; }

let currentUid = null;
/** The uid currently open on this page (null if the page isn't open). Lets app.js's
 *  popstate handler tell "closing a modal that was sitting on top of this page" apart
 *  from "actually navigating to a different classmate's profile", so it only reloads
 *  for the latter. */
export function getOpenProfileUid() {
  return currentUid;
}
/** Call whenever navigating away from this page (mirrors teardownPostDetail()). */
export function teardownProfilePage() {
  currentUid = null;
}

/** Skeleton placeholder shown while a profile page's data is being fetched
 *  (first open, or a cache miss) — mirrors the shape of the real card below
 *  so nothing "jumps" once the content swaps in. */
function profileSkeletonHtml() {
  const row = () => `<div class="skeleton-line sk-90" style="height:13px"></div>`;
  return `
    <div class="profile-flow" aria-hidden="true">
      <div class="skeleton-post" style="text-align:center">
        <div class="skeleton-avatar" style="width:74px;height:74px;margin:0 auto 14px"></div>
        <div class="skeleton-line sk-40" style="height:14px;margin:0 auto 8px"></div>
        <div class="skeleton-line sk-25" style="height:10px;margin:0 auto"></div>
      </div>
      <div class="skeleton-post" style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
        ${row()}${row()}${row()}${row()}
      </div>
    </div>`;
}

/**
 * Open the full-page profile view for the given uid. Own profile routes to
 * "My Profile" instead of duplicating it here. Pass { replace: true } when
 * navigating here right after closing a modal (e.g. from a "Liked by" list)
 * so this page's history entry replaces the modal's instead of racing it —
 * see the { keepHistory } note on closeModal() in ui-utils.js.
 */
export async function openUserProfilePage(uid, { fromPopstate = false, replace = false } = {}) {
  if (!uid) return;

  if (auth.currentUser && uid === auth.currentUser.uid) {
    document.querySelector('.nav-item[data-route="profile"]')?.click();
    return;
  }

  currentUid = uid;
  if (goToRouteRef) goToRouteRef("user-profile", { fromPopstate, replace, state: { profileUid: uid } });
  cardEl.innerHTML = profileSkeletonHtml();

  let profile = getCachedProfile(uid);
  if (!profile) {
    try {
      profile = await fetchProfile(uid);
      if (profile) cacheUserProfile(uid, profile);
    } catch (err) {
      cardEl.innerHTML = `<p class="empty-state">Couldn't load this profile.</p>`;
      return;
    }
  }
  if (!profile) {
    cardEl.innerHTML = `<p class="empty-state">This student's profile couldn't be found.</p>`;
    return;
  }
  renderProfilePage(profile, uid);
}

function renderProfilePage(profile, uid) {
  const admin = isAdminEmail(profile.email);

  const rows = [];
  if (profile.roll) rows.push(["Roll / Reg. No.", escapeHtml(profile.roll)]);
  if (profile.year) rows.push(["Year", escapeHtml(profile.year)]);
  if (profile.bloodGroup) rows.push(["Blood Group", escapeHtml(profile.bloodGroup)]);
  rows.push(["Gender", profile.gender ? escapeHtml(profile.gender[0].toUpperCase() + profile.gender.slice(1)) : "Not set"]);
  if (profile.session) rows.push(["Session / Batch", escapeHtml(profile.session)]);
  if (profile.hometown) rows.push(["Hometown", escapeHtml(profile.hometown)]);
  if (profile.address) rows.push(["Present Address", escapeHtml(profile.address)]);
  if (profile.socialLink) rows.push(["Social / Facebook", `<a href="${escapeHtml(profile.socialLink)}" target="_blank" rel="noopener">Visit</a>`]);
  rows.push(["Email", profile.hideEmail ? `<span class="hidden-field-tag">Hidden</span>` : escapeHtml(profile.email || "—")]);
  rows.push(["Phone", (profile.hidePhone || !profile.phone) ? `<span class="hidden-field-tag">${profile.phone ? "Hidden" : "Not set"}</span>` : escapeHtml(profile.phone)]);
  rows.push(["College", escapeHtml(COLLEGE_NAME)]);
  const joined = fullDate(profile.createdAt);
  if (joined) rows.push(["Joined GeoHub", joined]);

  // Update the top bar to name the classmate being viewed, now that we know who they are.
  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = profile.name || "Classmate Profile";

  cardEl.innerHTML = `
    <div class="profile-flow">
      <div class="profile-flow-banner" aria-hidden="true"></div>
      <div class="profile-flow-head">
        <div class="profile-flow-avatar-wrap">
          <span class="avatar avatar-lg profile-flow-avatar">${avatarInner(profile)}</span>
        </div>
        <h3>${nameWithBadge(profile.name || "Classmate", profile.email)}</h3>
        ${presenceTextHtml(uid, "presence-text profile-flow-presence")}
        ${profile.session ? `<div class="profile-role">${escapeHtml(profile.session)}</div>` : ""}
        ${admin ? `<div class="profile-admin-note">Admin</div>` : ""}
      </div>
      ${profile.bio ? `<p class="pv-bio profile-own-bio">${escapeHtml(profile.bio)}</p>` : ""}
      <div class="profile-stat-row">
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.roll || "—")}</strong><span>Roll No.</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.bloodGroup || "—")}</strong><span>Blood Grp</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.year || profile.session || "—")}</strong><span>Year</span></div>
      </div>

      <div class="profile-tabs" role="tablist">
        <button type="button" class="profile-tab-btn active" data-tab="info" role="tab" id="user-profile-tab-info" aria-selected="true" aria-controls="user-profile-panel-info">Info</button>
        <button type="button" class="profile-tab-btn" data-tab="posts" role="tab" id="user-profile-tab-posts" aria-selected="false" aria-controls="user-profile-panel-posts" tabindex="-1">Posts</button>
        <button type="button" class="profile-tab-btn" data-tab="notes" role="tab" id="user-profile-tab-notes" aria-selected="false" aria-controls="user-profile-panel-notes" tabindex="-1">Notes</button>
      </div>

      <div class="profile-tab-panel active" data-tab-panel="info" role="tabpanel" id="user-profile-panel-info" aria-labelledby="user-profile-tab-info">
        <div class="profile-flow-details">
          ${rows.map(([label, val]) => `<div class="profile-detail-row"><span>${label}</span><span>${val}</span></div>`).join("")}
        </div>
        <div class="profile-flow-actions" style="display:flex; gap:10px;">
          ${(!profile.hidePhone && profile.phone)
            ? `<a class="btn-primary full" href="tel:${escapeHtml(profile.phone)}">Call ${escapeHtml((profile.name || "").split(" ")[0] || "")}</a>`
            : `<p class="pv-call-disabled" style="flex:1">This student has hidden their contact number.</p>`}
          <button type="button" id="user-profile-message-btn" class="btn-outline full msg-btn">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H8l-4.5 4V6.5a1 1 0 0 1 1-1z"/></svg>
            Message
          </button>
        </div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="posts" role="tabpanel" id="user-profile-panel-posts" aria-labelledby="user-profile-tab-posts">
        <div id="user-profile-posts-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="notes" role="tabpanel" id="user-profile-panel-notes" aria-labelledby="user-profile-tab-notes">
        <div id="user-profile-notes-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>
    </div>
  `;

  cardEl.querySelector("#user-profile-message-btn")?.addEventListener("click", () => openDmThread(uid));

  const tabBtns = cardEl.querySelectorAll(".profile-tab-btn");
  const tabPanels = cardEl.querySelectorAll(".profile-tab-panel");
  const tabsEl = cardEl.querySelector(".profile-tabs");
  let postsLoaded = false;
  let notesLoaded = false;
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
        b.tabIndex = active ? 0 : -1;
      });
      tabPanels.forEach(panel => panel.classList.toggle("active", panel.dataset.tabPanel === btn.dataset.tab));
      resetScrollForTabs(tabsEl); // each tab starts at its own top, instead of inheriting the previous tab's scroll position
      if (btn.dataset.tab === "posts" && !postsLoaded) {
        postsLoaded = true;
        loadUserPosts(uid, cardEl.querySelector("#user-profile-posts-list"));
      }
      if (btn.dataset.tab === "notes" && !notesLoaded) {
        notesLoaded = true;
        loadUserResources(uid, cardEl.querySelector("#user-profile-notes-list"));
      }
    });
  });
}

// ============================================================
// POSTS TAB — every post this student has written to the Student
// Wall, newest first. Shared by both "My Profile" (app.js) and a
// classmate's profile page above, so it only needs to be written
// (and kept in sync with the Wall's post shape) in one place.
// ============================================================
export async function loadUserPosts(uid, listEl) {
  if (!listEl) return;
  try {
    const q = query(collection(db, "posts"), where("authorUid", "==", uid));
    const snap = await getDocs(q);

    if (snap.empty) {
      listEl.innerHTML = `<p class="empty-state">No posts yet.</p>`;
      return;
    }

    const posts = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.createdAt?.toDate?.().getTime() || 0) - (a.createdAt?.toDate?.().getTime() || 0));

    // Reuse the exact same card renderer as the Student Wall itself, so a
    // profile's Posts tab gets full like / comment / "who liked this"
    // interactivity instead of a static read-only summary.
    listEl.innerHTML = `<div class="flat-list feed-list"></div>`;
    const innerListEl = listEl.querySelector(".feed-list");
    posts.forEach(post => renderPost(post.id, post, innerListEl, { onChanged: () => loadUserPosts(uid, listEl) }));
  } catch (err) {
    listEl.innerHTML = `<p class="empty-state">Couldn't load posts.</p>`;
    const { message, technical } = friendlyError(err, "Couldn't load posts.");
    showToast(message, { details: technical });
  }
}
