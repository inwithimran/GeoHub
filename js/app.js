// ============================================================
// APP.JS — Entry point.
// Wires up the auth screen, watches login state, swaps between
// the auth screen and the app shell, and handles SPA routing
// between the 5 sections via the sidebar / bottom nav.
// ============================================================
import { DEPARTMENT_NAME, COLLEGE_NAME, auth } from "./firebase-config.js";
import {
  signUp, logIn, logOut, watchAuthState, friendlyAuthError, currentProfile,
  signInWithGoogle, updateProfileDetails, nameChangeStatus
} from "./auth.js";
import {
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initWall, teardownWall } from "./wall.js";
import { initResources, teardownResources, loadUserResources } from "./resources.js";
import { initDirectory, teardownDirectory } from "./directory.js";
import { initRoutine, teardownRoutine, registerNotificationsRouter } from "./routine.js";
import { openUserProfilePage, loadUserPosts, registerProfilePageRouter, getOpenProfileUid, teardownProfilePage } from "./profile-view.js";
import { openPostDetailPage, registerPostDetailRouter, teardownPostDetail, getOpenPostId } from "./post-detail.js";
import {
  escapeHtml, openModal, closeModal, showToast, setBtnLoading, fullDate,
  avatarInner, nameWithBadge, isAdminEmail, resetScrollForTabs
} from "./ui-utils.js";
import { uploadImage } from "./cloudinary.js";
import { isAcceptableImageFile } from "./media-picker.js";
import { openImageCropper } from "./image-cropper.js";
import { initPush, unregisterPushToken } from "./push.js";
import { getThemePreference, setThemePreference, initTheme } from "./theme.js";

// The inline script at the top of index.html's <head> already painted
// the right theme before first paint (avoiding a flash) — this just
// starts the "System" preference following the OS live from here on.
initTheme();

// ---------- Element references ----------
const loadingScreen = document.getElementById("loading-screen");
const loadingLabel = document.getElementById("loading-label");
const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");

// ============================================================
// OFFLINE BANNER — a dropped connection used to only show up as
// scattered "Couldn't load…" toasts from whichever listener happened
// to fail first, which didn't make the actual cause obvious. This
// listens for the browser's own online/offline signal and shows one
// clear top banner instead, independent of login state (it also
// applies while the auth screen is up). Firestore's realtime
// listeners reconnect and re-sync on their own once the connection
// returns, so there's nothing to re-fetch manually here — the banner
// is purely a status indicator.
// ============================================================
const offlineBanner = document.getElementById("offline-banner");
function updateOfflineBanner() {
  offlineBanner.classList.toggle("show", !navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner(); // reflect the real state immediately on load, not just on the next change

/** Swap the loading-screen's message ("Loading GeoHub" / "Logging out"). */
function setLoadingLabel(text) {
  if (loadingLabel) loadingLabel.textContent = text;
}

/** How long the loading overlay stays up before it's allowed to dismiss. */
const LOADING_MIN_DISPLAY_MS = 700;

/**
 * Bring the loading overlay up. Shown INSTANTLY (transition disabled for a
 * beat, then re-enabled) so it fully covers the screen before anything
 * underneath it changes — otherwise the CSS fade-in lets the just-swapped
 * screen (home page / login page) flash through the translucent overlay
 * for a moment before it becomes opaque.
 */
function showLoadingScreen(text) {
  setLoadingLabel(text);
  loadingScreen.classList.add("no-transition");
  loadingScreen.classList.remove("hidden");
  void loadingScreen.offsetWidth; // force a reflow so the instant show is applied first
  loadingScreen.classList.remove("no-transition");
}

/** Dismiss the loading overlay — this one IS animated (a smooth fade-out). */
function hideLoadingScreen() {
  loadingScreen.classList.add("hidden");
}

// True while a user-initiated logout is in flight, so the auth-state
// listener knows to show the "Logging out" transition instead of
// instantly snapping to the login screen.
let loggingOut = false;

const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const authTabsWrap = document.getElementById("auth-tabs");
const authTabButtons = authTabsWrap.querySelectorAll(".auth-tab");
// Both the real tabs AND the "New here? / Already a member?" text links switch forms
const allTabTriggers = document.querySelectorAll("[data-tab]");

let featuresInitialized = false; // guards against re-subscribing on hot reload / re-login

// ============================================================
// AUTH SCREEN — tab switching + form submission
// ============================================================
function switchAuthTab(target) {
  const isLogin = target === "login";
  authTabButtons.forEach(t => t.classList.toggle("active", t.dataset.tab === target));
  authTabsWrap.classList.toggle("signup-active", !isLogin);
  loginForm.classList.toggle("hidden", !isLogin);
  signupForm.classList.toggle("hidden", isLogin);
  document.getElementById("login-error").textContent = "";
  document.getElementById("signup-error").textContent = "";
}
allTabTriggers.forEach(el => el.addEventListener("click", () => switchAuthTab(el.dataset.tab)));

// ============================================================
// AUTH GATE — the home/landing state of the auth screen shows
// only two entry buttons (Google / Email & Password), never a
// bare form. Picking the email option reveals the form section;
// Back returns to the gate.
// ============================================================
const authGate = document.getElementById("auth-gate");
const authFormSection = document.getElementById("auth-form-section");
const authCardHead = document.getElementById("auth-card-head");
const openEmailFormBtn = document.getElementById("open-email-form-btn");
const openSignupGateBtn = document.getElementById("open-signup-gate-btn");
const authBackBtn = document.getElementById("auth-back-btn");

/** Show the gate (two entry buttons) and hide the form section. */
function showAuthGate() {
  authFormSection.classList.add("hidden");
  authGate.classList.remove("hidden");
  if (authCardHead) authCardHead.querySelector("small").textContent = "Log in, or create your student account";
}

/** Reveal the email/password form section on a given tab, hiding the gate. */
function showAuthFormSection(tab) {
  switchAuthTab(tab);
  authGate.classList.add("hidden");
  authFormSection.classList.remove("hidden");
  if (authCardHead) authCardHead.querySelector("small").textContent = tab === "signup" ? "Create your student account" : "Log in to your account";
}

openEmailFormBtn.addEventListener("click", () => showAuthFormSection("login"));
openSignupGateBtn.addEventListener("click", () => showAuthFormSection("signup"));
authBackBtn.addEventListener("click", showAuthGate);

// ============================================================
// PASSWORD SHOW / HIDE — works for every ".pw-toggle" button
// (login password field, signup password field, etc.)
// ============================================================
document.querySelectorAll(".pw-toggle").forEach(btn => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.input);
    if (!input) return;
    const revealing = input.type === "password";
    input.type = revealing ? "text" : "password";
    btn.querySelector(".eye-on").style.display = revealing ? "none" : "block";
    btn.querySelector(".eye-off").style.display = revealing ? "block" : "none";
    btn.setAttribute("aria-label", revealing ? "Hide password" : "Show password");
  });
});

