// App state: one plain object, a change signal, and the derived file list.
import type { Branch, CommitChanges, CommitInfo, FileEntry } from "./api";

export type Screen = "loading" | "welcome" | "repo" | "gone";
/** The sidebar lists either working-tree changes or the commit history. */
export type Mode = "changes" | "history";
export type ViewState = "unviewed" | "viewed" | "stale";

export interface Prefs {
  follow: boolean;
  hideViewed: boolean;
  group: boolean;
  wrap: boolean;
  sidebarWidth: number;
  mdPreview: boolean;
  split: boolean;
  theme: "system" | "light" | "dark";
}

const PREFS_KEY = "morphe.prefs";
const defaults: Prefs = { follow: false, hideViewed: false, group: false, wrap: false, sidebarWidth: 300, mdPreview: false, split: false, theme: "system" };

function loadPrefs(): Prefs {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") };
  } catch {
    return { ...defaults };
  }
}

export const state = {
  screen: "loading" as Screen,
  root: "",
  name: "",
  branch: "",
  mode: "changes" as Mode,
  /** Working-tree changes, always kept current. */
  work: new Map<string, FileEntry>(),
  /** The files on display: `work`, or the selected commit's files in history mode. */
  files: new Map<string, FileEntry>(),
  viewed: {} as Record<string, string>,
  selected: null as string | null,
  history: {
    branches: [] as Branch[],
    /** The branch whose log is listed; null for HEAD. */
    branch: null as string | null,
    commits: [] as CommitInfo[],
    /** Every commit of the branch is loaded. */
    done: false,
    loading: false,
    /** The selected commit, once loaded. */
    open: null as CommitChanges | null,
    selected: null as string | null,
  },
  filter: "",
  /** Files updated live since the user last looked at them. */
  updated: new Set<string>(),
  collapsed: new Set<string>(),
  prefs: loadPrefs(),
  error: "",
};

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs));
  } catch {
    /* storage unavailable: prefs just won't persist */
  }
}

// ---- change signal (render batched to one frame) ----

type Listener = () => void;
const listeners: Listener[] = [];
const after: Listener[] = [];

/** Run once, right after the next render. */
export function afterRender(fn: Listener) {
  after.push(fn);
  changed();
}
let queued = false;

export function subscribe(fn: Listener) {
  listeners.push(fn);
}

export function changed() {
  if (queued) return;
  queued = true;
  // rAF batches with painting; the timeout keeps state current while the window is hidden
  // (where rAF is paused), so restoring it never shows stale content.
  const flush = () => {
    if (!queued) return;
    queued = false;
    for (const fn of listeners) fn();
    for (const fn of after.splice(0)) fn();
  };
  requestAnimationFrame(flush);
  setTimeout(flush, 50);
}

// ---- derived ----

export function viewState(f: FileEntry): ViewState {
  if (state.mode === "history") return "unviewed"; // viewed marks belong to working-tree diffs
  const h = state.viewed[f.path];
  if (!h) return "unviewed";
  return h === f.diffHash ? "viewed" : "stale";
}

export function splitPath(p: string): { dir: string; name: string } {
  const i = p.lastIndexOf("/");
  return i < 0 ? { dir: "", name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) };
}

/** Every space-separated term must appear in the path (case-insensitive). */
export function matches(path: string, query: string): boolean {
  const p = path.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => p.includes(t));
}

/** Files in display order after filter and hide-viewed. */
export function visibleFiles(): FileEntry[] {
  const out: FileEntry[] = [];
  for (const f of state.files.values()) {
    if (state.filter && !matches(f.path, state.filter)) continue;
    if (state.prefs.hideViewed && viewState(f) === "viewed" && f.path !== state.selected) continue;
    out.push(f);
  }
  return out.sort(state.prefs.group ? byDirThenName : byPath);
}

const byPath = (a: FileEntry, b: FileEntry) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
function byDirThenName(a: FileEntry, b: FileEntry) {
  const x = splitPath(a.path);
  const y = splitPath(b.path);
  if (x.dir !== y.dir) return x.dir < y.dir ? -1 : 1;
  return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
}

/** The commit whose files are on display, or null for the working tree. */
export function shownCommit(): string | null {
  return state.mode === "history" ? (state.history.open?.commit.id ?? null) : null;
}

export function totals() {
  let add = 0;
  let del = 0;
  let viewed = 0;
  for (const f of state.files.values()) {
    add += f.additions;
    del += f.deletions;
    if (viewState(f) === "viewed") viewed++;
  }
  return { files: state.files.size, add, del, viewed };
}
