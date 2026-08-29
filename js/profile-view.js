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
  isAdminEmail, fullDate, showToast, resetScrollForTabs
} from "./ui-utils.js";
import { loadUserResources } from "./resources.js";
import { renderPost } from "./wall.js";

const cardEl = document.getElementById("user-profile-card");
const backBtn = document.getElementById("user-profile-back-btn");

// app.js hands us its router (goToRoute) so this page participates in the
// normal section/back-button history exactly like the 5 main sections do.
let goToRouteRef = null;
export function registerProfilePageRouter(goToRoute) { goToRouteRef = goToRoute; }

backBtn?.addEventListener("click", () => history.back());

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

  if (goToRouteRef) goToRouteRef("user-profile", { fromPopstate, replace, state: { profileUid: uid } });
  cardEl.innerHTML = `<div class="profile-modal-loading"><span class="btn-spinner dark"></span> Loading profile…</div>`;

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
        <button type="button" class="profile-tab-btn active" data-tab="info">Info</button>
        <button type="button" class="profile-tab-btn" data-tab="posts">Posts</button>
        <button type="button" class="profile-tab-btn" data-tab="notes">Notes</button>
      </div>

      <div class="profile-tab-panel active" data-tab-panel="info">
        <div class="profile-flow-details">
          ${rows.map(([label, val]) => `<div class="profile-detail-row"><span>${label}</span><span>${val}</span></div>`).join("")}
        </div>
        <div class="profile-flow-actions">
          ${(!profile.hidePhone && profile.phone)
            ? `<a class="btn-primary full" href="tel:${escapeHtml(profile.phone)}">Call ${escapeHtml((profile.name || "").split(" ")[0] || "")}</a>`
            : `<p class="pv-call-disabled">This student has hidden their contact number.</p>`}
        </div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="posts">
        <div id="user-profile-posts-list"><p class="empty-state">Loading posts…</p></div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="notes">
        <div id="user-profile-notes-list"><p class="empty-state">Loading notes…</p></div>
      </div>
    </div>
  `;

  const tabBtns = cardEl.querySelectorAll(".profile-tab-btn");
  const tabPanels = cardEl.querySelectorAll(".profile-tab-panel");
  const tabsEl = cardEl.querySelector(".profile-tabs");
  let postsLoaded = false;
  let notesLoaded = false;
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.toggle("active", b === btn));
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
    showToast("Couldn't load posts: " + err.message);
  }
}