// ============================================================
// GOOGLE SIGN-IN — available from both the Log In and Sign Up
// tabs; Firebase figures out on its own whether this is a
// returning student or a brand-new one.
// ============================================================
async function handleGoogleSignIn(btn) {
  const errorEl = document.getElementById("google-auth-error");
  if (errorEl) errorEl.textContent = "";
  setBtnLoading(btn, true, "Connecting to Google…");
  try {
    await signInWithGoogle();
    // no need to restore the button — a successful sign-in swaps the whole screen
  } catch (err) {
    const msg = friendlyAuthError(err);
    if (errorEl) errorEl.textContent = msg;
    else showToast(msg);
    setBtnLoading(btn, false);
  }
}
document.querySelectorAll("#google-signin-btn, .google-signin-trigger").forEach(btn => {
  btn.addEventListener("click", () => handleGoogleSignIn(btn));
});

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  const submitBtn = loginForm.querySelector('button[type="submit"]');
  errorEl.textContent = "";
  setBtnLoading(submitBtn, true, "Logging in…");
  try {
    await logIn(
      document.getElementById("login-email").value.trim(),
      document.getElementById("login-password").value
    );
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
    setBtnLoading(submitBtn, false);
  }
});

/** A slightly-stronger-than-Firebase-default password rule: 8+ chars, at least one letter and one number. */
function passwordStrengthError(password) {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(password)) return "Password must include at least one letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  return null;
}

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("signup-error");
  const submitBtn = signupForm.querySelector('button[type="submit"]');
  errorEl.textContent = "";

  const password = document.getElementById("signup-password").value;
  const pwError = passwordStrengthError(password);
  if (pwError) { errorEl.textContent = pwError; return; }

  setBtnLoading(submitBtn, true, "Creating account…");
  try {
    await signUp({
      name: document.getElementById("signup-name").value,
      roll: document.getElementById("signup-roll").value,
      blood: document.getElementById("signup-blood").value,
      gender: document.getElementById("signup-gender").value,
      phone: document.getElementById("signup-phone").value,
      email: document.getElementById("signup-email").value,
      password
    });
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
    setBtnLoading(submitBtn, false);
  }
});

