// Ctrl/Cmd+P file jumper.
import { esc, h } from "../dom";
import { splitPath, state } from "../state";

export function palette(select: (path: string) => void) {
  const input = h("input", { class: "pal-input", type: "text", placeholder: "Jump to file", spellcheck: "false", autocomplete: "off", "aria-label": "Jump to file" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const box = h("div", { class: "pal", role: "dialog", "aria-label": "Jump to file", "aria-modal": "true" }, input, list);
  const scrim = h("div", { class: "pal-scrim", hidden: true }, box);
  let results: string[] = [];
  let active = 0;
  let restoreFocus: Element | null = null;

  scrim.addEventListener("mousedown", (e) => e.target === scrim && close());
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % Math.max(1, results.length);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) choose(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  list.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".pal-opt");
    if (opt) choose(opt.dataset.path!);
  });

  function choose(path: string) {
    close();
    select(path);
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    results = rank(Array.from(state.files.keys()), q).slice(0, 50);
    list.innerHTML = results.length
      ? results
          .map((p, i) => {
            const f = state.files.get(p)!;
            const { dir, name } = splitPath(p);
            return `<div class="pal-opt" role="option" data-path="${esc(p)}" aria-selected="${i === active}"><span class="st st-${f.status}">${f.status}</span><span class="fn">${esc(name)}</span><span class="dr">${esc(dir)}</span></div>`;
          })
          .join("")
      : `<div class="pal-none">No changed file matches “${esc(input.value)}”</div>`;
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function open() {
    restoreFocus = document.activeElement;
    scrim.hidden = false;
    input.value = "";
    active = 0;
    render();
    input.focus();
  }

  function close() {
    scrim.hidden = true;
    (restoreFocus as HTMLElement | null)?.focus?.();
  }

  return { el: scrim, open, close, get isOpen() { return !scrim.hidden; } };
}

/** Subsequence match, scored to prefer filename hits and contiguous runs. */
function rank(paths: string[], q: string): string[] {
  if (!q) return paths.sort();
  const scored: [number, string][] = [];
  for (const p of paths) {
    const s = score(p.toLowerCase(), q);
    if (s > 0) scored.push([s, p]);
  }
  return scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1])).map((x) => x[1]);
}

function score(path: string, q: string): number {
  const nameStart = path.lastIndexOf("/") + 1;
  let s = 0;
  let pi = 0;
  let run = 0;
  for (const ch of q) {
    const i = path.indexOf(ch, pi);
    if (i < 0) return 0;
    run = i === pi ? run + 1 : 1;
    s += run * 2 + (i >= nameStart ? 3 : 0) + (i === nameStart ? 4 : 0);
    pi = i + 1;
  }
  return s - path.length * 0.01;
}
