// Theme: a mode (match the OS, light, or dark) plus which dark and which light theme to use.
// Tokens switch on <html data-theme> (light/dark base) and <html data-palette> (alternates).
import { savePrefs, state } from "./state";

const osLight = matchMedia("(prefers-color-scheme: light)");

export interface ThemeDef {
  id: string;
  name: string;
  kind: "dark" | "light";
  /** Preview swatch: sidebar, canvas, surface, text, accent. */
  swatch: [string, string, string, string, string];
}

export const THEMES: ThemeDef[] = [
  { id: "graphite", name: "Graphite", kind: "dark", swatch: ["#121419", "#16181d", "#2a2f39", "#dcdfe6", "#8f8df4"] },
  { id: "midnight", name: "Midnight", kind: "dark", swatch: ["#0d1320", "#111827", "#24314d", "#d8dfee", "#7aa7ff"] },
  { id: "ember", name: "Ember", kind: "dark", swatch: ["#161311", "#1b1816", "#352e29", "#e8e1da", "#e48aa8"] },
  { id: "forest", name: "Forest", kind: "dark", swatch: ["#0f1512", "#131a17", "#26332d", "#dbe5df", "#b9a2f0"] },
  { id: "contrast", name: "High contrast", kind: "dark", swatch: ["#050608", "#0a0c10", "#2a303b", "#ffffff", "#a8b4ff"] },
  { id: "paper", name: "Paper", kind: "light", swatch: ["#eceef2", "#f5f6f8", "#dce0f5", "#1c1f26", "#5450d6"] },
  { id: "sand", name: "Sand", kind: "light", swatch: ["#efeae1", "#f7f4ee", "#e2dccd", "#24211c", "#1f6f8b"] },
  { id: "mist", name: "Mist", kind: "light", swatch: ["#e7edf5", "#f3f6fa", "#d4e0f2", "#17202c", "#2563c9"] },
];
const DEFAULT = { dark: "graphite", light: "paper" };

/** Which base is showing right now. */
export function shownKind(): "light" | "dark" {
  return state.prefs.theme === "system" ? (osLight.matches ? "light" : "dark") : state.prefs.theme;
}

export function applyTheme() {
  const kind = shownKind();
  const id = kind === "dark" ? state.prefs.darkTheme : state.prefs.lightTheme;
  const root = document.documentElement;
  root.dataset.theme = kind;
  if (THEMES.some((t) => t.id === id && t.kind === kind) && id !== DEFAULT[kind]) root.dataset.palette = id;
  else delete root.dataset.palette;
}

/** Title-bar switch: flip to the other base, so every click visibly changes something. */
export function toggleLightDark() {
  state.prefs.theme = shownKind() === "dark" ? "light" : "dark";
  savePrefs();
  applyTheme();
}

export function setMode(mode: "system" | "light" | "dark") {
  state.prefs.theme = mode;
  savePrefs();
  applyTheme();
}

/** Pick a theme. If it can't show under the current fixed mode, switch to its kind. */
export function setTheme(t: ThemeDef) {
  if (t.kind === "dark") state.prefs.darkTheme = t.id;
  else state.prefs.lightTheme = t.id;
  if (shownKind() !== t.kind) state.prefs.theme = t.kind;
  savePrefs();
  applyTheme();
}

osLight.addEventListener("change", () => {
  applyTheme();
  document.dispatchEvent(new CustomEvent("morphe:theme"));
});
applyTheme();