// ============================================================
// ROUTING — one active <section class="route-section"> at a time
// ============================================================
const routeTitles = {
  wall: "Student Wall",
  resources: "Notes & Sheet Hub",
  directory: "Classmate Directory",
  routine: "Weekly Routine",
  profile: "My Profile",
  notices: "Notices & Notifications",
  settings: "Settings",
  "user-profile": "Profile", // overwritten with the classmate's name once loaded
  "post-detail": "Post" // overwritten with "<name>'s Post" once loaded
};

let currentRoute = "wall";

// Each of the 5 bottom-nav tabs (plus Notices/Settings) shares one page-level
// scroll container (see .content's CSS), so switching between them used to
// always snap back to the top — annoying if you were scrolled deep into the
// Wall and just wanted to check Notices for a second. This remembers each
// route's own scrollY and restores it on the way back, so every tab keeps
// its own independent scroll position, like it had its own scroll container.
// Post Detail / a classmate's Profile are excluded — those are drill-down
// pages opened fresh each time (from a tap), not persistent tabs, so they
// intentionally always open at the top.
const SCROLL_MEMORY_EXCLUDED_ROUTES = new Set(["post-detail", "user-profile"]);
let scrollPositions = {}; // route -> last scrollY

// ============================================================
// ROUTE <-> BACK BUTTON — every section change pushes a history
// entry (replaced, not pushed, for the very first section after
// login), so the device/browser back button steps back through
// previously visited sections instead of leaving the app.
// `fromPopstate` is true when we're reacting to the back button
// itself, so we don't push a new entry for a navigation that's
// already a "back". `state` carries any extra data (e.g. which
// classmate's profile page is open) alongside the route itself.
// ============================================================
function goToRoute(route, { fromPopstate = false, replace = false, state = {} } = {}) {
  if (!routeTitles[route]) return;
  // Remember exactly where we're scrolled to on the tab we're leaving,
  // before its section gets hidden, so coming back restores it.
  if (currentRoute !== route && !SCROLL_MEMORY_EXCLUDED_ROUTES.has(currentRoute)) {
    scrollPositions[currentRoute] = window.scrollY;
  }
  document.querySelectorAll(".route-section").forEach(sec => {
    sec.classList.toggle("hidden", sec.id !== `section-${route}`);
  });
  document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });
  document.getElementById("topbar-title").textContent = routeTitles[route] || "GeoHub";
  document.getElementById("topbar-subtitle").textContent = route === "user-profile" ? "Classmate Profile" : route === "settings" ? "App preferences & account" : "Geography & Environment";

  if (route === "profile") renderProfile();
  if (route === "settings") renderSettingsPage();
  // Post Detail and a classmate's Profile are opened fresh each time (a new
  // post or a different classmate is a brand-new page underneath the same
  // route name), so they always start at the top. Every other route restores
  // wherever it was last left — see the scrollPositions comment above.
  const restoreY = SCROLL_MEMORY_EXCLUDED_ROUTES.has(route) ? 0 : (scrollPositions[route] || 0);
  window.scrollTo({ top: restoreY, behavior: "auto" });
  // NOTE: opening the Notices & Notifications page (or either of its tabs)
  // deliberately does NOT clear the bell/tab badges anymore — only reading
  // (or deleting) the specific notice/notification behind the count does,
  // via markNoticeRead()/markActivityRead() inside routine.js.
  // Leaving the Post Detail page — drop its live post/comments listeners
  // rather than leaving them subscribed in the background.
  if (currentRoute === "post-detail" && route !== "post-detail") teardownPostDetail();
  if (currentRoute === "user-profile" && route !== "user-profile") teardownProfilePage();

  currentRoute = route;
  const historyState = { geohubRoute: route, ...state };
  if (replace) {
    history.replaceState(historyState, "");
  } else if (!fromPopstate && (route !== history.state?.geohubRoute || route === "user-profile" || route === "post-detail")) {
    history.pushState(historyState, "");
  }
}
registerProfilePageRouter(goToRoute);
registerNotificationsRouter(goToRoute);
registerPostDetailRouter(goToRoute);

document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.route !== currentRoute) goToRoute(btn.dataset.route);
  });
});
document.getElementById("topbar-notif-btn").addEventListener("click", () => {
  if (currentRoute !== "notices") goToRoute("notices");
});
document.getElementById("topbar-settings-btn").addEventListener("click", () => {
  if (currentRoute !== "settings") goToRoute("settings");
});

