// The right pane: sticky file header, then the unified diff (or a Markdown preview).
//
// Long diffs render lazily in fixed-size chunks: placeholders with exact heights stand in
// until a chunk scrolls near the viewport, so the DOM stays small and scroll position is
// stable while files change underneath.
import { source, type FileDiff, type FileEntry, type Hunk, type Line } from "../api";
import { copyText, esc, fmt, h, icon, modKey, STATUS_LABEL } from "../dom";
import { highlightLines, loadLanguage, readyLanguage, type Seg } from "../highlight";
import { isMarkdown, renderMarkdown } from "../markdown";
import { changed, savePrefs, shownCommit, splitPath, state, treeMode, viewState } from "../state";

const CHUNK = 200;
/** Code line height in px, from the --lh-code token (it follows the text size setting). */
const rowH = () => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--lh-code")) || 20;
const HIGHLIGHT_MAX_LINES = 5000;
const OPEN_BTN =
  `<button class="tgl copy-tgl" aria-label="Copy path" data-tip="Copy path (Shift-click for the full path)" data-kbd="C">${icon.copy}</button>` +
  `<button class="tgl open-tgl" aria-label="Open in editor" data-tip="Open in editor (or double-click a line)" data-kbd="O">${icon.external}</button>`;
const MAP_BUCKETS = 300;
const HIGHLIGHT_MAX_LINE_LEN = 2000;
const EAGER_WRAP_LINES = 3000;

/** One visual row. Unified rows use `a` only; split rows put old on `a`, new on `b`.
 *  `aj`/`bj` index into the hunk's lines (for syntax segments). */
interface Row {
  a?: Line;
  aj?: number;
  b?: Line;
  bj?: number;
}

interface Chunk {
  el: HTMLElement;
  rows: Row[];
  /** Syntax segments for expanded context rows (same text on both sides). */
  segs: (Seg[] | null)[] | null;
  hunk: number; // -1 for expanded context
  filled: boolean;
}

type Pos = [chunk: number, row: number];

