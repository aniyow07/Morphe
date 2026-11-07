import "@fontsource-variable/geist";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/app.css";
import "./theme";

import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, events, type Change, type FileEntry, type Snapshot } from "./api";
import { h } from "./dom";
import { afterRender, changed, savePrefs, state, subscribe, treeMode, viewState, visibleFiles, type Mode } from "./state";
import { stepCommit } from "./ui/history";
import { invalidate, resetTree, reveal } from "./ui/tree";
import { diffView } from "./ui/diffview";
import { palette } from "./ui/palette";
import { settings } from "./ui/settings";
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
  if (path && state.mode === "changes") state.updated.delete(path);
  if (path && treeMode()) reveal(path);
  changed();
  dv.show(path, false);
}

function toggleViewed(path: string) {
  const f = state.files.get(path);
  if (!f || state.mode !== "changes") return;
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
  state.base = null;
  state.error = "";
  changed();
  try {
    applySnapshot(await api.openRepo(path));
    if (state.prefs.ignoreWs) await applyScanOptions();
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
  state.mode = "changes";
  state.work = new Map(s.files.map((f) => [f.path, f]));
  state.files = state.work;
  resetHistory();
  resetTree();
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
  state.mode = "changes";
  state.work = new Map();
  state.files = state.work;
  resetHistory();
  resetTree();
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
    state.work.delete(p);
    state.updated.delete(p);
  }
  for (const { contentChanged, ...entry } of c.upserts) {
    state.work.set(entry.path, entry);
    if (contentChanged) touched.push(entry);
  }
  // Files that appeared or vanished change folder listings in the "All files" tree.
  invalidate(c.removed.concat(c.upserts.filter((u) => u.status !== "M").map((u) => u.path)));
  if (state.mode === "history") {
    // The commit on display doesn't change; keep the working tree current for later.
    for (const f of touched) state.updated.add(f.path);
    if (workSelected && !state.work.has(workSelected)) workSelected = null;
    changed();
    tickLive();
    return;
  }
  for (const f of touched) if (f.path !== state.selected) state.updated.add(f.path);

  const sel = state.selected;
  if (state.prefs.follow && touched.length) {
    select(mostRecent(touched)!.path);
  } else if (sel && !state.files.has(sel) && treeMode()) {
    if (c.removed.includes(sel)) dv.show(sel, true); // reverted: now an unchanged file
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

// ---------- history ----------

const PAGE = 100;
let workSelected: string | null = null;
let historySelected: string | null = null;
let historyGen = 0;
let commitGen = 0;

function resetHistory() {
  historyGen++;
  commitGen++;
  Object.assign(state.history, { branches: [], branch: null, commits: [], done: false, loading: false, open: null, selected: null });
  workSelected = historySelected = null;
}

function setMode(mode: Mode) {
  if (state.mode === mode || state.screen !== "repo") return;
  if (mode === "history") {
    workSelected = state.selected;
    state.mode = "history";
    state.files = new Map((state.history.open?.files ?? []).map((f) => [f.path, f]));
    state.selected = historySelected && state.files.has(historySelected) ? historySelected : null;
    if (!state.history.commits.length) loadHistory(true);
  } else {
    historySelected = state.selected;
    state.mode = "changes";
    state.files = state.work;
    state.selected = workSelected && state.work.has(workSelected) ? workSelected : (visibleFiles()[0]?.path ?? null);
    if (state.selected) state.updated.delete(state.selected);
  }
  changed();
  dv.show(state.selected, false);
}

/** Load the branch list and the first page (`reset`), or the next page of commits. */
async function loadHistory(reset: boolean) {
  const H = state.history;
  if (!reset && (H.loading || H.done)) return;
  const my = ++historyGen;
  H.loading = true;
  changed();
  try {
    if (reset) {
      H.branches = await api.listBranches();
      if (H.branch && !H.branches.some((b) => b.name === H.branch)) H.branch = null;
    }
    const page = await api.listCommits(H.branch, reset ? 0 : H.commits.length, PAGE);
    if (my !== historyGen) return;
    H.commits = reset ? page : H.commits.concat(page);
    H.done = page.length < PAGE;
  } catch {
    if (my === historyGen) H.done = true;
  } finally {
    if (my === historyGen) {
      H.loading = false;
      changed();
    }
  }
  if (my === historyGen && reset && !H.selected && H.commits[0]) selectCommit(H.commits[0].id);
}

async function selectCommit(id: string) {
  const H = state.history;
  if (H.selected === id) return;
  H.selected = id;
  changed();
  const my = ++commitGen;
  const open = await api.openCommit(id).catch(() => null);
  if (my !== commitGen) return;
  H.open = open;
  if (state.mode !== "history") return changed();
  // Stay on the same file when the next commit touches it too.
  const prev = state.selected;
  state.files = new Map((open?.files ?? []).map((f) => [f.path, f]));
  state.selected = null;
  const next = prev && state.files.has(prev) ? prev : (visibleFiles()[0]?.path ?? null);
  if (next) select(next);
  else {
    changed();
    dv.show(null, false);
  }
}

function setBranch(name: string | null) {
  const H = state.history;
  if (H.branch === name) return;
  commitGen++;
  Object.assign(H, { branch: name, commits: [], done: false, open: null, selected: null });
  state.files = new Map();
  state.selected = null;
  changed();
  dv.show(null, false);
  loadHistory(true);
}

function onRefs() {
  if (state.screen !== "repo") return;
  if (state.mode === "history") loadHistory(true);
  else Object.assign(state.history, { commits: [], done: false }); // reload when History opens
}

const historyActions = { selectCommit, setBranch, loadMore: () => loadHistory(false) };

// ---------- scan options: ignore whitespace, compare against a branch ----------

async function applyScanOptions() {
  if (state.screen !== "repo") return;
  try {
    const s = await api.setScanOptions(state.prefs.ignoreWs, state.base);
    const before = Array.from(state.work.keys());
    state.work = new Map(s.files.map((f) => [f.path, f]));
    if (state.mode === "changes") state.files = state.work;
    state.viewed = s.viewed;
    invalidate(before.concat(s.files.map((f) => f.path)));
    changed();
    if (state.mode !== "changes") return;
    if (state.selected && !state.files.has(state.selected) && !treeMode()) select(visibleFiles()[0]?.path ?? null);
    else dv.show(state.selected, true);
  } catch (e) {
    toast(String(e));
  }
}

function setBase(name: string | null) {
  state.base = name;
  applyScanOptions();
}

function openInEditor(path: string, line: number | null) {
  api.openInEditor(path, line, state.prefs.editor).catch((e) => toast(String(e)));
}

const toastEl = h("div", { class: "toast", role: "status", hidden: true });
let toastTimer = 0;
function toast(msg: string) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toastEl.hidden = true), 5000);
}