// Device/browser back button: step back to whichever section is recorded
// in that history entry (a modal's own popstate handling, in ui-utils.js,
// runs independently and takes care of closing an open modal first).
//
// A closed modal pops its own history entry, which fires this same
// popstate — even though nothing about the page underneath actually
// changed. Re-running openPostDetailPage()/openUserProfilePage()/goToRoute()
// for that case used to reset scroll position and re-fetch/re-render the
// whole page from scratch (e.g. every time a comment's delete-confirm modal
// closed), which is jarring. So: if the state we're landing on is the exact
// route+entity already on screen, this popstate is just a modal closing —
// leave the page alone.
window.addEventListener("popstate", (e) => {
  if (appShell.classList.contains("hidden")) return; // not logged in — nothing to route
  if (e.state && e.state.geohubRoute) {
    if (e.state.geohubRoute === "user-profile" && e.state.profileUid) {
      if (e.state.geohubRoute === currentRoute && e.state.profileUid === getOpenProfileUid()) return;
      openUserProfilePage(e.state.profileUid, { fromPopstate: true });
    } else if (e.state.geohubRoute === "post-detail" && e.state.postId) {
      if (e.state.geohubRoute === currentRoute && e.state.postId === getOpenPostId()) return;
      openPostDetailPage(e.state.postId, { fromPopstate: true });
    } else {
      if (e.state.geohubRoute === currentRoute) return;
      goToRoute(e.state.geohubRoute, { fromPopstate: true });
    }
  }
});

// ============================================================
// LOGOUT — both the desktop sidebar button and the mobile profile
// button go through a confirmation sheet first, so a stray tap
// never signs someone out by accident.
// ============================================================
function confirmLogout() {
  openModal(`
    <div class="confirm-modal">
      <div class="confirm-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
      </div>
      <h3>Log out of GeoHub?</h3>
      <p class="confirm-text">You'll need to log back in with your email and password (or Google) to access the department wall again.</p>
      <div class="confirm-actions">
        <button type="button" class="btn-outline full" id="logout-cancel-btn">Cancel</button>
        <button type="button" class="btn-primary full danger-solid" id="logout-confirm-btn">Log Out</button>
      </div>
    </div>
  `);
  const cancelBtn = document.getElementById("logout-cancel-btn");
  const confirmBtn = document.getElementById("logout-confirm-btn");
  cancelBtn.addEventListener("click", closeModal);
  confirmBtn.addEventListener("click", async () => {
    setBtnLoading(confirmBtn, true, "Logging out…");
    cancelBtn.disabled = true;
    loggingOut = true;
    try {
      await unregisterPushToken();
      await logOut();
      closeModal();
    } catch (err) {
      loggingOut = false;
      setBtnLoading(confirmBtn, false);
      cancelBtn.disabled = false;
      showToast("Couldn't log out. Please try again.");
    }
  });
}
document.getElementById("logout-btn-desktop").addEventListener("click", confirmLogout);
document.getElementById("logout-btn-settings").addEventListener("click", confirmLogout);

