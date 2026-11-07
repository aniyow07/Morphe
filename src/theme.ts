// Theme: follow the OS, or a fixed light/dark choice. Tokens switch on <html data-theme>.
import { savePrefs, state } from "./state";

const osLight = matchMedia("(prefers-color-scheme: light)");
const ORDER = ["system", "light", "dark"] as const;
export const THEME_LABEL = { system: "Match system", light: "Light", dark: "Dark" };

export function applyTheme() {
  const t = state.prefs.theme === "system" ? (osLight.matches ? "light" : "dark") : state.prefs.theme;
  document.documentElement.dataset.theme = t;
}

export function cycleTheme() {
  state.prefs.theme = ORDER[(ORDER.indexOf(state.prefs.theme) + 1) % ORDER.length];
  savePrefs();
  applyTheme();
}

osLight.addEventListener("change", applyTheme);
applyTheme();
