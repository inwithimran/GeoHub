import { auth, db, COLLEGE_NAME } from "./firebase-config.js";
import { collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { fetchProfile } from "./auth.js";
import {
  escapeHtml, escapeAttr, getCachedProfile, cacheUserProfile, avatarInner, nameWithBadge,
  isAdminEmail, adminBadgeHtml, fullDate, showToast, friendlyError, confirmDialog, wireKebabMenus
} from "./ui-utils.js";
import { loadUserResources } from "./resources.js";
import { renderPost } from "./wall.js";
import { avatarPresenceDotHtml } from "./presence.js";
import { openDmThread, getBlockState, setDmBlocked } from "./messages.js";

const cardEl = document.getElementById("user-profile-card");

let goToRouteRef = null;
export function registerProfilePageRouter(goToRoute) { goToRouteRef = goToRoute; }

let currentUid = null;
export function getOpenProfileUid() {
  return currentUid;
}
export function teardownProfilePage() {
  currentUid = null;
}

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
  if (profile.socialLink) rows.push(["Social / Facebook", `<a href="${escapeAttr(profile.socialLink)}" target="_blank" rel="noopener">Visit</a>`]);
  rows.push(["Email", profile.hideEmail ? `<span class="hidden-field-tag">Hidden</span>` : escapeHtml(profile.email || "—")]);
  rows.push(["Phone", (profile.hidePhone || !profile.phone) ? `<span class="hidden-field-tag">${profile.phone ? "Hidden" : "Not set"}</span>` : escapeHtml(profile.phone)]);
  rows.push(["College", escapeHtml(COLLEGE_NAME)]);
  const joined = fullDate(profile.createdAt);
  if (joined) rows.push(["Joined GeoHub", joined]);

  const topbarTitle = document.getElementById("topbar-title");
  if (topbarTitle) topbarTitle.textContent = profile.name || "Classmate Profile";

  cardEl.innerHTML = `
    <div class="profile-flow">
      <div class="profile-flow-banner" aria-hidden="true"></div>
      <div class="profile-flow-head">
        <div class="profile-flow-avatar-wrap">
          <span class="avatar avatar-lg profile-flow-avatar">${avatarInner(profile)}</span>
          ${avatarPresenceDotHtml(uid, { label: true })}
        </div>
        <h3>${nameWithBadge(profile.name || "Classmate", profile.email)}</h3>
        <div class="profile-meta-row">
          ${profile.session ? `<span class="profile-meta-chip chip-session">${escapeHtml(profile.session)}</span>` : ""}
          ${admin ? `<span class="profile-meta-chip chip-admin" title="Admin · can post notices to the whole department">${adminBadgeHtml()} Admin</span>` : ""}
        </div>
      </div>
      ${profile.bio ? `<p class="profile-own-bio">${escapeHtml(profile.bio)}</p>` : ""}
      <div class="profile-stat-row">
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.roll || "—")}</strong><span>Roll No.</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.bloodGroup || "—")}</strong><span>Blood Grp</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(profile.year || profile.session || "—")}</strong><span>Year</span></div>
      </div>

      <!-- Facebook-style action row: Message is the one wide primary
           button, Call (when this classmate hasn't hidden their number)
           and "more" (Block/Unblock) are small round icon buttons beside
           it — sits right under the stats, above the tabs, instead of
           buried at the bottom of the Info tab. -->
      <div class="profile-action-row">
        <button type="button" id="user-profile-message-btn" class="profile-action-primary">
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H8l-4.5 4V6.5a1 1 0 0 1 1-1z"/></svg>
          Message
        </button>
        ${(!profile.hidePhone && profile.phone) ? `
        <a class="profile-action-icon-btn" href="tel:${escapeAttr(profile.phone)}" aria-label="Call ${escapeAttr((profile.name || "").split(" ")[0] || "")}">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
        </a>` : ""}
        <div class="kebab-menu profile-more-menu" id="user-profile-more-menu">
          <button type="button" class="kebab-btn" aria-label="More options" aria-haspopup="true">
            <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><circle cx="12" cy="5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="19" r="1.9"/></svg>
          </button>
          <div class="kebab-dropdown hidden">
            <button type="button" class="kebab-item danger" id="user-profile-block-item" data-kebab-action="block">Block this classmate</button>
          </div>
        </div>
      </div>
      ${(!profile.hidePhone && profile.phone) ? "" : `<p class="pv-call-disabled">This student has hidden their contact number.</p>`}

      <div class="profile-tabs" role="tablist">
        <button type="button" class="profile-tab-btn active" data-tab="info" role="tab" id="user-profile-tab-info" aria-selected="true" aria-controls="user-profile-panel-info">Info</button>
        <button type="button" class="profile-tab-btn" data-tab="posts" role="tab" id="user-profile-tab-posts" aria-selected="false" aria-controls="user-profile-panel-posts" tabindex="-1">Posts</button>
        <button type="button" class="profile-tab-btn" data-tab="notes" role="tab" id="user-profile-tab-notes" aria-selected="false" aria-controls="user-profile-panel-notes" tabindex="-1">Notes</button>
      </div>

      <div class="profile-tab-panel active" data-tab-panel="info" role="tabpanel" id="user-profile-panel-info" aria-labelledby="user-profile-tab-info">
        <div class="profile-flow-details">
          ${rows.map(([label, val]) => `<div class="profile-detail-row"><span>${label}</span><span>${val}</span></div>`).join("")}
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

  const moreMenu = cardEl.querySelector("#user-profile-more-menu");
  const blockItem = cardEl.querySelector("#user-profile-block-item");
  if (moreMenu && blockItem) {
    getBlockState(uid).then(({ blockedByMe }) => {
      if (cardEl.querySelector("#user-profile-block-item") !== blockItem) return; 
      blockItem.textContent = blockedByMe ? "Unblock this classmate" : "Block this classmate";
      blockItem.classList.toggle("danger", !blockedByMe);
      blockItem.dataset.blocked = blockedByMe ? "1" : "0";
      moreMenu.classList.toggle("is-blocking", blockedByMe);
    });
    wireKebabMenus(cardEl, {
      block: () => {
        const alreadyBlocked = blockItem.dataset.blocked === "1";
        if (alreadyBlocked) {
          setDmBlocked(uid, false)
            .then(() => {
              blockItem.textContent = "Block this classmate";
              blockItem.classList.add("danger");
              blockItem.dataset.blocked = "0";
              moreMenu.classList.remove("is-blocking");
            })
            .catch((err) => {
              const { message, technical } = friendlyError(err, "Couldn't unblock this classmate.");
              showToast(message, { details: technical });
            });
          return;
        }
        confirmDialog({
          title: "Block this classmate?",
          text: `${profile.name || "This classmate"} won't be able to send you messages until you unblock them.`,
          confirmLabel: "Block",
          onConfirm: () => setDmBlocked(uid, true).then(() => {
            blockItem.textContent = "Unblock this classmate";
            blockItem.classList.remove("danger");
            blockItem.dataset.blocked = "1";
            moreMenu.classList.add("is-blocking");
          })
        });
      }
    });
  }

  const tabBtns = cardEl.querySelectorAll(".profile-tab-btn");
  const tabPanels = cardEl.querySelectorAll(".profile-tab-panel");
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

    listEl.innerHTML = `<div class="flat-list feed-list"></div>`;
    const innerListEl = listEl.querySelector(".feed-list");
    posts.forEach(post => renderPost(post.id, post, innerListEl, { onChanged: () => loadUserPosts(uid, listEl) }));
  } catch (err) {
    listEl.innerHTML = `<p class="empty-state">Couldn't load posts.</p>`;
    const { message, technical } = friendlyError(err, "Couldn't load posts.");
    showToast(message, { details: technical });
  }
}