// ============================================================
// PROFILE SECTION — card-free, flowing layout for the logged-in student
// ============================================================
function renderProfile() {
  if (!currentProfile) return;
  const joined = fullDate(currentProfile.createdAt);
  const p = currentProfile;
  const admin = isAdminEmail(p.email);

  const rows = [
    ["Roll / Reg. No.", escapeHtml(p.roll || "Not set")],
    ["Year", escapeHtml(p.year || "Not set")],
    ["Session / Batch", escapeHtml(p.session || "Not set")],
    ["Blood Group", escapeHtml(p.bloodGroup || "Not set")],
    ["Gender", p.gender ? escapeHtml(p.gender[0].toUpperCase() + p.gender.slice(1)) : "Not set"],
    ["Hometown", escapeHtml(p.hometown || "Not set")],
    ["Present Address", escapeHtml(p.address || "Not set")],
    ["Phone", `${escapeHtml(p.phone || "Not set")}${p.hidePhone ? ' <span class="hidden-field-tag">Hidden</span>' : ""}`],
    ["Email", `${escapeHtml(p.email)}${p.hideEmail ? ' <span class="hidden-field-tag">Hidden</span>' : ""}`],
    ["Social / Facebook", p.socialLink ? `<a href="${escapeHtml(p.socialLink)}" target="_blank" rel="noopener">${escapeHtml(p.socialLink)}</a>` : "Not set"],
    ["College", escapeHtml(COLLEGE_NAME)]
  ];
  if (joined) rows.push(["Joined GeoHub", joined]);

  document.getElementById("profile-card").innerHTML = `
    <div class="profile-flow">
      <div class="profile-flow-banner" aria-hidden="true"></div>
      <div class="profile-flow-head">
        <div class="profile-flow-avatar-wrap">
          <span class="avatar avatar-lg profile-flow-avatar">${avatarInner(p)}</span>
          <button type="button" id="profile-edit-fab" class="profile-edit-fab" aria-label="Edit profile">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          </button>
        </div>
        <h3>${nameWithBadge(p.name, p.email)}</h3>
        <div class="profile-role">${escapeHtml(DEPARTMENT_NAME)}</div>
        ${admin ? `<div class="profile-admin-note">Admin · can post notices to the whole department</div>` : ""}
      </div>
      ${p.bio ? `<p class="pv-bio profile-own-bio">${escapeHtml(p.bio)}</p>` : ""}
      <div class="profile-stat-row">
        <div class="profile-stat-chip"><strong>${escapeHtml(p.roll || "—")}</strong><span>Roll No.</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(p.bloodGroup || "—")}</strong><span>Blood Grp</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(p.year || p.session || "—")}</strong><span>Year</span></div>
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
      </div>

      <div class="profile-tab-panel" data-tab-panel="posts">
        <div id="own-profile-posts-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="notes">
        <div id="own-profile-notes-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>
    </div>
  `;
  // The pencil FAB on the avatar is the one and only "edit profile" entry
  // point on this page now (the Settings page also links here) — there
  // used to be a second, redundant "Edit Profile & Privacy" button at the
  // bottom of the Info tab.
  document.getElementById("profile-edit-fab").addEventListener("click", () => openProfileDetailsModal(false));

  const profileCardEl = document.getElementById("profile-card");
  const tabBtns = profileCardEl.querySelectorAll(".profile-tab-btn");
  const tabPanels = profileCardEl.querySelectorAll(".profile-tab-panel");
  const tabsEl = profileCardEl.querySelector(".profile-tabs");
  let ownPostsLoaded = false;
  let ownNotesLoaded = false;
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => b.classList.toggle("active", b === btn));
      tabPanels.forEach(panel => panel.classList.toggle("active", panel.dataset.tabPanel === btn.dataset.tab));
      resetScrollForTabs(tabsEl); // each tab starts at its own top, instead of inheriting the previous tab's scroll position
      if (btn.dataset.tab === "posts" && !ownPostsLoaded) {
        ownPostsLoaded = true;
        loadUserPosts(p.uid, document.getElementById("own-profile-posts-list"));
      }
      if (btn.dataset.tab === "notes" && !ownNotesLoaded) {
        ownNotesLoaded = true;
        loadUserResources(p.uid, document.getElementById("own-profile-notes-list"));
      }
    });
  });
}

