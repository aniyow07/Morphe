// The right pane: sticky file header, then the unified diff (or a Markdown preview).
//
// Long diffs render lazily in fixed-size chunks: placeholders with exact heights stand in
// until a chunk scrolls near the viewport, so the DOM stays small and scroll position is
// stable while files change underneath.
import { api, type FileDiff, type FileEntry, type Hunk, type Line } from "../api";
import { esc, fmt, h, icon, modKey, STATUS_LABEL } from "../dom";
import { highlightLines, loadLanguage, readyLanguage, type Seg } from "../highlight";
import { isMarkdown, renderMarkdown } from "../markdown";
import { changed, savePrefs, splitPath, state, viewState } from "../state";

const CHUNK = 200;
const ROW_H = 20;
const HIGHLIGHT_MAX_LINES = 5000;
const HIGHLIGHT_MAX_LINE_LEN = 2000;
const EAGER_WRAP_LINES = 3000;

interface Chunk {
  el: HTMLElement;
  lines: Line[];
  /** Per-line syntax segments, filled when the chunk renders. */
  segs: (Seg[] | null)[] | null;
  hunk: number;
  offset: number; // index of the first line within its hunk (or gap)
  filled: boolean;
}

export function diffView(actions: { toggleViewed: (path: string) => void }) {
  const header = h("div", { class: "fh" });
  const scroller = h("div", { class: "diff-scroll", tabindex: "-1" });
  const el = h("section", { class: "pane" }, header, scroller);

  let gen = 0;
  let current: { path: string; diff: FileDiff | null; mode: "diff" | "preview" } | null = null;
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
    const f = current && state.files.get(current.path);
    header.hidden = !f;
    if (!f) return;
    const { dir, name } = splitPath(f.path);
    const vs = viewState(f);
    const md = isMarkdown(f.path) && f.kind === "text";
    const tags = [
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
      (md
        ? `<span class="seg" role="group" aria-label="View mode"><button data-mode="diff" aria-pressed="${!state.prefs.mdPreview}" data-tip="Show diff">${icon.code}<span>Diff</span></button><button data-mode="preview" aria-pressed="${state.prefs.mdPreview}" data-tip="Show rendered Markdown">${icon.preview}<span>Preview</span></button></span>`
        : "") +
      `<button class="tgl wrap-tgl" aria-pressed="${state.prefs.wrap}" aria-label="Wrap long lines" data-tip="Wrap long lines">${icon.wrap}</button>` +
      `<button class="viewed-box${vs === "viewed" ? " on" : ""}" role="checkbox" aria-checked="${vs === "viewed"}" data-tip="Mark as viewed" data-kbd="V"><span class="box">${icon.check}</span>Viewed</button>` +
      `</span>`;
    // Only touch the DOM when something visible changed, so hover and tooltips survive.
    if (html !== headerHtml) header.innerHTML = headerHtml = html;
  }

  /** Show `path`. With `refresh`, keep the scroll position anchored to the same line. */
  async function show(path: string | null, refresh: boolean) {
    const my = ++gen;
    if (!path || !state.files.has(path)) {
      current = null;
      renderHeader();
      renderEmpty();
      return;
    }
    const f = state.files.get(path)!;
    const mode = isMarkdown(path) && state.prefs.mdPreview && f.kind === "text" ? "preview" : "diff";
    const same = current?.path === path && current.mode === mode;
    const anchor = refresh && same ? captureAnchor() : null;
    const keepTop = refresh && same ? scroller.scrollTop : 0;
    current = { path, diff: same ? current!.diff : null, mode };
    renderHeader();

    // Only show the skeleton when loading is actually slow, and never on live refreshes.
    const skel = !same ? setTimeout(() => my === gen && renderSkeleton(), 120) : 0;

    if (mode === "preview") {
      const text = await api.getFileText(path).catch(() => null);
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

    const diff = await api.getDiff(path).catch(() => null);
    clearTimeout(skel);
    if (my !== gen) return;
    current.diff = diff;
    renderDiff(f, diff);
    if (anchor) restoreAnchor(anchor);
    else if (!refresh || !same) scroller.scrollTop = 0;

    if (diff?.kind === "text" && !readyLanguage(path) && countLines(diff) <= HIGHLIGHT_MAX_LINES) {
      const lang = await loadLanguage(path);
      if (lang && my === gen) {
        const a = captureAnchor();
        renderDiff(f, diff);
        if (a) restoreAnchor(a);
      }
    }
  }

  function resetBody() {
    chunks = [];
    hl = null;
    scroller.replaceChildren();
    scroller.classList.toggle("wrap", state.prefs.wrap);
  }

  function renderEmpty() {
    resetBody();
    if (state.screen !== "repo") return;
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
    const eager = state.prefs.wrap && total <= EAGER_WRAP_LINES;

    let prevNewEnd = 0;
    let prevOldEnd = 0;
    diff.hunks.forEach((hk, i) => {
      const gapStart = prevNewEnd + 1;
      const gapEnd = hk.newStart - 1;
      if (gapEnd >= gapStart && f.status !== "D") {
        body.append(gapRow(gapStart, gapEnd, prevOldEnd - prevNewEnd));
      }
      body.append(hunkRow(hk));
      for (let off = 0; off < hk.lines.length; off += CHUNK) {
        const lines = hk.lines.slice(off, off + CHUNK);
        const c: Chunk = { el: h("div", { class: "chunk" }), lines, segs: null, hunk: i, offset: off, filled: false };
        c.el.style.height = `${lines.length * ROW_H}px`;
        chunks.push(c);
        body.append(c.el);
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
  }

  function hunkRow(hk: Hunk) {
    const range = `@@ -${hk.oldStart},${hk.oldLines} +${hk.newStart},${hk.newLines} @@`;
    return h("div", { class: "hunk", role: "row", html: `<span class="hunk-range">${range}</span><span class="hunk-sec">${esc(hk.section)}</span>` });
  }

  function gapRow(start: number, end: number, delta: number) {
    const n = end - start + 1;
    return h(
      "button",
      { class: "gap", "data-start": start, "data-end": end, "data-delta": delta, "data-tip": "Show unchanged lines" },
      h("span", { class: "gap-label" }, `${fmt.format(n)} unchanged ${n === 1 ? "line" : "lines"}`),
    );
  }

  async function expandGap(gap: HTMLElement) {
    if (!current) return;
    const my = gen;
    const start = Number(gap.dataset.start);
    const end = Number(gap.dataset.end);
    const delta = Number(gap.dataset.delta);
    const texts = await api.getLines(current.path, start, end).catch(() => null);
    if (my !== gen || !texts || !gap.isConnected) return;
    const lines: Line[] = texts.map((t, i) => ({ k: " ", n: start + i, o: start + i + delta, t }));
    const segs = hl && lines.length <= HIGHLIGHT_MAX_LINES ? highlightLines(texts, hl.lang) : null;
    const frag = document.createDocumentFragment();
    for (let off = 0; off < lines.length; off += CHUNK) {
      const c: Chunk = { el: h("div", { class: "chunk" }), lines: lines.slice(off, off + CHUNK), segs: segs ? segs.slice(off, off + CHUNK) : null, hunk: -1, offset: 0, filled: false };
      c.el.style.height = `${c.lines.length * ROW_H}px`;
      chunks.push(c);
      frag.append(c.el);
    }
    gap.replaceWith(frag);
    // Keep chunks in document order; fillVisible and anchoring rely on it.
    chunks.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    fillVisible();
  }

  function fill(c: Chunk) {
    if (c.filled) return;
    c.filled = true;
    const segs = c.segs ?? (c.hunk >= 0 ? hunkSegs(c) : null);
    let html = "";
    c.lines.forEach((l, i) => (html += rowHtml(l, segs?.[i] ?? null)));
    c.el.innerHTML = html;
    c.el.style.height = "";
  }

  /** Syntax segments for a hunk chunk: each side of the hunk is highlighted as one block. */
  function hunkSegs(c: Chunk): (Seg[] | null)[] | null {
    if (!hl || !current?.diff) return null;
    const hk = current.diff.hunks[c.hunk];
    let side = hl.sides.get(c.hunk);
    if (!side) {
      const oldT: string[] = [];
      const newT: string[] = [];
      const oi: number[] = [];
      const ni: number[] = [];
      for (const l of hk.lines) {
        const long = l.t.length > HIGHLIGHT_MAX_LINE_LEN;
        oi.push(l.k !== "+" && !long ? oldT.push(l.t) - 1 : -1);
        ni.push(l.k !== "-" && !long ? newT.push(l.t) - 1 : -1);
      }
      side = { old: highlightLines(oldT, hl.lang), neu: highlightLines(newT, hl.lang), oi, ni };
      hl.sides.set(c.hunk, side);
    }
    return c.lines.map((l, i) => {
      const j = c.offset + i;
      const idx = l.k === "-" ? side!.oi[j] : side!.ni[j];
      return idx < 0 ? null : (l.k === "-" ? side!.old : side!.neu)[idx] ?? null;
    });
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
      const i = c.lines.findIndex((l) => (a.n !== undefined && l.n !== undefined ? l.n >= a.n : a.o !== undefined && l.o !== undefined && l.o >= a.o));
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
