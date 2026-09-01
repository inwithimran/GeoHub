import { DEPARTMENT_NAME, COLLEGE_NAME, auth, resetCacheOnColdStart, markSessionEstablished } from "./firebase-config.js";
import {
  signUp, logIn, logOut, watchAuthState, friendlyAuthError, currentProfile,
  signInWithGoogle, updateProfileDetails, nameChangeStatus
} from "./auth.js";
import {
  sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { initWall, teardownWall } from "./wall.js";
import { initWriteQueueSync } from "./write-queue.js";
import { initResources, teardownResources, loadUserResources } from "./resources.js";
import { initDirectory, teardownDirectory } from "./directory.js";
import { initRoutine, teardownRoutine, registerNotificationsRouter } from "./routine.js";
import { initDeadlines, teardownDeadlines } from "./deadlines.js";
import { initGlobalSearch, ensureSearchDataLoaded, registerSearchRouter } from "./search.js";
import { initPresence, teardownPresence } from "./presence.js";
import { initMessages, teardownMessages, registerDmThreadRouter, openDmThread, getOpenDmUid, teardownDmThread, isClassChatSubtabActive } from "./messages.js";
import { openUserProfilePage, loadUserPosts, registerProfilePageRouter, getOpenProfileUid, teardownProfilePage } from "./profile-view.js";
import { openPostDetailPage, registerPostDetailRouter, teardownPostDetail, getOpenPostId } from "./post-detail.js";
import {
  escapeHtml, openModal, closeModal, showToast, setBtnLoading, fullDate,
  avatarInner, nameWithBadge, isAdminEmail, adminBadgeHtml, friendlyError
} from "./ui-utils.js";
import { uploadImage } from "./cloudinary.js";
import { isAcceptableImageFile, openImageViewer } from "./media-picker.js";
import { openImageCropper } from "./image-cropper.js";
import { initPush, unregisterPushToken } from "./push.js";
import { getThemePreference, setThemePreference, initTheme } from "./theme.js";

initTheme();

if ("scrollRestoration" in history) history.scrollRestoration = "manual";

const loadingScreen = document.getElementById("loading-screen");
const loadingLabel = document.getElementById("loading-label");
const loadingBarFill = document.querySelector(".loading-bar-fill");
const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");

let loadingProgress = 0;
function setLoadingProgress(pct) {
  loadingProgress = Math.max(loadingProgress, pct);
  if (loadingBarFill) loadingBarFill.style.width = loadingProgress + "%";
}
function resetLoadingProgress() {
  loadingProgress = 0;
  if (loadingBarFill) {
    loadingBarFill.style.transition = "none";
    loadingBarFill.style.width = "6%";
    void loadingBarFill.offsetWidth; 
    loadingBarFill.style.transition = "";
    loadingProgress = 6;
  }
}
resetLoadingProgress();
setLoadingProgress(15); 
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => setLoadingProgress(35), { once: true });
} else {
  setLoadingProgress(35);
}
if (document.readyState === "complete") {
  setLoadingProgress(60); 
} else {
  window.addEventListener("load", () => setLoadingProgress(60), { once: true });
}