// ============================================================
// SETTINGS PAGE — reached via the gear icon next to the header
// bell. A handful of real, working settings (not placeholders):
// jump-off points to Edit Profile & Privacy and a password reset
// email, a push-notifications toggle, an About blurb, and Log Out
// as the very last thing on the page.
// ============================================================
function renderSettingsPage() {
  const pushToggle = document.getElementById("settings-push-toggle");
  const pushStatus = document.getElementById("settings-push-status");
  const resetPwBtn = document.getElementById("settings-reset-password-btn");

  document.getElementById("settings-edit-profile-btn").onclick = () => openProfileDetailsModal(false);

  // Appearance — System / Light / Dark. Reflects whatever's actually
  // stored (defaulting to "system" the first time someone opens this).
  const themeToggle = document.getElementById("settings-theme-toggle");
  const themeStatus = document.getElementById("settings-theme-status");
  const themeStatusText = {
    system: "Matches your device",
    light: "Always light",
    dark: "Always dark"
  };
  const paintThemeToggle = (pref) => {
    themeToggle.querySelectorAll("button").forEach(b => b.classList.toggle("active", b.dataset.themeChoice === pref));
    themeStatus.textContent = themeStatusText[pref];
  };
  paintThemeToggle(getThemePreference());
  themeToggle.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      setThemePreference(btn.dataset.themeChoice);
      paintThemeToggle(btn.dataset.themeChoice);
    };
  });

  // Password reset only makes sense for an email/password account — a
  // Google-only sign-in has no GeoHub password to reset.
  const hasPasswordProvider = !!auth.currentUser?.providerData?.some(p => p.providerId === "password");
  resetPwBtn.classList.toggle("hidden", !hasPasswordProvider);
  resetPwBtn.onclick = async () => {
    const email = auth.currentUser?.email;
    if (!email) return;
    setBtnLoading(resetPwBtn, true, "Sending…");
    try {
      await sendPasswordResetEmail(auth, email);
      showToast(`Password reset link sent to ${email}.`);
    } catch (err) {
      showToast("Couldn't send reset email: " + err.message);
    } finally {
      setBtnLoading(resetPwBtn, false);
    }
  };

  // Push notifications — reflects real browser support/permission rather
  // than an arbitrary in-app flag, so the switch never lies about whether
  // notifications will actually arrive.
  const pushSupported = ("Notification" in window) && ("serviceWorker" in navigator);
  if (!pushSupported) {
    pushToggle.disabled = true;
    pushToggle.checked = false;
    pushStatus.textContent = "Not supported in this browser.";
  } else if (Notification.permission === "denied") {
    pushToggle.disabled = true;
    pushToggle.checked = false;
    pushStatus.textContent = "Blocked in your browser's site settings.";
  } else {
    pushToggle.disabled = false;
    pushToggle.checked = Notification.permission === "granted";
    pushStatus.textContent = pushToggle.checked
      ? "You'll be notified about posts, likes & comments."
      : "Get notified about posts, likes & comments.";
  }
  pushToggle.onchange = async () => {
    if (pushToggle.checked) {
      await initPush({ requestPermission: true });
      const granted = Notification.permission === "granted";
      pushToggle.checked = granted;
      pushStatus.textContent = granted
        ? "You'll be notified about posts, likes & comments."
        : "Get notified about posts, likes & comments.";
      if (!granted) showToast("Notifications permission wasn't granted.");
    } else {
      pushToggle.disabled = true;
      await unregisterPushToken();
      pushToggle.disabled = false;
      pushStatus.textContent = "Get notified about posts, likes & comments.";
      showToast("This device won't receive push notifications anymore.");
    }
  };
}

