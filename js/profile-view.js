// ============================================================
// PROFILE-VIEW.JS — shared "view someone else's profile" modal.
// Used from the Student Wall (tapping a post author) and the
// Classmate Directory (tapping a directory row). Respects each
// student's own privacy choices — a hidden phone number never
// renders a working Call button.
// ============================================================
import { auth } from "./firebase-config.js";
import { fetchProfile } from "./auth.js";
import { openModal, escapeHtml, getCachedProfile, cacheUserProfile, avatarInner, nameWithBadge, isAdminEmail } from "./ui-utils.js";

/** Open the read-only profile modal for the given uid (fetches + caches if needed). */
export async function openUserProfileModal(uid) {
  if (!uid) return;

  // Own profile? Just point people to "My Profile" instead of a duplicate view.
  if (auth.currentUser && uid === auth.currentUser.uid) {
    document.querySelector('.nav-item[data-route="profile"]')?.click();
    return;
  }

  openModal(`<div class="profile-modal-loading"><span class="btn-spinner dark"></span> Loading profile…</div>`);

  let profile = getCachedProfile(uid);
  if (!profile) {
    try {
      profile = await fetchProfile(uid);
      if (profile) cacheUserProfile(uid, profile);
    } catch (err) {
      openModal(`<p class="empty-state">Couldn't load this profile.</p>`);
      return;
    }
  }
  if (!profile) {
    openModal(`<p class="empty-state">This student's profile couldn't be found.</p>`);
    return;
  }
  renderProfileModal(profile);
}

function renderProfileModal(profile) {
  const rows = [];
  if (profile.roll) rows.push(["Roll / Reg. No.", escapeHtml(profile.roll)]);
  if (profile.year) rows.push(["Year", escapeHtml(profile.year)]);
  if (profile.bloodGroup) rows.push(["Blood Group", escapeHtml(profile.bloodGroup)]);
  if (profile.session) rows.push(["Session / Batch", escapeHtml(profile.session)]);
  if (profile.hometown) rows.push(["Hometown", escapeHtml(profile.hometown)]);
  if (profile.address) rows.push(["Present Address", escapeHtml(profile.address)]);
  if (profile.socialLink) rows.push(["Social / Facebook", `<a href="${escapeHtml(profile.socialLink)}" target="_blank" rel="noopener">Visit</a>`]);
  rows.push(["Email", profile.hideEmail ? `<span class="hidden-field">Hidden by user</span>` : escapeHtml(profile.email || "—")]);

  const phoneRow = profile.hidePhone || !profile.phone
    ? `<div class="pv-detail-row"><span>Phone</span><span class="hidden-field">${profile.phone ? "Hidden by user" : "Not set"}</span></div>`
    : `<div class="pv-detail-row"><span>Phone</span><span>${escapeHtml(profile.phone)}</span></div>`;

  openModal(`
    <div class="profile-view-modal">
      <div class="pv-header">
        <div class="avatar avatar-lg pv-avatar">${avatarInner(profile)}</div>
        <h3>${nameWithBadge(profile.name || "Classmate", profile.email)}</h3>
        ${isAdminEmail(profile.email) ? `<div class="profile-admin-note">Admin</div>` : ""}
        ${profile.session ? `<div class="pv-sub">${escapeHtml(profile.session)}</div>` : ""}
      </div>
      ${profile.bio ? `<p class="pv-bio">${escapeHtml(profile.bio)}</p>` : ""}
      <div class="pv-details">
        ${rows.map(([label, val]) => `<div class="pv-detail-row"><span>${label}</span><span>${val}</span></div>`).join("")}
        ${phoneRow}
      </div>
      ${(!profile.hidePhone && profile.phone) ? `<a class="btn-primary full" href="tel:${escapeHtml(profile.phone)}">Call ${escapeHtml((profile.name || "").split(" ")[0] || "")}</a>` : `<p class="pv-call-disabled">This student has hidden their contact number.</p>`}
    </div>
  `);
}