function mostRecent(files: FileEntry[]): FileEntry | undefined {
  return files.reduce<FileEntry | undefined>((best, f) => (!best || f.mtime > best.mtime ? f : best), undefined);
}

// ---------- layout ----------

const app = document.getElementById("app")!;
const sb = sidebar({ select, toggleViewed, setMode, setBase, ...historyActions });
const dv = diffView({ toggleViewed, openInEditor });
const divider = h("div", { class: "divider", role: "separator", "aria-orientation": "vertical", "aria-label": "Resize sidebar", tabindex: "0" });
const workspace = h("main", { class: "workspace" }, sb.el, divider, dv.el);
const wl = welcome(openRepo, pickFolder);
const gone = goneState(pickFolder, () => openRepo(state.root));
const pal = palette((p) => select(p));
const prefsSheet = settings({ refreshDiff: () => dv.refresh() });
app.append(titlebar(goWelcome, prefsSheet.open), workspace, wl.el, gone.el, pal.el, prefsSheet.el, toastEl);
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
  if (pal.isOpen || prefsSheet.isOpen) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && e.key === ",") {
    e.preventDefault();
    prefsSheet.open();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === "f" && state.screen === "repo") {
    e.preventDefault();
    dv.openFind();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && k === "p") {
    e.preventDefault();
    if (state.screen === "repo") pal.open();
    return;
  }
  const t = e.target as HTMLElement;
  if (e.ctrlKey || e.metaKey || e.altKey || t.matches("input, textarea") || state.screen !== "repo") return;
  if (state.mode === "history" && e.shiftKey && (k === "j" || k === "k")) stepCommit(k === "j" ? 1 : -1, historyActions);
  else if (k === "j") step(1, select);
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
  if (key === "ignoreWs") applyScanOptions();
  if (key === "allFiles" && state.prefs.allFiles && state.selected) reveal(state.selected);
  if (key === "allFiles" && !state.prefs.allFiles && state.selected && !state.files.has(state.selected)) {
    select(visibleFiles()[0]?.path ?? null);
  }
  if (key === "follow" && state.prefs.follow && state.mode === "changes") {
    const f = mostRecent(Array.from(state.files.values()));
    if (f) select(f.path);
  }
});

// ---------- boot ----------

events.onChanged(onChange);
events.onBranch((b) => ((state.branch = b), changed()));
events.onRefs(onRefs);
document.addEventListener("morphe:theme", changed);
events.onGone((root) => {
  state.screen = "gone";
  gone.set(root);
  changed();
});

(async () => {
  let launch = await api.launchPath().catch(() => null);
  if (!launch && state.prefs.reopenLast) launch = (await api.recentRepos().catch(() => []))[0]?.path ?? null;
  if (launch) await openRepo(launch);
  else {
    state.screen = "welcome";
    changed();
    await wl.refresh();
  }
  afterRender(() => getCurrentWindow().show());
})();
