// The palette: Ctrl/Cmd+P jumps to a file, Ctrl/Cmd+Shift+P (or a leading ">") runs a command.
import { esc, h, icon, modKey } from "../dom";
import { fileIcon } from "../fileicons";
import { splitPath, state } from "../state";

export interface Command {
  label: string;
  /** Shortcut shown beside the command, e.g. "Ctrl+F" or "N". */
  kbd?: string;
  run: () => void;
}

type Mode = "files" | "commands";

export function palette(select: (path: string) => void, commands: () => Command[]) {
  const input = h("input", { class: "pal-input", type: "text", spellcheck: "false", autocomplete: "off" });
  const list = h("div", { class: "pal-list", role: "listbox" });
  const foot = h("div", { class: "pal-foot" });
  const box = h("div", { class: "pal", role: "dialog", "aria-modal": "true" }, h("label", { class: "pal-field" }, h("span", { class: "pal-icon" }), input), list, foot);
  const scrim = h("div", { class: "pal-scrim", hidden: true }, box);
  let files: string[] = [];
  let cmds: Command[] = [];
  let all: Command[] = [];
  let active = 0;
  let restoreFocus: Element | null = null;

  const mode = (): Mode => (input.value.startsWith(">") ? "commands" : "files");
  const count = () => (mode() === "files" ? files.length : cmds.length);

  scrim.addEventListener("mousedown", (e) => e.target === scrim && close());
  input.addEventListener("input", () => {
    active = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + count()) % Math.max(1, count());
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  list.addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLElement>(".pal-opt");
    if (opt) choose(Number(opt.dataset.i));
  });

  function choose(i: number) {
    const m = mode();
    const file = files[i];
    const cmd = cmds[i];
    if (m === "files" ? !file : !cmd) return;
    close();
    if (m === "files") select(file);
    else cmd.run();
  }

  function render() {
    const m = mode();
    const label = m === "files" ? "Jump to file" : "Run a command";
    box.setAttribute("aria-label", label);
    input.setAttribute("aria-label", label);
    input.placeholder = "Jump to a file, or type > for commands";
    (box.querySelector(".pal-icon") as HTMLElement).innerHTML = m === "files" ? icon.search : icon.command;
    const kbdHtml = (k: string) => k.split("+").map((x) => `<kbd>${esc(x)}</kbd>`).join("");
    if (m === "files") {
      const q = input.value.trim().toLowerCase();
      files = rank(Array.from(state.files.keys()), q, (p) => p).slice(0, 50);
      list.innerHTML = files.length
        ? files
            .map((p, i) => {
              const f = state.files.get(p)!;
              const { dir, name } = splitPath(p);
              return `<div class="pal-opt" role="option" data-i="${i}" aria-selected="${i === active}"><span class="st st-${f.status}">${f.status}</span>${fileIcon(p)}<span class="fn">${esc(name)}</span><span class="dr">${esc(dir)}</span></div>`;
            })
            .join("")
        : `<div class="pal-none">${state.files.size ? `No changed file matches “${esc(input.value)}”` : "No changed files to jump to"}</div>`;
    } else {
      const q = input.value.slice(1).trim().toLowerCase();
      cmds = q ? rank(all, q, (c) => c.label) : all;
      list.innerHTML = cmds.length
        ? cmds
            .map(
              (c, i) =>
                `<div class="pal-opt pal-cmd" role="option" data-i="${i}" aria-selected="${i === active}"><span class="pal-label">${esc(c.label)}</span>${c.kbd ? `<span class="pal-kbd">${kbdHtml(c.kbd)}</span>` : ""}</div>`,
            )
            .join("")
        : `<div class="pal-none">No command matches “${esc(input.value.slice(1).trim())}”</div>`;
    }
    foot.innerHTML =
      `<span><kbd>↑</kbd><kbd>↓</kbd> to move</span><span><kbd>Enter</kbd> to ${m === "files" ? "open" : "run"}</span>` +
      `<span class="pal-foot-r">${m === "files" ? `${kbdHtml(`${modKey}+Shift+P`)} commands` : `${kbdHtml(`${modKey}+P`)} files`}</span>`;
    list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }

  function open(m: Mode = "files") {
    if (scrim.hidden) restoreFocus = document.activeElement;
    scrim.hidden = false;
    all = commands();
    input.value = m === "commands" ? ">" : "";
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
function rank<T>(items: T[], q: string, text: (t: T) => string): T[] {
  if (!q) return items.slice().sort((a, b) => text(a).localeCompare(text(b)));
  const scored: [number, T][] = [];
  for (const it of items) {
    const s = score(text(it).toLowerCase(), q);
    if (s > 0) scored.push([s, it]);
  }
  return scored.sort((a, b) => b[0] - a[0] || text(a[1]).localeCompare(text(b[1]))).map((x) => x[1]);
}

function score(path: string, q: string): number {
  const nameStart = path.lastIndexOf("/") + 1;
  let s = 0;
  let pi = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === " ") continue;
    const i = path.indexOf(ch, pi);
    if (i < 0) return 0;
    run = i === pi ? run + 1 : 1;
    s += run * 2 + (i >= nameStart ? 3 : 0) + (i === nameStart ? 4 : 0);
    pi = i + 1;
  }
  return s - path.length * 0.01;
}