const offlineBanner = document.getElementById("offline-banner");
function updateOfflineBanner() {
  offlineBanner.classList.toggle("show", !navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);
updateOfflineBanner(); 
function setLoadingLabel(text) {
  if (loadingLabel) loadingLabel.textContent = text;
}

const LOADING_MIN_DISPLAY_MS = 300;

function showLoadingScreen(text) {
  if (loadingScreen.classList.contains("hidden")) resetLoadingProgress();
  setLoadingLabel(text);
  loadingScreen.classList.add("no-transition");
  loadingScreen.classList.remove("hidden");
  void loadingScreen.offsetWidth;
  loadingScreen.classList.remove("no-transition");
}

function hideLoadingScreen() {
  loadingScreen.classList.add("hidden");
}

let loggingOut = false;

const loginForm = document.getElementById("login-form");
const signupForm = document.getElementById("signup-form");
const authTabsWrap = document.getElementById("auth-tabs");
const authTabButtons = authTabsWrap.querySelectorAll(".auth-tab");
const allTabTriggers = document.querySelectorAll("[data-tab]");

let featuresInitialized = false;

let isColdStart = false;

function waitForTrustedSnapshot(initFn, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(false); }
    }, timeoutMs);
    initFn((snap) => {
      if (settled) return;
      if (!isColdStart || snap.metadata.fromCache === false) {
        settled = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

const authCardHead = document.getElementById("auth-card-head");

function switchAuthTab(target) {
  const isLogin = target === "login";
  authTabButtons.forEach(t => {
    const active = t.dataset.tab === target;
    t.classList.toggle("active", active);
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
  });
  authTabsWrap.classList.toggle("signup-active", !isLogin);
  loginForm.classList.toggle("hidden", !isLogin);
  signupForm.classList.toggle("hidden", isLogin);
  document.getElementById("login-error").textContent = "";
  document.getElementById("signup-error").textContent = "";
  if (authCardHead) authCardHead.querySelector("small").textContent = isLogin ? "Log in to your account" : "Create your student account";
}
allTabTriggers.forEach(el => el.addEventListener("click", () => switchAuthTab(el.dataset.tab)));

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

async function handleGoogleSignIn(btn) {
  const errorEl = document.getElementById("google-auth-error");
  if (errorEl) errorEl.textContent = "";
  setBtnLoading(btn, true, "Connecting to Google…");
  try {
    await signInWithGoogle();
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

const forgotPasswordBtn = document.getElementById("forgot-password-btn");
forgotPasswordBtn.addEventListener("click", async () => {
  const errorEl = document.getElementById("login-error");
  const emailInput = document.getElementById("login-email");
  const email = emailInput.value.trim();
  errorEl.textContent = "";
  if (!email) {
    errorEl.textContent = "Enter your email above first, then tap \u201cForgot password?\u201d.";
    emailInput.focus();
    return;
  }
  setBtnLoading(forgotPasswordBtn, true, "Sending…");
  try {
    await sendPasswordResetEmail(auth, email);
    showToast(`Password reset link sent to ${email}.`);
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
  } finally {
    setBtnLoading(forgotPasswordBtn, false);
  }
});

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

const routeTitles = {
  wall: "Student Wall",
  resources: "Notes & Sheet Hub",
  message: "Messages",
  directory: "Classmate Directory",
  routine: "Weekly Routine",
  profile: "My Profile",
  notices: "Notices & Notifications",
  reports: "Reported Posts",
  search: "Search",
  settings: "Settings",
  "user-profile": "Profile",
  "post-detail": "Post", 
  "dm-thread": "Private Message"
};

let currentRoute = "wall";

let routeFromMap = {};

const TOPBAR_BACK_ROUTES = new Set(["search", "user-profile", "post-detail", "notices", "reports", "settings"]);
const FROM_TRACKED_ROUTES = new Set([...TOPBAR_BACK_ROUTES, "dm-thread"]);

function buildHash(route, id, from) {
  const params = new URLSearchParams();
  if (id) params.set("id", id);
  if (from) params.set("from", from);
  const qs = params.toString();
  return qs ? `#${route}?${qs}` : `#${route}`;
}
function parseHash(hash) {
  if (!hash || hash === "#") return null;
  const [route, qs] = hash.replace(/^#/, "").split("?");
  if (!route) return null;
  const params = new URLSearchParams(qs || "");
  return { route, id: params.get("id") || null, from: params.get("from") || null };
}

const SCROLL_MEMORY_EXCLUDED_ROUTES = new Set(["post-detail", "user-profile", "dm-thread"]);
let scrollPositions = {};

function goToRoute(route, { fromPopstate = false, replace = false, state = {} } = {}) {
  if (!routeTitles[route]) return;
  const trackFrom = FROM_TRACKED_ROUTES.has(route);
  let from = null;
  if (trackFrom) {
    if (state.from) from = state.from;
    else if (fromPopstate || route === currentRoute) from = parseHash(location.hash)?.from || null;
    else from = currentRoute;
    routeFromMap[route] = from;
  }
  const id = state.profileUid || state.postId || state.dmUid || null;
  if (currentRoute !== route && !SCROLL_MEMORY_EXCLUDED_ROUTES.has(currentRoute)) {
    scrollPositions[currentRoute] = window.scrollY;
  }
  document.querySelectorAll(".route-section").forEach(sec => {
    sec.classList.toggle("hidden", sec.id !== `section-${route}`);
  });
  document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
    const active = btn.dataset.route === route;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page"); else btn.removeAttribute("aria-current");
  });
  document.getElementById("app-shell")?.classList.toggle("chat-mode", route === "dm-thread" || (route === "message" && isClassChatSubtabActive()));
  document.getElementById("topbar-title").textContent = routeTitles[route] || "GeoHub";
  document.getElementById("topbar-subtitle").textContent = route === "user-profile" ? "Classmate Profile" : route === "dm-thread" ? "Private Message" : route === "settings" ? "App preferences & account" : route === "reports" ? "Admin only" : "Geography & Environment";
  const showTopbarBack = TOPBAR_BACK_ROUTES.has(route);
  document.getElementById("topbar-back-btn")?.classList.toggle("hidden", !showTopbarBack);
  document.getElementById("topbar-left")?.classList.toggle("has-back", showTopbarBack);

  if (route === "profile") renderProfile();
  if (route === "settings") renderSettingsPage();
  if (route === "search") ensureSearchDataLoaded();
  const restoreY = SCROLL_MEMORY_EXCLUDED_ROUTES.has(route) ? 0 : (scrollPositions[route] || 0);
  window.scrollTo({ top: restoreY, behavior: "auto" });
  if (currentRoute === "post-detail" && route !== "post-detail") teardownPostDetail();
  if (currentRoute === "user-profile" && route !== "user-profile") teardownProfilePage();
  if (currentRoute === "dm-thread" && route !== "dm-thread") teardownDmThread();

  currentRoute = route;
  const historyState = { geohubRoute: route, ...state, from };
  const hash = buildHash(route, id, from);
  if (replace) {
    history.replaceState(historyState, "", hash);
  } else if (!fromPopstate && (route !== history.state?.geohubRoute || route === "user-profile" || route === "post-detail")) {
    history.pushState(historyState, "", hash);
  }
}
function goBackToRoute(route) {
  if (!route || !routeTitles[route]) { history.back(); return; }
  goToRoute(route, { state: { from: routeFromMap[route] } });
}
registerProfilePageRouter(goToRoute);
registerNotificationsRouter(goToRoute);
registerPostDetailRouter(goToRoute);
registerDmThreadRouter(goToRoute, goBackToRoute);
registerSearchRouter(goToRoute);

function restoreRouteFromHash() {
  const parsed = parseHash(location.hash);
  if (!parsed || !routeTitles[parsed.route]) {
    goToRoute("wall", { replace: true });
    return;
  }
  if (parsed.route === "user-profile" && parsed.id) openUserProfilePage(parsed.id, { replace: true });
  else if (parsed.route === "post-detail" && parsed.id) openPostDetailPage(parsed.id, { replace: true });
  else if (parsed.route === "dm-thread" && parsed.id) openDmThread(parsed.id, { replace: true });
  else goToRoute(parsed.route, { replace: true });
}

document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.dataset.route !== currentRoute) goToRoute(btn.dataset.route);
  });
});
document.getElementById("topbar-notif-btn").addEventListener("click", () => {
  if (currentRoute !== "notices") goToRoute("notices");
});
document.getElementById("topbar-search-btn").addEventListener("click", () => {
  if (currentRoute !== "search") goToRoute("search");
});
document.getElementById("topbar-settings-btn").addEventListener("click", () => {
  if (currentRoute !== "settings") goToRoute("settings");
});
document.getElementById("topbar-back-btn")?.addEventListener("click", () => {
  const from = history.state?.from || parseHash(location.hash)?.from;
  if (from && routeTitles[from]) goBackToRoute(from);
  else history.back();
});