// ============================================================
// COMPLETE / EDIT PROFILE DETAILS — used right after a first-time
// Google sign-in (roll/blood/phone are unknown) and later from the
// "Edit" button on My Profile.
// ============================================================
function openProfileDetailsModal(isFirstTime = false) {
  // First-time completion (right after a Google sign-in) is mandatory —
  // no close button, and it can't be dismissed until it's saved.
  // A brand-new profile has never changed its name before (nameChangedAt
  // is null), so this is always editable during first-time completion.
  const nameStatus = isFirstTime ? { canChange: true, daysRemaining: 0 } : nameChangeStatus();
  openModal(`
    <h3>${isFirstTime ? "Finish setting up your profile" : "Edit your details"}</h3>
    ${isFirstTime ? `<p class="modal-hint">Welcome to GeoHub! We just need a few more details so classmates can find you in the directory.</p>` : ""}

    <div class="pd-photo-picker">
      <div class="pd-photo-avatar-wrap">
        <div class="avatar avatar-lg pd-photo-preview" id="pd-photo-preview">${avatarInner(currentProfile)}</div>
        <button type="button" class="pd-photo-camera-btn" id="pd-photo-btn" aria-label="Change photo">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4"/></svg>
        </button>
      </div>
      <small class="pd-photo-hint">Tap to change your photo — you'll be able to move &amp; zoom it to fit.</small>
      <input type="file" id="pd-photo-input" accept="image/*" class="hidden" />
    </div>

    <label class="field">
      <span>Full Name</span>
      <input type="text" id="pd-name" placeholder="Your full name" value="${escapeHtml(currentProfile.name || "")}" ${nameStatus.canChange ? "" : "disabled"} />
      <small class="pd-name-hint">${nameStatus.canChange
        ? "You can change your name once every 7 days."
        : `You've already changed your name recently — you can change it again in ${nameStatus.daysRemaining} day${nameStatus.daysRemaining === 1 ? "" : "s"}.`}</small>
    </label>
    <label class="field">
      <span>Roll / Registration No.</span>
      <input type="text" id="pd-roll" placeholder="e.g. 2024-GEO-014" value="${escapeHtml(currentProfile.roll || "")}" />
    </label>
    <label class="field">
      <span>Blood Group</span>
      <select id="pd-blood">
        <option value="" ${!currentProfile.bloodGroup ? "selected" : ""} disabled>Select blood group</option>
        ${["A+","A-","B+","B-","AB+","AB-","O+","O-"].map(bg =>
          `<option ${currentProfile.bloodGroup === bg ? "selected" : ""}>${bg}</option>`).join("")}
      </select>
    </label>
    <label class="field">
      <span>Gender</span>
      <select id="pd-gender">
        <option value="" ${!currentProfile.gender ? "selected" : ""} disabled>Select gender</option>
        <option value="male" ${currentProfile.gender === "male" ? "selected" : ""}>Male</option>
        <option value="female" ${currentProfile.gender === "female" ? "selected" : ""}>Female</option>
        <option value="other" ${currentProfile.gender === "other" ? "selected" : ""}>Others</option>
      </select>
    </label>
    <label class="field">
      <span>Phone Number</span>
      <input type="tel" id="pd-phone" placeholder="e.g. 01XXXXXXXXX" value="${escapeHtml(currentProfile.phone || "")}" />
    </label>
    <label class="field">
      <span>Year</span>
      <select id="pd-year">
        <option value="" ${!currentProfile.year ? "selected" : ""}>Select year</option>
        ${["1st Year", "2nd Year", "3rd Year", "4th Year", "Honours Completed"].map(y =>
          `<option ${currentProfile.year === y ? "selected" : ""}>${y}</option>`).join("")}
      </select>
    </label>
    <label class="field">
      <span>Session / Batch</span>
      <input type="text" id="pd-session" placeholder="e.g. 2024–25" value="${escapeHtml(currentProfile.session || "")}" />
    </label>
    <label class="field">
      <span>Hometown</span>
      <input type="text" id="pd-hometown" placeholder="e.g. Jessore" value="${escapeHtml(currentProfile.hometown || "")}" />
    </label>
    <label class="field">
      <span>Present Address</span>
      <input type="text" id="pd-address" placeholder="e.g. Hostel / Mess address" value="${escapeHtml(currentProfile.address || "")}" />
    </label>
    <label class="field">
      <span>Social / Facebook Link</span>
      <input type="url" id="pd-social" placeholder="https://facebook.com/…" value="${escapeHtml(currentProfile.socialLink || "")}" />
    </label>
    <label class="field">
      <span>About / Bio</span>
      <input type="text" id="pd-bio" placeholder="A short line about yourself" value="${escapeHtml(currentProfile.bio || "")}" />
    </label>

    <div class="privacy-block">
      <div class="privacy-block-title">Privacy</div>
      <label class="switch-row">
        <span>Hide my phone number from classmates<br><small>Hiding it also removes the “Call” button on your profile.</small></span>
        <input type="checkbox" id="pd-hide-phone" ${currentProfile.hidePhone ? "checked" : ""} />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>
      <label class="switch-row">
        <span>Hide my email from classmates</span>
        <input type="checkbox" id="pd-hide-email" ${currentProfile.hideEmail ? "checked" : ""} />
        <span class="switch-track"><span class="switch-thumb"></span></span>
      </label>
    </div>

    <p id="pd-error" class="form-error"></p>
    <button type="button" class="btn-primary full" id="pd-save-btn">Save Details</button>
  `, { closable: !isFirstTime });

  // ---------- Photo picker: pick -> instant local preview -> uploaded only on Save ----------
  let selectedPhotoFile = null;
  const photoInput = document.getElementById("pd-photo-input");
  const photoPreview = document.getElementById("pd-photo-preview");
  document.getElementById("pd-photo-btn").addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file) return;
    if (!isAcceptableImageFile(file)) return;
    const cropped = await openImageCropper(file); // move/zoom to a 1:1 crop before it's ever uploaded
    if (!cropped) return; // user cancelled — keep whatever photo was showing
    selectedPhotoFile = new File([cropped], "avatar.jpg", { type: "image/jpeg" });
    photoPreview.innerHTML = `<span class="avatar-fill"><img src="${URL.createObjectURL(cropped)}" alt="" /></span>`;
  });

  document.getElementById("pd-save-btn").addEventListener("click", () => saveProfileDetails(isFirstTime, () => selectedPhotoFile));
}

async function saveProfileDetails(isFirstTime, getSelectedPhotoFile) {
  const btn = document.getElementById("pd-save-btn");
  const nameInput = document.getElementById("pd-name");
  const name = nameInput.disabled ? currentProfile.name : nameInput.value.trim();
  const roll = document.getElementById("pd-roll").value.trim();
  const blood = document.getElementById("pd-blood").value;
  const gender = document.getElementById("pd-gender").value;
  const phone = document.getElementById("pd-phone").value.trim();
  const year = document.getElementById("pd-year").value;
  const session = document.getElementById("pd-session").value;
  const hometown = document.getElementById("pd-hometown").value;
  const address = document.getElementById("pd-address").value;
  const socialLink = document.getElementById("pd-social").value;
  const bio = document.getElementById("pd-bio").value;
  const hidePhone = document.getElementById("pd-hide-phone").checked;
  const hideEmail = document.getElementById("pd-hide-email").checked;
  const errorEl = document.getElementById("pd-error");

  if (!name || !roll || !blood || !phone || !gender) {
    errorEl.textContent = "Please fill in name, roll, blood group, gender and phone.";
    return;
  }
  errorEl.textContent = "";
  setBtnLoading(btn, true, "Saving…");
  try {
    const selectedPhotoFile = getSelectedPhotoFile ? getSelectedPhotoFile() : null;
    let photoURL;
    if (selectedPhotoFile) {
      setBtnLoading(btn, true, "Uploading photo…");
      photoURL = await uploadImage(selectedPhotoFile, { maxDim: 600, quality: 0.85, folder: "geohub/avatars" });
      setBtnLoading(btn, true, "Saving…");
    }
    await updateProfileDetails({ name, roll, blood, gender, phone, year, session, hometown, address, socialLink, bio, hidePhone, hideEmail, photoURL });
    closeModal({ force: true }); // needed for the mandatory first-time flow, harmless otherwise
    showToast(isFirstTime ? "Profile complete — welcome aboard!" : "Profile updated.");
    if (!document.getElementById("section-profile").classList.contains("hidden")) renderProfile();
  } catch (err) {
    errorEl.textContent = err.message && err.message.startsWith("You can change your name again")
      ? err.message
      : "Couldn't save your details. Please try again.";
    setBtnLoading(btn, false);
  }
}

// ============================================================
// PWA — register the service worker on every visit (not just once
// push is enabled) so GeoHub is installable and caches its app
// shell for offline/instant repeat loads. Idempotent: push.js
// re-registers the same script later to attach FCM, which just
// reuses this registration.
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => {});
  });
}

// ============================================================
// AUTH STATE — the single switch between auth-screen and app-shell
// ============================================================
watchAuthState(
  (user, profile) => {
    // Bring the loading overlay back up (it may already be hidden from a
    // previous screen) and swap the screens right away, but keep the
    // overlay up for a beat longer so the jump from the auth screen into
    // the Wall feels like one deliberate transition instead of an abrupt cut.
    showLoadingScreen("Loading GeoHub");
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");

    const displayProfile = profile || { name: user.email, email: user.email };
    const composerAvatar = document.getElementById("composer-avatar");
    if (composerAvatar) composerAvatar.innerHTML = avatarInner(displayProfile);

    if (!featuresInitialized) {
      initWall();
      initResources();
      initDirectory();
      initRoutine();
      featuresInitialized = true;
    }
    goToRoute("wall", { replace: true });
    initPush(); // best-effort: registers this device for background push notifications

    // First-time Google sign-ins land without roll/blood/phone — ask for them once.
    if (profile && profile.profileIncomplete) {
      openProfileDetailsModal(true);
    }

    setTimeout(hideLoadingScreen, LOADING_MIN_DISPLAY_MS);
  },
  () => {
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");
    // Clear the app's route history so a re-login starts a fresh back-stack
    // instead of carrying over section entries from the previous session.
    history.replaceState({ geohubAuthScreen: true }, "");
    scrollPositions = {}; // next login's tabs each start fresh, not at this session's scroll spots
    currentRoute = "wall";

    if (featuresInitialized) {
      teardownWall();
      teardownResources();
      teardownDirectory();
      teardownRoutine();
      teardownPostDetail();
      featuresInitialized = false;
    }
    // Reset auth forms (and any stuck loading buttons) for the next login
    showAuthGate();
    loginForm.reset();
    signupForm.reset();
    setBtnLoading(loginForm.querySelector('button[type="submit"]'), false);
    setBtnLoading(signupForm.querySelector('button[type="submit"]'), false);
    document.querySelectorAll("#google-signin-btn, .google-signin-trigger").forEach(btn => setBtnLoading(btn, false));

    if (loggingOut) {
      // A user-initiated logout: keep the "Logging out" overlay up for a
      // beat so it reads as a deliberate transition, mirroring the login flow.
      showLoadingScreen("Logging out");
      setTimeout(() => {
        hideLoadingScreen();
        setLoadingLabel("Loading GeoHub");
        loggingOut = false;
      }, LOADING_MIN_DISPLAY_MS);
    } else {
      // First page load with no existing session — the overlay is already
      // showing from startup, so just dismiss it right away.
      hideLoadingScreen();
    }
  }
);
