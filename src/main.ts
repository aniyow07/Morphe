import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/app.css";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, events, type Change, type FileEntry, type Snapshot } from "./api";
import { h } from "./dom";
import { afterRender, changed, savePrefs, state, subscribe, viewState, visibleFiles } from "./state";
import { diffView } from "./ui/diffview";
import { palette } from "./ui/palette";
import { sidebar, step } from "./ui/sidebar";
import { tickLive, titlebar } from "./ui/titlebar";
import { tooltips } from "./ui/tooltip";
import { goneState, welcome } from "./ui/welcome";

if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
  await (await import("./dev/mock")).installMock();
}

// ---------- actions ----------

function select(path: string | null) {
  if (state.selected === path) return;
  state.selected = path;
  if (path) state.updated.delete(path);
  changed();
  dv.show(path, false);
}

function toggleViewed(path: string) {
  const f = state.files.get(path);
  if (!f) return;
  if (viewState(f) === "viewed") {
    delete state.viewed[path];
    api.setViewed(path, null);
  } else {
    const list = visibleFiles();
    const i = list.findIndex((x) => x.path === path);
    state.viewed[path] = f.diffHash;
    api.setViewed(path, f.diffHash);
    // With "hide viewed" on, move on to the next file instead of keeping a hidden one open.
    if (state.prefs.hideViewed && path === state.selected) {
      const next = list.slice(i + 1).concat(list.slice(0, i).reverse()).find((x) => viewState(x) !== "viewed");
      select(next?.path ?? null);
    }
  }
  changed();
}

async function openRepo(path: string) {
  state.screen = "loading";
  state.error = "";
  changed();
  try {
    applySnapshot(await api.openRepo(path));
  } catch (e) {
    state.screen = "welcome";
    state.error = String(e);
    changed();
    wl.refresh();
  }
}

function applySnapshot(s: Snapshot) {
  state.root = s.root;
  state.name = s.name;
  state.branch = s.branch;
  state.files = new Map(s.files.map((f) => [f.path, f]));
  state.viewed = s.viewed;
  state.updated.clear();
  state.selected = null;
  state.screen = "repo";
  changed();
  const first = state.prefs.follow ? mostRecent(s.files) : visibleFiles()[0];
  if (first) select(first.path);
  else dv.show(null, false);
}

async function pickFolder() {
  const dir = await openDialog({ directory: true, multiple: false, title: "Open a git repository" });
  if (typeof dir === "string") openRepo(dir);
}

async function goWelcome() {
  await api.closeRepo();
  state.screen = "welcome";
  state.error = "";
  state.files = new Map();
  state.selected = null;
  changed();
  dv.show(null, false);
  wl.refresh();
}

function onChange(c: Change) {
  if (state.screen !== "repo") return;
  state.branch = c.branch;
  const touched: FileEntry[] = [];
  for (const p of c.removed) {
    state.files.delete(p);
    state.updated.delete(p);
  }
  for (const { contentChanged, ...entry } of c.upserts) {
    state.files.set(entry.path, entry);
    if (contentChanged) touched.push(entry);
  }
  for (const f of touched) if (f.path !== state.selected) state.updated.add(f.path);

  const sel = state.selected;
  if (state.prefs.follow && touched.length) {
    select(mostRecent(touched)!.path);
  } else if (sel && !state.files.has(sel)) {
    select(visibleFiles()[0]?.path ?? null);
  } else if (sel && touched.some((f) => f.path === sel)) {
    dv.show(sel, true);
  } else if (!sel && state.files.size) {
    select(visibleFiles()[0]?.path ?? null);
  } else if (!state.files.size) {
    dv.show(null, false);
  }
  changed();
  tickLive();
  // After the render, so freshly added rows exist.
  afterRender(() => sb.pulse(touched.map((f) => f.path)));
}

function mostRecent(files: FileEntry[]): FileEntry | undefined {
  return files.reduce<FileEntry | undefined>((best, f) => (!best || f.mtime > best.mtime ? f : best), undefined);
}

// ---------- layout ----------

const app = document.getElementById("app")!;
const sb = sidebar({ select, toggleViewed });
const dv = diffView({ toggleViewed });
const divider = h("div", { class: "divider", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize sidebar", tabindex: "0" });
const workspace = h("main", { class: "workspace" }, sb.el, divider, dv.el);
const wl = welcome(openRepo, pickFolder);
const gone = goneState(pickFolder, () => openRepo(state.root));
const pal = palette((p) => select(p));
app.append(titlebar(goWelcome), workspace, wl.el, gone.el, pal.el);
tooltips();

subscribe(() => {
  workspace.hidden = state.screen !== "repo" && state.screen !== "loading";
  wl.el.hidden = state.screen !== "welcome";
  gone.el.hidden = state.screen !== "gone";
  workspace.style.setProperty("--sidebar-w", `${state.prefs.sidebarWidth}px`);
  dv.renderHeader();
});

// Sidebar resizing: drag, arrow keys, double-click to reset. Width persists.
const setWidth = (w: number) => {
  state.prefs.sidebarWidth = Math.round(Math.min(Math.max(w, 200), Math.min(640, window.innerWidth - 320)));
  workspace.style.setProperty("--sidebar-w", `${state.prefs.sidebarWidth}px`);
};
divider.addEventListener("pointerdown", (e) => {
  divider.setPointerCapture(e.pointerId);
  divider.classList.add("dragging");
  const startX = e.clientX;
  const startW = state.prefs.sidebarWidth;
  const move = (ev: PointerEvent) => setWidth(startW + ev.clientX - startX);
  const up = () => {
    divider.classList.remove("dragging");
    divider.removeEventListener("pointermove", move);
    savePrefs();
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", up, { once: true });
});
divider.addEventListener("dblclick", () => (setWidth(300), savePrefs()));
divider.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  setWidth(state.prefs.sidebarWidth + (e.key === "ArrowLeft" ? -16 : 16));
  savePrefs();
});

// ---------- keyboard ----------

document.addEventListener("keydown", (e) => {
  if (pal.isOpen) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "p") {
    e.preventDefault();
    if (state.screen === "repo") pal.open();
    return;
  }
  const t = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || t.matches("input, textarea") || state.screen !== "repo") return;
  if (k === "j") step(1, select);
  else if (k === "k") step(-1, select);
  else if (k === "v" && state.selected) toggleViewed(state.selected);
  else if (e.key === "/") {
    e.preventDefault();
    sb.focusFilter();
  } else return;
  e.preventDefault();
});

document.addEventListener("morphe:pref", (e) => {
  const key = (e as CustomEvent<string>).detail;
  if (key === "follow" && state.prefs.follow) {
    const f = mostRecent(Array.from(state.files.values()));
    if (f) select(f.path);
  }
});

// ---------- boot ----------

events.onChanged(onChange);
events.onBranch((b) => ((state.branch = b), changed()));
events.onGone((root) => {
  state.screen = "gone";
  gone.set(root);
  changed();
});

(async () => {
  const launch = await api.launchPath().catch(() => null);
  if (launch) await openRepo(launch);
  else {
    state.screen = "welcome";
    changed();
    await wl.refresh();
  }
  afterRender(() => getCurrentWindow().show());
})();