window.addEventListener("popstate", (e) => {
  if (appShell.classList.contains("hidden")) return;
  if (e.state && e.state.geohubRoute) {
    if (e.state.geohubRoute === "user-profile" && e.state.profileUid) {
      if (e.state.geohubRoute === currentRoute && e.state.profileUid === getOpenProfileUid()) return;
      openUserProfilePage(e.state.profileUid, { fromPopstate: true });
    } else if (e.state.geohubRoute === "post-detail" && e.state.postId) {
      if (e.state.geohubRoute === currentRoute && e.state.postId === getOpenPostId()) return;
      openPostDetailPage(e.state.postId, { fromPopstate: true });
    } else if (e.state.geohubRoute === "dm-thread" && e.state.dmUid) {
      if (e.state.geohubRoute === currentRoute && e.state.dmUid === getOpenDmUid()) return;
      openDmThread(e.state.dmUid, { fromPopstate: true });
    } else {
      if (e.state.geohubRoute === currentRoute) return;
      goToRoute(e.state.geohubRoute, { fromPopstate: true });
    }
  }
});

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

function renderProfile() {
  if (!currentProfile) return;
  const joined = fullDate(currentProfile.createdAt);
  const p = currentProfile;
  const admin = isAdminEmail(p.email);

  const rows = [
    ["Class Roll", escapeHtml(p.roll || "Not set")],
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
          <button type="button" id="profile-photo-badge" class="profile-photo-badge" aria-label="Profile photo options">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4"/></svg>
          </button>
        </div>
        <h3>${nameWithBadge(p.name, p.email)}</h3>
        <div class="profile-meta-row">
          <span class="profile-meta-chip chip-session">${escapeHtml(DEPARTMENT_NAME)}</span>
          ${p.session ? `<span class="profile-meta-chip chip-session">${escapeHtml(p.session)}</span>` : ""}
          ${admin ? `<span class="profile-meta-chip chip-admin" title="Admin · can post notices to the whole department">${adminBadgeHtml()} Admin</span>` : ""}
        </div>
      </div>
      ${p.bio ? `<p class="profile-own-bio">${escapeHtml(p.bio)}</p>` : ""}
      <div class="profile-stat-row">
        <div class="profile-stat-chip"><strong>${escapeHtml(p.roll || "—")}</strong><span>Roll No.</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(p.bloodGroup || "—")}</strong><span>Blood Grp</span></div>
        <div class="profile-stat-chip"><strong>${escapeHtml(p.year || p.session || "—")}</strong><span>Year</span></div>
      </div>

      <!-- Same slot a classmate's Message button sits in — on your own
           profile it's Edit Profile instead, so the row lines up the
           same way on every profile page. -->
      <div class="profile-action-row">
        <button type="button" id="profile-edit-btn" class="profile-action-primary">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Edit Profile
        </button>
      </div>

      <div class="profile-tabs" role="tablist">
        <button type="button" class="profile-tab-btn active" data-tab="info" role="tab" id="own-profile-tab-info" aria-selected="true" aria-controls="own-profile-panel-info">Info</button>
        <button type="button" class="profile-tab-btn" data-tab="posts" role="tab" id="own-profile-tab-posts" aria-selected="false" aria-controls="own-profile-panel-posts" tabindex="-1">Posts</button>
        <button type="button" class="profile-tab-btn" data-tab="notes" role="tab" id="own-profile-tab-notes" aria-selected="false" aria-controls="own-profile-panel-notes" tabindex="-1">Notes</button>
      </div>

      <div class="profile-tab-panel active" data-tab-panel="info" role="tabpanel" id="own-profile-panel-info" aria-labelledby="own-profile-tab-info">
        <div class="profile-flow-details">
          ${rows.map(([label, val]) => `<div class="profile-detail-row"><span>${label}</span><span>${val}</span></div>`).join("")}
        </div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="posts" role="tabpanel" id="own-profile-panel-posts" aria-labelledby="own-profile-tab-posts">
        <div id="own-profile-posts-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>

      <div class="profile-tab-panel" data-tab-panel="notes" role="tabpanel" id="own-profile-panel-notes" aria-labelledby="own-profile-tab-notes">
        <div id="own-profile-notes-list"><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div><div class="skeleton-row" aria-hidden="true"><div class="skeleton-avatar"></div><div class="skeleton-head-lines"><div class="skeleton-line sk-70"></div><div class="skeleton-line sk-40"></div></div></div></div>
      </div>
    </div>
  `;
  document.getElementById("profile-photo-badge").addEventListener("click", () => openAvatarActionSheet(p));
  document.getElementById("profile-edit-btn").addEventListener("click", () => openProfileDetailsModal(false));

  const profileCardEl = document.getElementById("profile-card");
  const tabBtns = profileCardEl.querySelectorAll(".profile-tab-btn");
  const tabPanels = profileCardEl.querySelectorAll(".profile-tab-panel");
  let ownPostsLoaded = false;
  let ownNotesLoaded = false;
  tabBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      tabBtns.forEach(b => {
        const active = b === btn;
        b.classList.toggle("active", active);
        b.setAttribute("aria-selected", String(active));
        b.tabIndex = active ? 0 : -1;
      });
      tabPanels.forEach(panel => panel.classList.toggle("active", panel.dataset.tabPanel === btn.dataset.tab));
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

function renderSettingsPage() {
  const pushToggle = document.getElementById("settings-push-toggle");
  const pushStatus = document.getElementById("settings-push-status");
  const resetPwBtn = document.getElementById("settings-reset-password-btn");

  document.getElementById("settings-edit-profile-btn").onclick = () => openProfileDetailsModal(false);

  const themeToggle = document.getElementById("settings-theme-toggle");
  const themeStatus = document.getElementById("settings-theme-status");
  const themeStatusText = {
    system: "Matches your device",
    light: "Always light",
    dark: "Always dark"
  };
  const paintThemeToggle = (pref) => {
    themeToggle.querySelectorAll("button").forEach(b => {
      const active = b.dataset.themeChoice === pref;
      b.classList.toggle("active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    themeStatus.textContent = themeStatusText[pref];
  };
  paintThemeToggle(getThemePreference());
  themeToggle.querySelectorAll("button").forEach(btn => {
    btn.onclick = () => {
      setThemePreference(btn.dataset.themeChoice);
      paintThemeToggle(btn.dataset.themeChoice);
    };
  });

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
      showToast(friendlyAuthError(err), { details: [err.code, err.message].filter(Boolean).join(" — ") });
    } finally {
      setBtnLoading(resetPwBtn, false);
    }
  };

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

function openAvatarActionSheet(p) {
  const hasPhoto = !!p.photoURL;
  openModal(`
    <h3>Profile Photo</h3>
    <div class="avatar-sheet">
      ${hasPhoto ? `
      <button type="button" class="avatar-sheet-item" id="avatar-view-photo-btn">
        <span class="avatar-sheet-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg></span>
        <span>View Photo</span>
      </button>` : ""}
      <button type="button" class="avatar-sheet-item" id="avatar-change-photo-btn">
        <span class="avatar-sheet-icon"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l1.5-2.5h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z"/><circle cx="12" cy="13" r="3.4"/></svg></span>
        <span>Change Photo</span>
      </button>
    </div>
  `);
  if (hasPhoto) {
    document.getElementById("avatar-view-photo-btn").addEventListener("click", () => {
      closeModal();
      openImageViewer(p.photoURL);
    });
  }
  document.getElementById("avatar-change-photo-btn").addEventListener("click", () => {
    closeModal();
    changeProfilePhotoQuick();
  });
}

function changeProfilePhotoQuick() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file || !isAcceptableImageFile(file)) return;
    const cropped = await openImageCropper(file);
    if (!cropped) return;
    const photoFile = new File([cropped], "avatar.jpg", { type: "image/jpeg" });
    try {
      const photoURL = await uploadImage(photoFile, { maxDim: 600, quality: 0.85, folder: "geohub/avatars" });
      await updateProfileDetails({
        name: currentProfile.name,
        roll: currentProfile.roll,
        blood: currentProfile.bloodGroup,
        phone: currentProfile.phone || "",
        gender: currentProfile.gender,
        photoURL
      });
      showToast("Profile photo updated.");
      if (!document.getElementById("section-profile").classList.contains("hidden")) renderProfile();
    } catch (err) {
      const { message, technical } = friendlyError(err, "Couldn't update your photo.");
      showToast(message, { details: technical });
    }
  });
  input.click();
}

function openProfileDetailsModal(isFirstTime = false) {
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
      <span>Class Roll</span>
      <input type="text" id="pd-roll" placeholder="e.g. 105" value="${escapeHtml(currentProfile.roll || "")}" />
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

  let selectedPhotoFile = null;
  const photoInput = document.getElementById("pd-photo-input");
  const photoPreview = document.getElementById("pd-photo-preview");
  document.getElementById("pd-photo-btn").addEventListener("click", () => photoInput.click());
  photoInput.addEventListener("change", async () => {
    const file = photoInput.files?.[0];
    photoInput.value = "";
    if (!file) return;
    if (!isAcceptableImageFile(file)) return;
    const cropped = await openImageCropper(file);
    if (!cropped) return;
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
    closeModal({ force: true }); 
    showToast(isFirstTime ? "Profile complete — welcome aboard!" : "Profile updated.");
    if (!document.getElementById("section-profile").classList.contains("hidden")) renderProfile();
  } catch (err) {
    errorEl.textContent = err.message && err.message.startsWith("You can change your name again")
      ? err.message
      : "Couldn't save your details. Please try again.";
    setBtnLoading(btn, false);
  }
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/firebase-messaging-sw.js").catch(() => {});
  });
}

isColdStart = await resetCacheOnColdStart();

watchAuthState(
  async (user, profile) => {
    showLoadingScreen("Loading GeoHub");
    setLoadingProgress(85); 
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");

    const displayProfile = profile || { name: user.email, email: user.email };
    const composerAvatar = document.getElementById("composer-avatar");
    if (composerAvatar) composerAvatar.innerHTML = avatarInner(displayProfile);


    let wallReady = Promise.resolve(true);
    let directoryReady = Promise.resolve(true);
    if (!featuresInitialized) {
      wallReady = waitForTrustedSnapshot(initWall);
      directoryReady = waitForTrustedSnapshot(initDirectory);
      initResources();
      initRoutine();
      initDeadlines();
      initGlobalSearch();
      initPresence();
      initMessages();
      initWriteQueueSync();
      featuresInitialized = true;
    }
    restoreRouteFromHash();
    initPush();
    if (profile && profile.profileIncomplete) {
      openProfileDetailsModal(true);
    }

    setLoadingProgress(92);
    const [wallConfirmed, directoryConfirmed] = await Promise.all([wallReady, directoryReady]);
    if (isColdStart && wallConfirmed && directoryConfirmed) {
      markSessionEstablished();
    }

    setLoadingProgress(100); 
    setTimeout(hideLoadingScreen, LOADING_MIN_DISPLAY_MS);
  },
  () => {
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");
    history.replaceState({ geohubAuthScreen: true }, "", location.pathname + location.search);
    scrollPositions = {}; 
    currentRoute = "wall";

    if (featuresInitialized) {
      teardownWall();
      teardownResources();
      teardownDirectory();
      teardownRoutine();
      teardownDeadlines();
      teardownPostDetail();
      teardownPresence();
      teardownMessages();
      featuresInitialized = false;
    }
    switchAuthTab("login");
    loginForm.reset();
    signupForm.reset();
    setBtnLoading(loginForm.querySelector('button[type="submit"]'), false);
    setBtnLoading(signupForm.querySelector('button[type="submit"]'), false);
    document.querySelectorAll("#google-signin-btn, .google-signin-trigger").forEach(btn => setBtnLoading(btn, false));

    if (loggingOut) {
      showLoadingScreen("Logging out");
      setLoadingProgress(100);
      setTimeout(() => {
        hideLoadingScreen();
        setLoadingLabel("Loading GeoHub");
        loggingOut = false;
      }, LOADING_MIN_DISPLAY_MS);
    } else {
      setLoadingProgress(100);
      hideLoadingScreen();
    }
  },
  (message) => {
    showToast(message, { duration: 6000 });
  }
);