export function diffView(actions: {
  toggleViewed: (path: string) => void;
  openInEditor: (path: string, line: number | null) => void;
  notify: (msg: string) => void;
}) {
  const header = h("div", { class: "fh" });
  const scroller = h("div", { class: "diff-scroll", tabindex: "-1" });
  const findInput = h("input", { class: "find-input", type: "text", placeholder: "Find in file", spellcheck: "false", autocomplete: "off", "aria-label": "Find in file" });
  const findCount = h("span", { class: "find-count", "aria-live": "polite" });
  const findBtn = (cls: string, label: string, ic: string) => h("button", { class: `tgl ${cls}`, "aria-label": label, "data-tip": label, html: ic });
  const findBar = h(
    "div",
    { class: "find", hidden: true, role: "search" },
    findInput,
    findCount,
    findBtn("find-prev", "Previous match (Shift+Enter)", icon.up),
    findBtn("find-next", "Next match (Enter)", icon.down),
    findBtn("find-close", "Close (Esc)", icon.close),
  );
  // The change map: where additions and removals sit in the file, beside the scrollbar.
  const mapMarks = h("div", { class: "map-marks" });
  const mapView = h("div", { class: "map-view" });
  const map = h("div", { class: "map", hidden: true, "aria-hidden": "true" }, mapMarks, mapView);
  // Actions for the selected lines.
  const selLabel = h("span", { class: "selbar-l" });
  const selBar = h(
    "div",
    { class: "selbar", hidden: true, role: "toolbar", "aria-label": "Selected lines" },
    selLabel,
    h("button", { class: "selbar-b primary", "data-act": "ref", "data-tip": "Copy a file and line reference to paste into Claude Code", "data-kbd": "C" }, "Copy reference"),
    h("button", { class: "selbar-b", "data-act": "code" }, "Copy code"),
    h("button", { class: "selbar-b", "data-act": "open" }, "Open in editor"),
    h("button", { class: "tgl", "data-act": "clear", "aria-label": "Clear selection", "data-tip": "Clear selection", "data-kbd": "Esc", html: icon.close }),
  );
  const el = h("section", { class: "pane" }, header, findBar, h("div", { class: "pane-body" }, scroller, map), selBar);

  // ---- find in file: searches the rows on screen's model (hidden unchanged regions are not searched) ----
  let hits: { c: number; r: number }[] = [];
  let hitAt = -1;
  let hitEl: HTMLElement | null = null;
  function runFind(jump = true) {
    const q = findInput.value.toLowerCase();
    hits = [];
    if (q) {
      chunks.forEach((c, ci) =>
        c.rows.forEach((r, ri) => {
          if (r.a?.t.toLowerCase().includes(q) || r.b?.t.toLowerCase().includes(q)) hits.push({ c: ci, r: ri });
        }),
      );
    }
    hitAt = hits.length && jump ? 0 : -1;
    if (jump) showHit();
    else findCount.textContent = findInput.value ? `${hits.length} ${hits.length === 1 ? "match" : "matches"}` : "";
  }
  function showHit() {
    hitEl?.classList.remove("find-hit");
    hitEl = null;
    findCount.textContent = findInput.value ? (hits.length ? `${hitAt + 1} of ${hits.length}` : "No matches") : "";
    const hit = hits[hitAt];
    if (!hit) return;
    const c = chunks[hit.c];
    fill(c);
    hitEl = c.el.children[hit.r] as HTMLElement | undefined ?? null;
    if (!hitEl) return;
    hitEl.classList.add("find-hit");
    hitEl.scrollIntoView({ block: "center" });
    fillVisible();
  }
  function stepFind(d: 1 | -1) {
    if (!hits.length) return;
    hitAt = (hitAt + d + hits.length) % hits.length;
    showHit();
  }
  function openFind() {
    findBar.hidden = false;
    findInput.focus();
    findInput.select();
    if (findInput.value) runFind();
  }
  function closeFind() {
    findBar.hidden = true;
    hitEl?.classList.remove("find-hit");
    hitEl = null;
    scroller.focus();
  }
  findInput.addEventListener("input", () => runFind());
  findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") (hitAt < 0 ? runFind() : stepFind(e.shiftKey ? -1 : 1));
    else if (e.key === "Escape") closeFind();
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  findBar.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".find-prev")) stepFind(-1);
    else if (t.closest(".find-next")) stepFind(1);
    else if (t.closest(".find-close")) closeFind();
  });

  // Double-click a line to open the file there in the editor.
  scroller.addEventListener("dblclick", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-n], [data-o]");
    if (!row || !current || current.mode !== "diff") return;
    const n = row.dataset.n ?? row.dataset.o;
    actions.openInEditor(current.path, n ? Number(n) : null);
  });

  // ---- line selection: click a line number, Shift-click to extend ----
  let sel: { a: Pos; b: Pos } | null = null;
  const chunkOf = new WeakMap<Element, Chunk>();
  const before = (x: Pos, y: Pos) => x[0] < y[0] || (x[0] === y[0] && x[1] <= y[1]);
  const selRange = (): [Pos, Pos] | null => (sel ? (before(sel.a, sel.b) ? [sel.a, sel.b] : [sel.b, sel.a]) : null);
  function paintSel(c: Chunk, ci: number) {
    const r = selRange();
    if (!r || !c.filled || ci < r[0][0] || ci > r[1][0]) return;
    const from = ci === r[0][0] ? r[0][1] : 0;
    const to = ci === r[1][0] ? r[1][1] : c.rows.length - 1;
    for (let i = from; i <= to; i++) c.el.children[i]?.classList.add("sel");
  }
  function selInfo() {
    const r = selRange();
    if (!r || !current) return null;
    let lo = Infinity;
    let hi = -Infinity;
    let oLo = Infinity;
    let oHi = -Infinity;
    const text: string[] = [];
    for (let ci = r[0][0]; ci <= r[1][0]; ci++) {
      const c = chunks[ci];
      if (!c) break;
      const from = ci === r[0][0] ? r[0][1] : 0;
      const to = ci === r[1][0] ? r[1][1] : c.rows.length - 1;
      for (let i = from; i <= to; i++) {
        const row = c.rows[i];
        if (!row) continue;
        const n = row.b?.n ?? row.a?.n;
        const o = row.a?.o ?? row.b?.o;
        if (n !== undefined) (lo = Math.min(lo, n)), (hi = Math.max(hi, n));
        else if (o !== undefined) (oLo = Math.min(oLo, o)), (oHi = Math.max(oHi, o));
        text.push((row.b ?? row.a!).t);
      }
    }
    const removed = lo === Infinity;
    if (removed) (lo = oLo), (hi = oHi);
    if (lo === Infinity) return null;
    return { lo, hi, removed, text: text.join("\n"), ref: `@${current.path}#L${lo}${hi > lo ? `-${hi}` : ""}` };
  }
  function renderSel() {
    scroller.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
    chunks.forEach(paintSel);
    const info = selInfo();
    selBar.hidden = !info;
    if (info) selLabel.textContent = `${info.removed ? "Removed line" : "Line"}${info.hi > info.lo ? `s ${fmt.format(info.lo)} to ${fmt.format(info.hi)}` : ` ${fmt.format(info.lo)}`}`;
  }
  function clearSel() {
    if (!sel) return false;
    sel = null;
    renderSel();
    return true;
  }
  scroller.addEventListener("click", (e) => {
    const no = (e.target as HTMLElement).closest(".no");
    const row = no?.closest(".ln, .sr");
    const c = row?.parentElement && chunkOf.get(row.parentElement);
    if (!row || !c) return;
    const pos: Pos = [chunks.indexOf(c), Array.prototype.indexOf.call(c.el.children, row)];
    if (e.shiftKey && sel) sel.b = pos;
    else if (sel && sel.a[0] === pos[0] && sel.a[1] === pos[1] && sel.b[0] === pos[0] && sel.b[1] === pos[1]) sel = null;
    else sel = { a: pos, b: pos };
    renderSel();
  });
  async function copy(text: string, what: string) {
    actions.notify((await copyText(text)) ? `Copied ${what}` : "Couldn't reach the clipboard");
  }
  /** Copy a reference to the selected lines, or the file's path with nothing selected. */
  function copyRef(full = false) {
    if (!current) return;
    const info = selInfo();
    if (info) copy(info.ref, info.ref);
    else {
      const p = full ? `${state.root.replace(/[\\/]+$/, "")}/${current.path}` : current.path;
      copy(p, p);
    }
  }
  selBar.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    const info = selInfo();
    if (!act || !current) return;
    if (act === "clear") clearSel();
    else if (!info) return;
    else if (act === "ref") copy(info.ref, info.ref);
    else if (act === "code") copy(info.text, info.hi > info.lo ? `${fmt.format(info.text.split("\n").length)} lines` : "1 line");
    else if (act === "open") actions.openInEditor(current.path, info.lo);
  });

  // ---- change map and stepping between changes ----
  /** The first row of every run of changed lines, in document order. */
  let blocks: { c: Chunk; r: number }[] = [];
  let lastJump = { i: -1, top: -1 };
  function buildMap() {
    blocks = [];
    lastJump = { i: -1, top: -1 };
    const body = scroller.querySelector(".diff:not(.plain)");
    if (!body) {
      map.hidden = true;
      return;
    }
    // Rows count one unit each, as does every separator between them.
    const kinds: number[] = []; // per unit: bit 1 = addition, bit 2 = removal
    let run = false;
    for (const child of Array.from(body.children)) {
      const c = chunkOf.get(child);
      if (!c || c.hunk < 0) {
        run = false;
        for (let i = c ? c.rows.length : 1; i > 0; i--) kinds.push(0);
        continue;
      }
      c.rows.forEach((row, r) => {
        const k = (row.a?.k === "-" ? 2 : 0) | ((row.b ?? row.a)?.k === "+" ? 1 : 0);
        if (k && !run) blocks.push({ c, r });
        run = k > 0;
        kinds.push(k);
      });
    }
    const total = kinds.length;
    const n = Math.min(total, MAP_BUCKETS);
    const buckets = new Uint8Array(n);
    kinds.forEach((k, u) => k && (buckets[Math.floor((u / total) * n)] |= k));
    let html = "";
    for (let i = 0; i < n; ) {
      const k = buckets[i];
      let j = i + 1;
      while (j < n && buckets[j] === k) j++;
      if (k) html += `<i class="m${k}" style="top:${((i / n) * 100).toFixed(2)}%;height:${(((j - i) / n) * 100).toFixed(2)}%"></i>`;
      i = j;
    }
    mapMarks.innerHTML = html;
    syncMap();
  }
  function syncMap() {
    const sh = scroller.scrollHeight;
    const ch = scroller.clientHeight;
    map.hidden = !blocks.length || sh <= ch + 4;
    if (map.hidden) return;
    mapView.style.top = `${(scroller.scrollTop / sh) * 100}%`;
    mapView.style.height = `${(ch / sh) * 100}%`;
  }
  scroller.addEventListener("scroll", syncMap, { passive: true });
  new ResizeObserver(syncMap).observe(scroller);
  map.addEventListener("pointerdown", (e) => {
    map.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent) => {
      const r = map.getBoundingClientRect();
      scroller.scrollTop = ((ev.clientY - r.top) / r.height) * scroller.scrollHeight - scroller.clientHeight / 2;
    };
    go(e);
    map.addEventListener("pointermove", go);
    map.addEventListener("pointerup", () => map.removeEventListener("pointermove", go), { once: true });
  });
  const blockY = (b: { c: Chunk; r: number }) =>
    b.c.filled ? ((b.c.el.children[b.r] as HTMLElement | undefined)?.offsetTop ?? b.c.el.offsetTop) : b.c.el.offsetTop + b.r * rowH();
  /** Scroll to the next or previous run of changed lines. False when there is none that way. */
  function stepChange(d: 1 | -1): boolean {
    if (!blocks.length) return false;
    const lead = scroller.clientHeight * 0.25;
    let i: number;
    if (lastJump.i >= 0 && Math.abs(scroller.scrollTop - lastJump.top) < 2) i = lastJump.i + d;
    else {
      const line = scroller.scrollTop + lead;
      const ys = blocks.map(blockY);
      i = ys.findIndex((y) => y > line + 2);
      if (d < 0) for (i = ys.length - 1; i >= 0 && ys[i] >= line - 2; ) i--;
    }
    const b = blocks[i];
    if (!b) return false;
    fill(b.c);
    const row = b.c.el.children[b.r] as HTMLElement | undefined;
    if (!row) return false;
    scroller.scrollTop = row.offsetTop - lead;
    fillVisible();
    lastJump = { i, top: scroller.scrollTop };
    row.classList.remove("jumped");
    void row.offsetWidth;
    row.classList.add("jumped");
    return true;
  }
  async function expandAll() {
    for (const gap of Array.from(scroller.querySelectorAll<HTMLElement>(".gap"))) await expandGap(gap);
  }

  let gen = 0;
  /** `plain`: an unchanged file opened from the "All files" tree, shown as its contents. */
  let current: { path: string; commit: string | null; diff: FileDiff | null; mode: "diff" | "preview"; plain: boolean } | null = null;
  let chunks: Chunk[] = [];
  let headerHtml = "";
  let hl: { lang: string; sides: Map<number, { old: Seg[][]; neu: Seg[][]; oi: number[]; ni: number[] }> } | null = null;

  /** Fill every chunk within ~800px of the viewport. Rect-based rather than an
   *  IntersectionObserver so it also works while the window is hidden. */
  function fillVisible() {
    const r = scroller.getBoundingClientRect();
    const lo = r.top - 800;
    const hi = r.bottom + 800;
    for (const c of chunks) {
      if (c.filled) continue;
      const b = c.el.getBoundingClientRect();
      if (b.bottom >= lo && b.top <= hi) fill(c);
      else if (b.top > hi) break;
    }
  }
  scroller.addEventListener("scroll", fillVisible, { passive: true });

  header.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (!current) return;
    if (t.closest(".open-tgl")) {
      actions.openInEditor(current.path, null);
      return;
    }
    if (t.closest(".copy-tgl")) return copyRef((e as MouseEvent).shiftKey);
    const nav = t.closest<HTMLElement>("[data-step]");
    if (nav) return void stepChange(nav.dataset.step === "1" ? 1 : -1);
    if (t.closest(".viewed-box")) {
      e.preventDefault();
      actions.toggleViewed(current.path);
    } else if (t.closest("[data-mode]")) {
      const preview = (t.closest("[data-mode]") as HTMLElement).dataset.mode === "preview";
      if (preview !== state.prefs.mdPreview) {
        state.prefs.mdPreview = preview;
        savePrefs();
        show(current.path, false);
      }
    } else if (t.closest(".split-tgl")) {
      state.prefs.split = !state.prefs.split;
      savePrefs();
      changed();
      show(current.path, true);
    } else if (t.closest(".wrap-tgl")) {
      state.prefs.wrap = !state.prefs.wrap;
      savePrefs();
      changed();
      show(current.path, true);
    }
  });

  // Markdown preview links must not navigate the app window away.
  scroller.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (a && scroller.querySelector(".md-preview")?.contains(a)) {
      e.preventDefault();
      const href = a.getAttribute("href") ?? "";
      if (href.startsWith("#")) scroller.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView();
    }
    const gap = (e.target as HTMLElement).closest<HTMLElement>(".gap");
    if (gap) expandGap(gap);
  });

  /** Render the header for the current selection (cheap; runs on every state change). */
  function renderHeader() {
    if (current?.plain) return renderPlainHeader(current.path);
    const f = current && state.files.get(current.path);
    header.hidden = !f;
    if (!f) return;
    const { dir, name } = splitPath(f.path);
    const vs = viewState(f);
    const md = isMarkdown(f.path) && f.kind === "text";
    const hist = state.mode === "history";
    const merge = hist && (state.history.open?.commit.parents ?? 0) > 1;
    const tags = hist
      ? merge
        ? `<span class="tag" data-tip="Merge commits are shown against their first parent">vs first parent</span>`
        : ""
      : [
          f.staged === "full" ? `<span class="tag">Staged</span>` : "",
          f.staged === "partial" ? `<span class="tag">Partially staged</span>` : "",
          vs === "stale" ? `<span class="tag tag-stale">Changed since viewed</span>` : "",
          state.updated.has(f.path) ? `<span class="tag tag-upd">Updated</span>` : "",
        ].join("");
    const rename = f.oldPath ? `<span class="fh-old">${esc(f.oldPath)}</span><span class="fh-arrow">→</span>` : "";
    const counts =
      f.kind === "text" ? `<span class="add">+${fmt.format(f.additions)}</span><span class="del">−${fmt.format(f.deletions)}</span>` : "";
    const html =
      `<span class="st st-${f.status}" data-tip="${STATUS_LABEL[f.status]}">${f.status}</span>` +
      `<span class="fh-path" title="${esc(f.path)}">${rename}${dir ? `<span class="dr">${esc(dir)}/</span>` : ""}<span class="fn">${esc(name)}</span></span>` +
      `<span class="fh-tags">${tags}</span>` +
      `<span class="fh-counts">${counts}</span>` +
      `<span class="fh-tools">` +
      (current!.mode === "diff" && blocks.length
        ? `<span class="fh-nav" role="group" aria-label="${fmt.format(blocks.length)} ${blocks.length === 1 ? "change" : "changes"}">` +
          `<button class="tgl" data-step="-1" aria-label="Previous change" data-tip="Previous change" data-kbd="P">${icon.up}</button>` +
          `<span class="fh-nav-n" data-tip="Changed blocks in this file">${fmt.format(blocks.length)}</span>` +
          `<button class="tgl" data-step="1" aria-label="Next change" data-tip="Next change" data-kbd="N">${icon.down}</button></span>`
        : "") +
      OPEN_BTN +
      (md
        ? `<span class="seg" role="group" aria-label="View mode"><button data-mode="diff" aria-pressed="${!state.prefs.mdPreview}" data-tip="Show diff">${icon.code}<span>Diff</span></button><button data-mode="preview" aria-pressed="${state.prefs.mdPreview}" data-tip="Show rendered Markdown">${icon.preview}<span>Preview</span></button></span>`
        : "") +
      (current!.mode === "diff"
        ? `<button class="tgl split-tgl" aria-pressed="${state.prefs.split}" aria-label="Side-by-side view" data-tip="Side-by-side view">${icon.split}</button>` +
          `<button class="tgl wrap-tgl" aria-pressed="${state.prefs.wrap || state.prefs.split}" aria-label="Wrap long lines" data-tip="${state.prefs.split ? "Lines always wrap side by side" : "Wrap long lines"}"${state.prefs.split ? " disabled" : ""}>${icon.wrap}</button>`
        : "") +
      (hist
        ? ""
        : `<button class="viewed-box${vs === "viewed" ? " on" : ""}" role="checkbox" aria-checked="${vs === "viewed"}" data-tip="Mark as viewed" data-kbd="V"><span class="box">${icon.check}</span>Viewed</button>`) +
      `</span>`;
    // Only touch the DOM when something visible changed, so hover and tooltips survive.
    if (html !== headerHtml) header.innerHTML = headerHtml = html;
  }

  function renderPlainHeader(path: string) {
    header.hidden = false;
    const { dir, name } = splitPath(path);
    const html =
      `<span class="st"></span>` +
      `<span class="fh-path" title="${esc(path)}">${dir ? `<span class="dr">${esc(dir)}/</span>` : ""}<span class="fn">${esc(name)}</span></span>` +
      `<span class="fh-tags"><span class="tag">Unchanged</span></span><span class="fh-counts"></span>` +
      `<span class="fh-tools">` +
      OPEN_BTN +
      (isMarkdown(path)
        ? `<span class="seg" role="group" aria-label="View mode"><button data-mode="diff" aria-pressed="${!state.prefs.mdPreview}" data-tip="Show source">${icon.code}<span>Source</span></button><button data-mode="preview" aria-pressed="${state.prefs.mdPreview}" data-tip="Show rendered Markdown">${icon.preview}<span>Preview</span></button></span>`
        : "") +
      (current!.mode === "diff"
        ? `<button class="tgl wrap-tgl" aria-pressed="${state.prefs.wrap}" aria-label="Wrap long lines" data-tip="Wrap long lines">${icon.wrap}</button>`
        : "") +
      `</span>`;
    if (html !== headerHtml) header.innerHTML = headerHtml = html;
  }

  /** Show `path`. With `refresh`, keep the scroll position anchored to the same line. */
  async function show(path: string | null, refresh: boolean) {
    const my = ++gen;
    if (!path || (!state.files.has(path) && !treeMode())) {
      current = null;
      renderHeader();
      renderEmpty();
      return;
    }
    const f = state.files.get(path) ?? null;
    const plain = !f;
    const commit = shownCommit();
    const mode = isMarkdown(path) && state.prefs.mdPreview && (plain || f!.kind === "text") ? "preview" : "diff";
    const same = current?.path === path && current.mode === mode && current.commit === commit && current.plain === plain;
    const anchor = refresh && same ? captureAnchor() : null;
    const keepTop = refresh && same ? scroller.scrollTop : 0;
    current = { path, commit, diff: same ? current!.diff : null, mode, plain };
    renderHeader();

    // Only show the skeleton when loading is actually slow, and never on live refreshes.
    const skel = !same ? setTimeout(() => my === gen && renderSkeleton(), 120) : 0;

    if (mode === "preview") {
      const text = await source.text(path, commit).catch(() => null);
      clearTimeout(skel);
      if (my !== gen) return;
      resetBody();
      scroller.append(
        text == null
          ? notice("This file can't be previewed.")
          : h("article", { class: "md-preview", html: renderMarkdown(text) }),
      );
      scroller.scrollTop = keepTop;
      return;
    }

    if (!f) {
      const text = await source.text(path, commit).catch(() => null);
      clearTimeout(skel);
      if (my !== gen) return;
      renderPlain(path, text);
      if (anchor) restoreAnchor(anchor);
      else if (!same) scroller.scrollTop = 0;
      if (text != null && !readyLanguage(path) && text.length < 2_000_000) {
        const lang = await loadLanguage(path);
        if (lang && my === gen) {
          const a = captureAnchor();
          renderPlain(path, text);
          if (a) restoreAnchor(a);
        }
      }
      return;
    }

    const diff = await source.diff(path, commit).catch(() => null);
    clearTimeout(skel);
    if (my !== gen) return;
    current.diff = diff;
    renderDiff(f, diff);
    renderHeader();
    if (anchor) restoreAnchor(anchor);
    else if (!refresh || !same) scroller.scrollTop = 0;

    if (diff?.kind === "text" && !readyLanguage(path) && countLines(diff) <= HIGHLIGHT_MAX_LINES) {
      const lang = await loadLanguage(path);
      if (lang && my === gen) {
        const a = captureAnchor();
        renderDiff(f, diff);
        renderHeader();
        if (a) restoreAnchor(a);
      }
    }
  }

  function resetBody() {
    chunks = [];
    sel = null;
    selBar.hidden = true;
    blocks = [];
    map.hidden = true;
    hits = [];
    hitEl = null;
    if (!findBar.hidden) queueMicrotask(() => runFind(false));
    hl = null;
    scroller.replaceChildren();
    scroller.classList.toggle("wrap", state.prefs.wrap);
  }

  function renderEmpty() {
    resetBody();
    if (state.screen !== "repo") return;
    if (state.mode === "history") {
      const open = state.history.open;
      const title = !open ? (state.history.commits.length ? "Select a commit" : "No commits yet") : open.files.length ? "Select a file" : "No file changes";
      const sub = !open
        ? state.history.commits.length
          ? "Pick a commit on the left to see what it changed."
          : "History appears here after the first commit."
        : open.files.length
          ? `Use J and K to move through files, or ${modKey}+P to jump to one.`
          : "This commit doesn't change any files compared to its first parent.";
      scroller.append(h("div", { class: "empty" }, h("h2", { class: "empty-title" }, title), h("p", { class: "empty-sub" }, sub)));
      return;
    }
    const clean = state.files.size === 0;
    scroller.append(
      h(
        "div",
        { class: "empty" },
        clean ? h("div", { class: "empty-mark", "aria-hidden": "true" }) : null,
        h("h2", { class: "empty-title" }, clean ? "Working tree clean" : "Select a file"),
        h(
          "p",
          { class: "empty-sub" },
          clean
            ? `Nothing differs from HEAD on ${state.branch}. Changes show up here as soon as files change.`
            : `Use J and K to move through files, or ${modKey}+P to jump to one.`,
        ),
      ),
    );
  }

  function renderSkeleton() {
    resetBody();
    const widths = [38, 64, 52, 71, 45, 58, 30, 66, 49, 55, 40, 62];
    scroller.append(
      h(
        "div",
        { class: "diff-skeleton", "aria-busy": "true", "aria-label": "Loading diff" },
        ...widths.map((w) => h("div", { class: "sk-diff-row" }, h("span", { class: "sk sk-no" }), h("span", { class: "sk", style: `width:${w}%` }))),
      ),
    );
  }

  function renderDiff(f: FileEntry, diff: FileDiff | null) {
    resetBody();
    if (!diff) return scroller.append(notice("This file's diff is not available yet."));
    if (diff.kind === "binary") return scroller.append(notice("Binary file. There is no text diff to show."));
    if (diff.kind === "tooLarge") return scroller.append(notice("This file is larger than 2 MB, so its diff isn't shown."));
    if (!diff.hunks.length) {
      const msg = f.status === "R" ? "Renamed without content changes." : f.status === "T" ? "File type changed." : "No content changes.";
      return scroller.append(notice(msg));
    }

    const total = countLines(diff);
    const lang = total <= HIGHLIGHT_MAX_LINES ? readyLanguage(f.path) : null;
    hl = lang ? { lang, sides: new Map() } : null;
    const body = h("div", { class: "diff", role: "table", "aria-label": `Diff of ${f.path}` });
    const split = state.prefs.split;
    // Split view always wraps, so its rows can't use exact placeholder heights.
    const eager = (state.prefs.wrap || split) && total <= EAGER_WRAP_LINES;
    body.classList.toggle("split", split);
    scroller.classList.toggle("wrap", state.prefs.wrap || split);

    let prevNewEnd = 0;
    let prevOldEnd = 0;
    diff.hunks.forEach((hk, i) => {
      const gapStart = prevNewEnd + 1;
      const gapEnd = hk.newStart - 1;
      // One separator per hunk: the collapsed lines above it, labelled with the hunk's section
      // (function or heading). The @@ ranges are in the tooltip; line numbers already show them.
      if (gapEnd >= gapStart && f.status !== "D") body.append(gapRow(gapStart, gapEnd, prevOldEnd - prevNewEnd, hk));
      else if (hk.section && i > 0) body.append(hunkRow(hk));
      const rows = split ? pairRows(hk.lines) : hk.lines.map((a, aj) => ({ a, aj }));
      for (let off = 0; off < rows.length; off += CHUNK) {
        body.append(addChunk(rows.slice(off, off + CHUNK), null, i).el);
      }
      prevNewEnd = hk.newStart + hk.newLines - 1;
      prevOldEnd = hk.oldStart + hk.oldLines - 1;
      if (hk.newLines === 0) prevNewEnd = hk.newStart; // pure deletion hunk: "+N,0" means after line N
      if (hk.oldLines === 0) prevOldEnd = hk.oldStart;
    });
    if (!diff.truncated && diff.newTotal > prevNewEnd && f.status !== "D") {
      body.append(gapRow(prevNewEnd + 1, diff.newTotal, prevOldEnd - prevNewEnd));
    }
    if (diff.truncated) {
      body.append(notice(`Diff truncated after ${fmt.format(total)} lines. Open the file in your editor to see the rest.`, "notice-inline"));
    }
    scroller.append(body);
    if (eager) chunks.forEach(fill);
    else fillVisible();
    buildMap();
  }

  /** An unchanged file: its lines with new-side numbers, no diff markers. */
  function renderPlain(path: string, text: string | null) {
    resetBody();
    if (text == null) return scroller.append(notice("Binary or larger than 2 MB, so there's nothing to show here."));
    if (text === "") return scroller.append(notice("Empty file."));
    const texts = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
    if (texts[texts.length - 1] === "") texts.pop();
    const lang = texts.length <= HIGHLIGHT_MAX_LINES ? readyLanguage(path) : null;
    const segs = lang ? highlightLines(texts, lang) : null;
    const rows: Row[] = texts.map((t, i) => ({ a: { k: " ", n: i + 1, t } }));
    const body = h("div", { class: "diff plain", role: "table", "aria-label": path });
    for (let off = 0; off < rows.length; off += CHUNK) {
      body.append(addChunk(rows.slice(off, off + CHUNK), segs ? segs.slice(off, off + CHUNK) : null, -1).el);
    }
    scroller.append(body);
    if (state.prefs.wrap && rows.length <= EAGER_WRAP_LINES) chunks.forEach(fill);
    else fillVisible();
  }

  function addChunk(rows: Row[], segs: (Seg[] | null)[] | null, hunk: number): Chunk {
    const c: Chunk = { el: h("div", { class: "chunk" }), rows, segs, hunk, filled: false };
    c.el.style.height = `${rows.length * rowH()}px`;
    chunkOf.set(c.el, c);
    chunks.push(c);
    return c;
  }

  function hunkRow(hk: Hunk) {
    const range = `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`;
    return h("div", { class: "hunk", role: "row", title: range, html: `<span class="hunk-sec">${esc(hk.section)}</span>` });
  }

  function gapRow(start: number, end: number, delta: number, hk?: Hunk) {
    const n = end - start + 1;
    const range = hk ? ` (@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@)` : "";
    return h(
      "button",
      { class: "gap", "data-start": start, "data-end": end, "data-delta": delta, "data-tip": `Show unchanged lines${range}` },
      h(
        "span",
        { class: "gap-label" },
        h("span", { class: "gap-n" }, `${fmt.format(n)} unchanged ${n === 1 ? "line" : "lines"}`),
        hk?.section ? h("span", { class: "gap-sec" }, hk.section) : "",
      ),
    );
  }

  async function expandGap(gap: HTMLElement) {
    if (!current) return;
    const my = gen;
    const start = Number(gap.dataset.start);
    const end = Number(gap.dataset.end);
    const delta = Number(gap.dataset.delta);
    const texts = await source.lines(current.path, start, end, current.commit).catch(() => null);
    if (my !== gen || !texts || !gap.isConnected) return;
    const lines: Line[] = texts.map((t, i) => ({ k: " ", n: start + i, o: start + i + delta, t }));
    const segs = hl && lines.length <= HIGHLIGHT_MAX_LINES ? highlightLines(texts, hl.lang) : null;
    const rows: Row[] = lines.map((l) => (state.prefs.split ? { a: l, b: l } : { a: l }));
    const frag = document.createDocumentFragment();
    for (let off = 0; off < rows.length; off += CHUNK) {
      frag.append(addChunk(rows.slice(off, off + CHUNK), segs ? segs.slice(off, off + CHUNK) : null, -1).el);
    }
    gap.replaceWith(frag);
    // Keep chunks in document order; fillVisible and anchoring rely on it.
    chunks.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    clearSel(); // positions shifted
    fillVisible();
    buildMap();
  }

  function fill(c: Chunk) {
    if (c.filled) return;
    c.filled = true;
    const side = c.hunk >= 0 ? hunkSides(c.hunk) : null;
    const seg = (l: Line | undefined, j: number | undefined, i: number): Seg[] | null => {
      if (!l) return null;
      if (c.segs) return c.segs[i];
      if (!side || j === undefined) return null;
      const idx = l.k === "-" ? side.oi[j] : side.ni[j];
      return idx < 0 ? null : ((l.k === "-" ? side.old : side.neu)[idx] ?? null);
    };
    let html = "";
    c.rows.forEach((r, i) => {
      html += state.prefs.split && !current?.plain
        ? splitRowHtml(r.a, seg(r.a, r.aj, i), r.b, seg(r.b, r.bj, i))
        : rowHtml(r.a!, seg(r.a, r.aj, i));
    });
    c.el.innerHTML = html;
    c.el.style.height = "";
    if (sel) paintSel(c, chunks.indexOf(c));
  }

  /** Each side of a hunk is highlighted as one block, so multi-line constructs stay correct. */
  function hunkSides(i: number) {
    if (!hl || !current?.diff) return null;
    let side = hl.sides.get(i);
    if (!side) {
      const oldT: string[] = [];
      const newT: string[] = [];
      const oi: number[] = [];
      const ni: number[] = [];
      for (const l of current.diff.hunks[i].lines) {
        const long = l.t.length > HIGHLIGHT_MAX_LINE_LEN;
        oi.push(l.k !== "+" && !long ? oldT.push(l.t) - 1 : -1);
        ni.push(l.k !== "-" && !long ? newT.push(l.t) - 1 : -1);
      }
      side = { old: highlightLines(oldT, hl.lang), neu: highlightLines(newT, hl.lang), oi, ni };
      hl.sides.set(i, side);
    }
    return side;
  }

  function captureAnchor(): { n?: number; o?: number; dy: number } | null {
    if (scroller.scrollTop < 2) return null;
    const top = scroller.getBoundingClientRect().top;
    for (const c of chunks) {
      if (!c.filled) continue;
      const r = c.el.getBoundingClientRect();
      if (r.bottom <= top) continue;
      for (const row of Array.from(c.el.children) as HTMLElement[]) {
        const rr = row.getBoundingClientRect();
        if (rr.bottom > top) {
          return { n: num(row.dataset.n), o: num(row.dataset.o), dy: rr.top - top };
        }
      }
    }
    return { dy: 0, n: undefined, o: undefined };
  }

  function restoreAnchor(a: { n?: number; o?: number; dy: number }) {
    if (a.n === undefined && a.o === undefined) return;
    // Find the first line at or after the anchor (it may have been edited away).
    for (const c of chunks) {
      const i = c.rows.findIndex((r) => {
        const n = r.b?.n ?? r.a?.n;
        const o = r.a?.o ?? r.b?.o;
        return a.n !== undefined && n !== undefined ? n >= a.n : a.o !== undefined && o !== undefined && o >= a.o;
      });
      if (i < 0) continue;
      fill(c);
      const row = c.el.children[i] as HTMLElement | undefined;
      if (!row) return;
      const top = scroller.getBoundingClientRect().top;
      scroller.scrollTop += row.getBoundingClientRect().top - top - a.dy;
      fillVisible();
      return;
    }
  }

  return {
    el,
    show,
    renderHeader,
    get path() {
      return current?.path ?? null;
    },
    scrollBy(dy: number) {
      scroller.scrollBy({ top: dy });
    },
    openFind,
    stepChange,
    expandAll,
    copyRef,
    clearSelection: clearSel,
    /** Re-render the open file in place (after a display setting changes). */
    refresh() {
      if (current) show(current.path, true);
    },
  };
}

