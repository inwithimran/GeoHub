const STORAGE_KEY = "geohub-theme";
const VALID = ["system", "light", "dark"];

const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePreference() {
  const stored = localStorage.getItem(STORAGE_KEY);
  return VALID.includes(stored) ? stored : "system";
}

function resolveTheme(pref) {
  return pref === "system" ? (media.matches ? "dark" : "light") : pref;
}

function paint(pref) {
  document.documentElement.setAttribute("data-theme", resolveTheme(pref));
}

export function setThemePreference(pref) {
  if (!VALID.includes(pref)) return;
  try { localStorage.setItem(STORAGE_KEY, pref); } catch {  }
  paint(pref);
}

export function initTheme() {
  paint(getThemePreference());
  media.addEventListener("change", () => {
    if (getThemePreference() === "system") paint("system");
  });
}
