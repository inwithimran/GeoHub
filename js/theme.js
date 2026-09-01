// ============================================================
// THEME — System / Light / Dark, chosen from Settings → Appearance.
//
// The *first* application of the theme happens in an inline <script>
// at the top of index.html's <head>, synchronously, before anything
// paints — that's what avoids a flash of the wrong theme on load.
// This module is the rest of the theme system: reading/writing the
// stored preference, re-applying it, and keeping "System" live if
// the OS theme changes while GeoHub is open (e.g. sunset-triggered
// dark mode kicking in with the tab still open).
// ============================================================

const STORAGE_KEY = "geohub-theme";
const VALID = ["system", "light", "dark"];

const media = window.matchMedia("(prefers-color-scheme: dark)");

/** The raw stored preference — "system" | "light" | "dark". Defaults to "system". */
export function getThemePreference() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return VALID.includes(stored) ? stored : "system";
}

/** What's actually painted right now — "light" | "dark" (resolves "system" via the OS). */
function resolveTheme(pref) {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

function paint(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

/** Store a new preference and repaint immediately. */
export function setThemePreference(pref) {
  if (!VALID.includes(pref)) return;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch { /* private mode etc — theme just won't persist */ }
  paint(pref);
}

/**
 * Call once at startup. Repaints with whatever's stored (in case the
 * inline head script and this module ever disagree — cheap to be sure)
 * and, only while the user is on "System", keeps repainting live if the
 * OS theme flips out from under them.
 */
export function initTheme() {
  paint(getThemePreference());
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") paint("system");
  });
}
