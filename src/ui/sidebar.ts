// Sidebar: Changes / History switch, filter box, view toggles, and the keyed file list.
// In history mode the commit panel sits above the file list, which then lists the
// selected commit's files.
import { api, type FileEntry } from "../api";
import { esc, fmt, h, icon, modKey, STATUS_LABEL } from "../dom";
import { changed, savePrefs, splitPath, state, subscribe, treeMode, viewState, visibleFiles, type Mode, type Prefs } from "../state";
import { historyPanel, type HistoryActions } from "./history";
import { toggleDir, treeRows } from "./tree";

export interface SidebarActions extends HistoryActions {
  select: (path: string) => void;
  toggleViewed: (path: string) => void;
  setMode: (mode: Mode) => void;
  setBase: (branch: string | null) => void;
}

export function sidebar(actions: SidebarActions) {
  const modeBtn = (mode: Mode, label: string) =>
    h("button", { "data-mode": mode, "aria-pressed": "false", onclick: () => actions.setMode(mode) }, h("span", {}, label), h("span", { class: "mode-count" }));
  const modes = { changes: modeBtn("changes", "Changes"), history: modeBtn("history", "History") };
  const modeSwitch = h("div", { class: "seg sb-mode", role: "group", "aria-label": "Sidebar view" }, modes.changes, modes.history);
  const hist = historyPanel(actions);

  const filter = h("input", {
    class: "filter-input",
    type: "text",
    placeholder: "Filter files",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Filter files",
  });
  filter.addEventListener("input", () => {
    state.filter = filter.value;
    changed();
  });
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (filter.value) {
        filter.value = "";
        state.filter = "";
        changed();
      } else filter.blur();
      e.stopPropagation();
    } else if (e.key === "Enter" || e.key === "ArrowDown") {
      list.focus();
      e.preventDefault();
    }
  });

  const toggle = (key: keyof Prefs, ic: string, label: string, kbd?: string) => {
    const b = h("button", { class: "tgl", html: ic, "aria-label": label, "data-tip": label, "data-kbd": kbd, "aria-pressed": "false" });
    b.addEventListener("click", () => {
      (state.prefs[key] as boolean) = !state.prefs[key];
      savePrefs();
      changed();
      document.dispatchEvent(new CustomEvent("morphe:pref", { detail: key }));
    });
    return { b, key };
  };
  const toggles = [
    toggle("allFiles", icon.tree, "Show all files"),
    toggle("follow", icon.follow, "Follow latest edit"),
    toggle("hideViewed", icon.eyeOff, "Hide viewed files"),
    toggle("group", icon.group, "Group by folder"),
  ];

  // What Changes compares against: the last commit, or where this branch split from another.
  const baseSel = h("select", { class: "base-select", "aria-label": "Compare changes against" }) as HTMLSelectElement;
  const fillBase = async () => {
    const branches = await api.listBranches().catch(() => []);
    const opts = [`<option value="">Last commit (HEAD)</option>`].concat(
      branches.filter((b) => !b.current && b.name !== "HEAD").map((b) => `<option value="${esc(b.name)}">Since branching from ${esc(b.name)}</option>`),
    );
    baseSel.innerHTML = opts.join("");
    baseSel.value = state.base ?? "";
    // Nothing to compare with in a single-branch repo, so don't show the control.
    baseRow.hidden = opts.length === 1 && !state.base;
  };
  baseSel.addEventListener("pointerdown", fillBase);
  baseSel.addEventListener("focus", fillBase);
  baseSel.addEventListener("change", () => actions.setBase(baseSel.value || null));
  const baseRow = h("label", { class: "sb-base", "data-tip": "Compare against" }, h("span", { class: "sb-base-l" }, "Compare with"), baseSel);
  fillBase();
  let baseRoot = "";
  subscribe(() => {
    if (state.root !== baseRoot || baseSel.value !== (state.base ?? "")) {
      baseRoot = state.root;
      fillBase();
    }
  });

  const list = h("div", { class: "file-list", role: "listbox", tabindex: "0" });
  const emptyNote = h("div", { class: "list-note" });

  const root = h(
    "aside",
    { class: "sidebar" },
    h("div", { class: "sb-top" }, modeSwitch),
    hist.el,
    h(
      "div",
      { class: "sb-head" },
      h("label", { class: "filter" }, h("span", { class: "filter-icon", html: icon.search }), filter, h("kbd", { class: "filter-kbd" }, "/")),
      h("div", { class: "sb-tools" }, ...toggles.map((t) => t.b), h("span", { class: "sb-hint", "data-tip": "Jump to file", "data-kbd": `${modKey}+P` }, `${modKey} P`)),
      baseRow,
    ),
    list,
    emptyNote,
  );

  list.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const dir = t.closest<HTMLElement>(".tdir");
    if (dir) return toggleDir(dir.dataset.dir!);
    const grp = t.closest<HTMLElement>(".grp");
    if (grp) {
      const dir = grp.dataset.dir!;
      state.collapsed.has(dir) ? state.collapsed.delete(dir) : state.collapsed.add(dir);
      changed();
      return;
    }
    const row = t.closest<HTMLElement>(".row");
    if (!row) return;
    if (t.closest(".vw")) actions.toggleViewed(row.dataset.path!);
    else actions.select(row.dataset.path!);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1, actions.select);
    }
  });

  const rows = new Map<string, HTMLElement>();
  const sigs = new Map<string, string>();
  const groups = new Map<string, HTMLElement>();

  subscribe(() => {
    const historyMode = state.mode === "history";
    root.classList.toggle("is-history", historyMode);
    for (const [mode, b] of Object.entries(modes)) b.setAttribute("aria-pressed", String(state.mode === mode));
    modes.changes.lastElementChild!.textContent = state.work.size ? fmt.format(state.work.size) : "";
    list.setAttribute("aria-label", historyMode ? "Files in this commit" : "Changed files");
    for (const t of toggles) {
      t.b.setAttribute("aria-pressed", String(state.prefs[t.key]));
      // Follow and viewed are about the working tree; grouping and hiding don't apply to the tree.
      t.b.hidden = historyMode ? t.key !== "group" : state.prefs.allFiles && (t.key === "group" || t.key === "hideViewed");
    }
    if (filter.value !== state.filter) filter.value = state.filter;

    if (state.screen === "loading") {
      list.replaceChildren(...skeletonRows());
      rows.clear();
      sigs.clear();
      groups.clear();
      emptyNote.hidden = true;
      return;
    }
    list.querySelectorAll(".sk-row").forEach((n) => n.remove());

    if (treeMode()) {
      reconcile(treeRows());
      emptyNote.hidden = true;
      const sel = list.querySelector<HTMLElement>('.tfile[aria-selected="true"]');
      if (sel) {
        list.setAttribute("aria-activedescendant", sel.id);
        if (state.selected !== lastRevealed) sel.scrollIntoView({ block: "nearest" });
      }
      lastRevealed = state.selected;
      return;
    }
    lastRevealed = null;

    const files = visibleFiles();
    const nodes: HTMLElement[] = [];
    let lastDir: string | null = null;
    const counts = new Map<string, number>();
    if (state.prefs.group) for (const f of files) counts.set(splitPath(f.path).dir, (counts.get(splitPath(f.path).dir) ?? 0) + 1);

    for (const f of files) {
      const { dir } = splitPath(f.path);
      if (state.prefs.group && dir !== lastDir) {
        lastDir = dir;
        nodes.push(groupRow(dir, counts.get(dir) ?? 0));
      }
      if (state.prefs.group && state.collapsed.has(dir)) continue;
      nodes.push(fileRow(f));
    }

    reconcile(nodes);
    for (const p of rows.keys()) if (!state.files.has(p)) (rows.delete(p), sigs.delete(p));

    emptyNote.hidden = files.length > 0 || state.files.size === 0;
    if (historyMode && state.history.open && !state.history.open.files.length) {
      emptyNote.hidden = false;
      emptyNote.textContent = "No file changes in this commit";
      return;
    }
    emptyNote.textContent = state.filter ? `No files match “${state.filter}”` : "All files are marked viewed";

    const sel = state.selected && rows.get(state.selected);
    if (sel && sel.isConnected) sel.scrollIntoView({ block: "nearest" });
  });

  /** Reconcile in place so hover, focus and running animations survive updates. */
  function reconcile(nodes: HTMLElement[]) {
    const keep = new Set(nodes);
    for (const child of Array.from(list.children)) if (!keep.has(child as HTMLElement)) child.remove();
    nodes.forEach((n, i) => {
      if (list.children[i] !== n) list.insertBefore(n, list.children[i] ?? null);
    });
  }
  let lastRevealed: string | null = null;

  function groupRow(dir: string, count: number) {
    let g = groups.get(dir);
    if (!g) {
      g = h("div", { class: "grp", "data-dir": dir, role: "presentation" });
      groups.set(dir, g);
    }
    const sig = `${state.collapsed.has(dir)}|${count}`;
    if (g.dataset.sig !== sig) {
      g.dataset.sig = sig;
      g.classList.toggle("collapsed", state.collapsed.has(dir));
      g.innerHTML = `<span class="chev">${icon.chevron}</span><span class="grp-name">${esc(dir || "/")}</span><span class="grp-count">${count}</span>`;
    }
    return g;
  }

  function fileRow(f: FileEntry) {
    let row = rows.get(f.path);
    if (!row) {
      row = h("div", { class: "row", role: "option", "data-path": f.path, id: `row-${rows.size}` });
      rows.set(f.path, row);
    }
    const hist = state.mode === "history";
    const vs = viewState(f);
    const sel = f.path === state.selected;
    const upd = !hist && state.updated.has(f.path);
    const sig = [f.status, f.staged, f.additions, f.deletions, f.kind, vs, sel, upd, state.prefs.group, f.oldPath, hist].join("|");
    if (sigs.get(f.path) !== sig) {
      sigs.set(f.path, sig);
      const { dir, name } = splitPath(f.path);
      row.setAttribute("aria-selected", String(sel));
      row.classList.toggle("is-viewed", vs === "viewed");
      row.classList.toggle("is-updated", upd);
      const staged =
        f.staged === "full"
          ? `<span class="stg full" data-tip="Staged"></span>`
          : f.staged === "partial"
            ? `<span class="stg partial" data-tip="Partially staged"></span>`
            : "";
      const counts =
        f.kind === "text"
          ? `${f.additions ? `<span class="add">+${fmt.format(f.additions)}</span>` : ""}${f.deletions ? `<span class="del">−${fmt.format(f.deletions)}</span>` : ""}`
          : `<span class="bin">${f.kind === "binary" ? "bin" : "large"}</span>`;
      const vwLabel = vs === "viewed" ? "Mark as not viewed" : "Mark as viewed";
      row.innerHTML =
        `<span class="st st-${f.status}" data-tip="${STATUS_LABEL[f.status]}">${f.status}</span>` +
        `<span class="nm"><span class="fn">${esc(name)}</span>${!state.prefs.group && dir ? `<span class="dr">${esc(dir)}</span>` : ""}</span>` +
        `<span class="mk">${vs === "stale" ? `<span class="stale" data-tip="Changed since viewed"></span>` : ""}${staged}<span class="upd" data-tip="Updated"></span></span>` +
        `<span class="ct">${counts}</span>` +
        (hist ? "" : `<button class="vw${vs === "viewed" ? " on" : ""}" tabindex="-1" aria-label="${vwLabel}" data-tip="${vwLabel}" data-kbd="V">${icon.check}</button>`);
      if (sel) list.setAttribute("aria-activedescendant", row.id);
    }
    return row;
  }

  return {
    el: root,
    focusCommits: hist.focusList,
    focusFilter() {
      filter.focus();
      filter.select();
    },
    /** Soft accent trace on rows that just changed on disk. */
    pulse(paths: string[]) {
      for (const p of paths) {
        const r = rows.get(p);
        if (!r) continue;
        r.classList.remove("pulse");
        void r.offsetWidth;
        r.classList.add("pulse");
      }
    },
  };
}

/** Move the selection through the visible list (j/k, arrows). */
export function step(dir: 1 | -1, select: (p: string) => void) {
  const files = visibleFiles().filter((f) => !(state.prefs.group && state.collapsed.has(splitPath(f.path).dir)));
  if (!files.length) return;
  const i = files.findIndex((f) => f.path === state.selected);
  const next = i < 0 ? (dir > 0 ? 0 : files.length - 1) : Math.min(files.length - 1, Math.max(0, i + dir));
  select(files[next].path);
}

function skeletonRows() {
  return Array.from({ length: 9 }, (_, i) =>
    h("div", { class: "sk-row", style: `--w:${[62, 48, 74, 55, 40, 68, 52, 60, 44][i]}%` }, h("span", { class: "sk sk-glyph" }), h("span", { class: "sk sk-line" })),
  );
}