function rowHtml(l: Line, segs: Seg[] | null): string {
  const cls = l.k === "+" ? "ln a" : l.k === "-" ? "ln d" : "ln";
  const attrs = `${l.n !== undefined ? ` data-n="${l.n}"` : ""}${l.o !== undefined ? ` data-o="${l.o}"` : ""}`;
  return (
    `<div class="${cls}" role="row"${attrs}>` +
    `<span class="no">${l.o ?? ""}</span><span class="no">${l.n ?? ""}</span>` +
    `<span class="sg">${l.k === " " ? "" : l.k === "+" ? "+" : "−"}</span>` +
    `<span class="cd">${codeHtml(l.t, segs, l.e)}</span></div>`
  );
}

function splitRowHtml(a: Line | undefined, as: Seg[] | null, b: Line | undefined, bs: Seg[] | null): string {
  const n = b?.n ?? a?.n;
  const o = a?.o ?? b?.o;
  const attrs = `${n !== undefined ? ` data-n="${n}"` : ""}${o !== undefined ? ` data-o="${o}"` : ""}`;
  const half = (l: Line | undefined, segs: Seg[] | null, no: number | undefined) => {
    if (!l) return `<span class="no e"></span><span class="sg e"></span><span class="cd e"></span>`;
    const k = l.k === "+" ? " a" : l.k === "-" ? " d" : "";
    return (
      `<span class="no${k}">${no ?? ""}</span><span class="sg${k}">${l.k === "+" ? "+" : l.k === "-" ? "−" : ""}</span>` +
      `<span class="cd${k}">${codeHtml(l.t, segs, l.e)}</span>`
    );
  };
  return `<div class="sr" role="row"${attrs}>${half(a, as, a?.o)}${half(b, bs, b?.n)}</div>`;
}

