// ============================================================
// APP.JS — Entry point.
// Wires up the auth screen, watches login state, swaps between
// the auth screen and the app shell, and handles SPA routing
// between the 5 sections via the sidebar / bottom nav.
// ============================================================
import { DEPARTMENT_NAME, COLLEGE_NAME } from "./firebase-config.js";
import { signUp, logIn, logOut, watchAuthState, friendlyAuthError, currentProfile } from "./auth.js";
import { initWall, teardownWall } from "./wall.js";
import { initResources, teardownResources } from "./resources.js";
import { initDirectory, teardownDirectory } from "./directory.js";
import { initRoutine, teardownRoutine } from "./routine.js";
import { escapeHtml, initialsOf } from "./ui-utils.js";

// ---------- Element references ----------
const loadingScreen = document.getElementById("loading-screen");
const authScreen = document.getElementById("auth-screen");
const appShell = document.getElementById("app-shell");

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

loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("login-error");
  errorEl.textContent = "";
  try {
    await logIn(
      document.getElementById("login-email").value.trim(),
      document.getElementById("login-password").value
    );
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
  }
});

signupForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("signup-error");
  errorEl.textContent = "";
  try {
    await signUp({
      name: document.getElementById("signup-name").value,
      roll: document.getElementById("signup-roll").value,
      blood: document.getElementById("signup-blood").value,
      phone: document.getElementById("signup-phone").value,
      email: document.getElementById("signup-email").value,
      password: document.getElementById("signup-password").value
    });
  } catch (err) {
    errorEl.textContent = friendlyAuthError(err);
  }
});

// ============================================================
// ROUTING — one active <section class="route-section"> at a time
// ============================================================
const routeTitles = {
  wall: "Student Wall",
  resources: "Notes & Sheet Hub",
  directory: "Classmate Directory",
  routine: "Routine & Notices",
  profile: "My Profile"
};

function goToRoute(route) {
  document.querySelectorAll(".route-section").forEach(sec => {
    sec.classList.toggle("hidden", sec.id !== `section-${route}`);
  });
  document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });
  document.getElementById("topbar-title").textContent = routeTitles[route] || "GeoHub";

  if (route === "profile") renderProfile();
}

document.querySelectorAll(".nav-item[data-route]").forEach(btn => {
  btn.addEventListener("click", () => goToRoute(btn.dataset.route));
});

// ============================================================
// LOGOUT — both the desktop sidebar button and the mobile profile button
// ============================================================
document.getElementById("logout-btn-desktop").addEventListener("click", () => logOut());
document.getElementById("logout-btn-mobile").addEventListener("click", () => logOut());

// ============================================================
// PROFILE SECTION — simple read-only render of the logged-in student
// ============================================================
function renderProfile() {
  if (!currentProfile) return;
  document.getElementById("profile-card").innerHTML = `
    <div class="avatar">${initialsOf(currentProfile.name)}</div>
    <h3>${escapeHtml(currentProfile.name)}</h3>
    <div class="profile-role">${escapeHtml(DEPARTMENT_NAME)}</div>
    <div class="profile-detail-row"><span>Roll / Reg. No.</span><span>${escapeHtml(currentProfile.roll)}</span></div>
    <div class="profile-detail-row"><span>Blood Group</span><span>${escapeHtml(currentProfile.bloodGroup)}</span></div>
    <div class="profile-detail-row"><span>Phone</span><span>${escapeHtml(currentProfile.phone)}</span></div>
    <div class="profile-detail-row"><span>Email</span><span>${escapeHtml(currentProfile.email)}</span></div>
    <div class="profile-detail-row"><span>College</span><span>${escapeHtml(COLLEGE_NAME)}</span></div>
  `;
}

// ============================================================
// AUTH STATE — the single switch between auth-screen and app-shell
// ============================================================
watchAuthState(
  (user, profile) => {
    loadingScreen.classList.add("hidden");
    authScreen.classList.add("hidden");
    appShell.classList.remove("hidden");

    document.getElementById("topbar-user").textContent = profile ? profile.name : user.email;

    if (!featuresInitialized) {
      initWall();
      initResources();
      initDirectory();
      initRoutine();
      featuresInitialized = true;
    }
    goToRoute("wall");
  },
  () => {
    loadingScreen.classList.add("hidden");
    appShell.classList.add("hidden");
    authScreen.classList.remove("hidden");

    if (featuresInitialized) {
      teardownWall();
      teardownResources();
      teardownDirectory();
      teardownRoutine();
      featuresInitialized = false;
    }
    // Reset auth forms for the next login
    loginForm.reset();
    signupForm.reset();
  }
);
