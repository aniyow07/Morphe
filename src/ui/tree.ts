// "All files": the working tree as a lazily loaded folder tree, changed files marked in their
// status color. Folders load one level at a time, so a huge repository costs only what's open.
import { fileIcon } from "../fileicons";
import { api, type DirEntry, type FileEntry } from "../api";
import { esc, fmt, h, icon, STATUS_LABEL } from "../dom";
import { changed, shownCommit, state } from "../state";

/** Rows past this many in one folder are summarized instead of rendered. */
const MAX_PER_DIR = 2000;

export const tree = {
  /** Expanded folders ("" is the root). */
  open: new Set<string>([""]),
  entries: new Map<string, DirEntry[]>(),
  loading: new Set<string>(),
  /** Whose listings `entries` holds: a commit id, or null for the working tree. */
  source: null as string | null,
};

export function resetTree() {
  tree.open = new Set([""]);
  tree.entries.clear();
  tree.loading.clear();
}

async function load(dir: string) {
  if (tree.loading.has(dir)) return;
  tree.loading.add(dir);
  const src = tree.source;
  let list: DirEntry[] = [];
  try {
    list = await (src ? api.listCommitDir(src, dir) : api.listDir(dir));
  } catch {
    /* gone meanwhile; the next change event corrects it */
  }
  if (tree.source !== src) return; // switched commit while loading
  tree.entries.set(dir, list);
  tree.loading.delete(dir);
  changed();
}

const parentOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));

/** Files appeared or disappeared: reload the listings that may include them. */
export function invalidate(paths: string[]) {
  const dirs = new Set<string>();
  for (const p of paths) {
    let d = p;
    do {
      d = parentOf(d);
      dirs.add(d);
    } while (d);
  }
  for (const d of dirs) {
    if (!tree.entries.has(d)) continue;
    if (tree.open.has(d)) load(d);
    else tree.entries.delete(d);
  }
}

/** Expand every folder above `path` so its row is visible. */
export function reveal(path: string) {
  let d = path;
  while (d) {
    d = parentOf(d);
    tree.open.add(d);
  }
}

export function toggleDir(dir: string) {
  tree.open.has(dir) ? tree.open.delete(dir) : tree.open.add(dir);
  changed();
}

/** Per folder: how many changed files sit beneath it, and the changed entries directly in it
 *  (deleted files and folders no longer exist on disk, so the listing alone misses them). */
function changeIndex(work: Map<string, FileEntry>) {
  const counts = new Map<string, number>();
  const children = new Map<string, Map<string, boolean>>();
  for (const p of work.keys()) {
    const parts = p.split("/");
    let dir = "";
    for (let i = 0; i < parts.length; i++) {
      const isDir = i < parts.length - 1;
      if (!children.has(dir)) children.set(dir, new Map());
      children.get(dir)!.set(parts[i], isDir);
      if (!isDir) break;
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      counts.set(dir, (counts.get(dir) ?? 0) + 1);
    }
  }
  return { counts, children };
}

const cache = new Map<string, { el: HTMLElement; sig: string }>();
let nextId = 0;

/** The visible tree as row elements (reused between renders). */
export function treeRows(): HTMLElement[] {
  // History shows the repository as of the opened commit; switching commits starts over
  // (keeping which folders are open).
  const src = state.mode === "history" ? shownCommit() : null;
  if (src !== tree.source) {
    tree.source = src;
    tree.entries.clear();
    tree.loading.clear();
  }
  const files = state.files;
  const idx = changeIndex(files);
  const out: HTMLElement[] = [];
  const seen = new Set<string>();

  const row = (key: string, sig: string, make: () => { cls: string; html: string; attrs: Record<string, string> }) => {
    seen.add(key);
    let c = cache.get(key);
    if (!c) {
      c = { el: h("div"), sig: "" };
      cache.set(key, c);
    }
    if (c.sig !== sig) {
      const m = make();
      c.el.className = m.cls;
      c.el.innerHTML = m.html;
      for (const [k, v] of Object.entries(m.attrs)) c.el.setAttribute(k, v);
      c.sig = sig;
    }
    out.push(c.el);
  };
  const indent = (depth: number) => `padding-left:${8 + depth * 14}px`;

  const walk = (dir: string, depth: number) => {
    const listed = tree.entries.get(dir);
    if (!listed) {
      load(dir);
      row(`load:${dir}`, `${depth}`, () => ({ cls: "trow tnote", html: "Loading…", attrs: { style: indent(depth + 1) } }));
      return;
    }
    const kids = new Map<string, boolean>(listed.map((e) => [e.name, e.dir]));
    for (const [name, isDir] of idx.children.get(dir) ?? []) if (!kids.has(name)) kids.set(name, isDir);
    const sorted = Array.from(kids).sort(([a, ad], [b, bd]) => (ad !== bd ? (ad ? -1 : 1) : a.toLowerCase() < b.toLowerCase() ? -1 : 1));

    sorted.slice(0, MAX_PER_DIR).forEach(([name, isDir]) => {
      const path = dir ? `${dir}/${name}` : name;
      if (isDir) {
        const open = tree.open.has(path);
        const n = idx.counts.get(path) ?? 0;
        row(`d:${path}`, `${open}|${n}|${depth}`, () => ({
          cls: `trow tdir${n ? " has-changes" : ""}${open ? " open" : ""}`,
          html:
            `<span class="chev">${icon.chevron}</span><span class="tn">${esc(name)}</span>` +
            (n ? `<span class="tcount" data-tip="${n} changed ${n === 1 ? "file" : "files"}">${fmt.format(n)}</span>` : ""),
          attrs: { "data-dir": path, role: "treeitem", "aria-expanded": String(open), style: indent(depth) },
        }));
        if (open) walk(path, depth + 1);
      } else {
        const f = files.get(path);
        const sel = state.selected === path;
        const sig = f ? [f.status, f.additions, f.deletions, f.kind, sel, depth].join("|") : `${sel}|${depth}`;
        row(`f:${path}`, sig, () => ({
          cls: `row trow tfile${f ? ` changed c-${f.status}` : ""}`,
          html:
            (f ? `<span class="st st-${f.status}" data-tip="${STATUS_LABEL[f.status]}">${f.status}</span>` : `<span class="st"></span>`) +
            fileIcon(name) +
            `<span class="tn">${esc(name)}</span>` +
            (f
              ? `<span class="ct">${
                  f.kind === "text"
                    ? `${f.additions ? `<span class="add">+${fmt.format(f.additions)}</span>` : ""}${f.deletions ? `<span class="del">−${fmt.format(f.deletions)}</span>` : ""}`
                    : `<span class="bin">${f.kind === "binary" ? "bin" : "large"}</span>`
                }</span>`
              : ""),
          attrs: { "data-path": path, role: "treeitem", "aria-selected": String(sel), id: `t-${++nextId}`, style: indent(depth) },
        }));
      }
    });
    if (sorted.length > MAX_PER_DIR) {
      const rest = sorted.length - MAX_PER_DIR;
      row(`more:${dir}`, `${rest}|${depth}`, () => ({
        cls: "trow tnote",
        html: `${fmt.format(rest)} more not shown`,
        attrs: { style: indent(depth + 1) },
      }));
    }
  };
  walk("", 0);
  for (const k of cache.keys()) if (!seen.has(k)) cache.delete(k);
  return out;
}