/** Pair removed lines with the added lines that follow them, side by side. */
function pairRows(lines: Line[]): Row[] {
  const rows: Row[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.k === " ") {
      rows.push({ a: l, aj: i, b: l, bj: i });
      i++;
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (i < lines.length && lines[i].k === "-") dels.push(i++);
    while (i < lines.length && lines[i].k === "+") adds.push(i++);
    for (let p = 0; p < Math.max(dels.length, adds.length); p++) {
      const d = dels[p];
      const a = adds[p];
      rows.push({ a: lines[d], aj: d, b: lines[a], bj: a });
    }
  }
  return rows;
}

/** Merge syntax segments with word-level emphasis ranges into one run of HTML. */
function codeHtml(text: string, segs: Seg[] | null, emph?: [number, number][]): string {
  if (!text) return "";
  const runs: Seg[] = segs && segs.length ? segs : [[text, ""]];
  const ranges = emph ?? [];
  let out = "";
  let pos = 0;
  let r = 0;
  for (const [t, cls] of runs) {
    let i = 0;
    while (i < t.length) {
      while (r < ranges.length && ranges[r][1] <= pos) r++;
      const inside = r < ranges.length && ranges[r][0] <= pos;
      const boundary = r < ranges.length ? (inside ? ranges[r][1] : ranges[r][0]) : Infinity;
      const take = Math.min(t.length - i, boundary - pos);
      const piece = esc(t.slice(i, i + take));
      const span = cls ? `<span class="s-${cls}">${piece}</span>` : piece;
      out += inside ? `<mark>${span}</mark>` : span;
      i += take;
      pos += take;
    }
  }
  return out;
}

function notice(text: string, extra = "") {
  return h("div", { class: `notice ${extra}` }, text);
}

function countLines(d: FileDiff) {
  let n = 0;
  for (const hk of d.hunks) n += hk.lines.length;
  return n;
}

const num = (s?: string) => (s === undefined ? undefined : Number(s));
