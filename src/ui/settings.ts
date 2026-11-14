// Settings sheet (sliders in the title bar, or Ctrl/Cmd+,). Sections down the left, one shown at a time.
import { esc, h, icon, modKey } from "../dom";
import { changed, savePrefs, state, type Prefs } from "../state";
import { applyDisplay, setMode, setTheme, shownKind, THEMES, type ThemeDef } from "../theme";

type Section = "appearance" | "diff" | "general" | "keys";
const SECTIONS: { id: Section; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "diff", label: "Diff" },
  { id: "general", label: "General" },
  { id: "keys", label: "Shortcuts" },
];

type Opt = { v: string; label: string };
const onOff: Opt[] = [
  { v: "true", label: "On" },
  { v: "false", label: "Off" },
];

/** Settings shown as segmented controls: pref key, options, and what a change needs. */
const SEG: Partial<Record<keyof Prefs, { opts: Opt[]; display?: boolean; diff?: boolean }>> = {
  codeSize: {
    opts: [
      { v: "s", label: "Small" },
      { v: "m", label: "Default" },
      { v: "l", label: "Large" },
      { v: "xl", label: "Larger" },
    ],
    display: true,
    diff: true,
  },
  tabWidth: {
    opts: [
      { v: "2", label: "2" },
      { v: "4", label: "4" },
      { v: "8", label: "8" },
    ],
    display: true,
  },
  syntax: { opts: onOff, diff: true },
  split: {
    opts: [
      { v: "false", label: "Unified" },
      { v: "true", label: "Side by side" },
    ],
    diff: true,
  },
  wrap: { opts: onOff, diff: true },
  mdPreview: {
    opts: [
      { v: "false", label: "Diff" },
      { v: "true", label: "Preview" },
    ],
    diff: true,
  },
  density: {
    opts: [
      { v: "compact", label: "Compact" },
      { v: "default", label: "Default" },
      { v: "roomy", label: "Roomy" },
    ],
    display: true,
  },
  motion: {
    opts: [
      { v: "system", label: "Match system" },
      { v: "reduce", label: "Reduce" },
    ],
    display: true,
  },
  follow: { opts: onOff },
  ignoreWs: { opts: onOff },
  editor: {
    opts: [
      { v: "code", label: "VS Code" },
      { v: "cursor", label: "Cursor" },
      { v: "zed", label: "Zed" },
      { v: "", label: "System default" },
    ],
  },
  reopenLast: { opts: onOff },
};

const KEYS: [string, string][] = [
  ["J / K", "Next / previous file"],
  ["Shift+J / Shift+K", "Next / previous commit, in History"],
  ["N / P", "Next / previous change in the open file"],
  ["V", "Mark the selected file viewed"],
  ["U", "Next file you haven't viewed"],
  ["C", "Copy the file path, or a reference to the selected lines"],
  ["O", "Open the file in your editor"],
  ["S / W", "Side by side / wrap long lines"],
  ["E", "Show all unchanged lines"],
  ["/", "Filter files (Esc clears)"],
  [`${modKey}+P`, "Jump to a file"],
  [`${modKey}+Shift+P`, "Run a command"],
  [`${modKey}+= / ${modKey}+-`, "Larger / smaller diff text"],
  ["?", "This list"],
  [`${modKey}+F`, "Find in the open file (Enter / Shift+Enter for next / previous)"],
  [`${modKey}+,`, "Settings"],
  ["Esc", "Close a menu or this sheet"],
];

export function settings(hooks: { refreshDiff: () => void }) {
  const nav = h("nav", { class: "set-nav", "aria-label": "Settings sections" });
  const body = h("div", { class: "set-body" });
  const closeBtn = h("button", { class: "tgl set-close", "aria-label": "Close settings", "data-tip": "Close", "data-kbd": "Esc", html: icon.close });
  const sheet = h(
    "div",
    { class: "set", role: "dialog", "aria-modal": "true", "aria-labelledby": "set-title" },
    h("div", { class: "set-head" }, h("h2", { class: "set-title", id: "set-title" }, "Settings"), closeBtn),
    h("div", { class: "set-main" }, nav, body),
  );
  const scrim = h("div", { class: "pal-scrim set-scrim", hidden: true }, sheet);
  let restoreFocus: Element | null = null;
  let section: Section = "appearance";

  scrim.addEventListener("mousedown", (e) => e.target === scrim && close());
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  nav.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-section]");
    if (!b) return;
    section = b.dataset.section as Section;
    render();
    body.scrollTop = 0;
  });
  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>("[data-set-mode]");
    const card = t.closest<HTMLElement>("[data-theme-id]");
    const opt = t.closest<HTMLElement>("[data-pref]");
    if (m) setMode(m.dataset.setMode as "system" | "light" | "dark");
    else if (card) setTheme(THEMES.find((x) => x.id === card.dataset.themeId)!);
    else if (opt) setPref(opt.dataset.pref as keyof Prefs, opt.dataset.val!);
    else return;
    render();
    changed();
  });
  document.addEventListener("morphe:theme", () => !scrim.hidden && render());

  function setPref(key: keyof Prefs, raw: string) {
    const prev = state.prefs[key];
    const val = raw === "true" ? true : raw === "false" ? false : typeof prev === "number" ? Number(raw) : raw;
    if (val === prev) return;
    (state.prefs as unknown as Record<string, unknown>)[key] = val;
    savePrefs();
    const spec = SEG[key]!;
    if (spec.display) applyDisplay();
    if (spec.diff) hooks.refreshDiff();
    // The sidebar listens for this to act on prefs it owns (follow jumps to the latest edit).
    document.dispatchEvent(new CustomEvent("morphe:pref", { detail: key }));
  }

  function seg(key: keyof Prefs, label: string) {
    const cur = String(state.prefs[key]);
    return (
      `<span class="seg" role="group" aria-label="${esc(label)}">` +
      SEG[key]!.opts.map((o) => `<button data-pref="${key}" data-val="${o.v}" aria-pressed="${cur === o.v}">${esc(o.label)}</button>`).join("") +
      `</span>`
    );
  }

  function row(label: string, help: string, control: string) {
    return `<div class="set-row"><div><div class="set-label">${label}</div>${help ? `<p class="set-help">${help}</p>` : ""}</div>${control}</div>`;
  }

  function card(t: ThemeDef) {
    const chosen = (t.kind === "dark" ? state.prefs.darkTheme : state.prefs.lightTheme) === t.id;
    const [side, bg, active, text, accent] = t.swatch;
    const line = (w: number, c: string) => `<i style="width:${w}%;background:${c}"></i>`;
    return (
      `<button class="theme-card" data-theme-id="${t.id}" aria-pressed="${chosen}">` +
      `<span class="tc-prev" style="background:${bg}" aria-hidden="true">` +
      `<span class="tc-side" style="background:${side}"><b style="background:${active}"></b><b></b><b></b></span>` +
      `<span class="tc-code">${line(62, text + "55")}${line(48, "#3fae6e88")}${line(55, "#d0545488")}${line(40, text + "40")}</span>` +
      `<span class="tc-dot" style="background:${accent}"></span></span>` +
      `<span class="tc-name">${chosen ? `<span class="tc-check">${icon.check}</span>` : ""}${esc(t.name)}</span>` +
      `</button>`
    );
  }

  function appearance() {
    const mode = state.prefs.theme;
    const kind = shownKind();
    const modes = [
      ["system", "Match system"],
      ["light", "Light"],
      ["dark", "Dark"],
    ];
    const group = (k: "dark" | "light", title: string) =>
      `<div class="set-group"><div class="set-label">${title}${kind === k ? `<span class="set-note">showing now</span>` : ""}</div>` +
      `<div class="theme-grid">${THEMES.filter((t) => t.kind === k).map(card).join("")}</div></div>`;
    return (
      row(
        "Mode",
        "Match system switches between your dark and light theme with the OS.",
        `<span class="seg" role="group" aria-label="Mode">${modes.map(([id, l]) => `<button data-set-mode="${id}" aria-pressed="${mode === id}">${l}</button>`).join("")}</span>`,
      ) +
      group("dark", "Dark theme") +
      group("light", "Light theme") +
      `<div class="set-group">` +
      row("Row density", "Height of rows in the file list, tree and history.", seg("density", "Row density")) +
      row("Motion", "Reduce turns off the live-change trace and other animations.", seg("motion", "Motion")) +
      `</div>`
    );
  }

  function diff() {
    return (
      row("Text size", "Size of code in diffs and file views.", seg("codeSize", "Text size")) +
      row("Tab width", "How many columns a tab character takes.", seg("tabWidth", "Tab width")) +
      row("Ignore whitespace", "Hide changes that only add or remove spaces, tabs or line endings. Files with nothing else changed drop out of Changes.", seg("ignoreWs", "Ignore whitespace")) +
      row("Syntax highlighting", "Off shows plain text, which is a little faster on huge files.", seg("syntax", "Syntax highlighting")) +
      row("Layout", "Also on the button above each diff.", seg("split", "Layout")) +
      row("Wrap long lines", "Side by side always wraps.", seg("wrap", "Wrap long lines")) +
      row("Markdown files open as", "Switch any time with Diff / Preview above the file.", seg("mdPreview", "Markdown files open as"))
    );
  }

  function general() {
    return (
      row("Open files in", "Used by the open button above each file, and by double-clicking a line. VS Code, Cursor and Zed open the whole repository, then the file.", seg("editor", "Open files in")) +
      row("Reopen last repository", "On launch, open the most recent repository instead of the start screen.", seg("reopenLast", "Reopen last repository")) +
      row("Follow latest edit", "Jump to each file as it changes. Same as the toggle above the file list.", seg("follow", "Follow latest edit"))
    );
  }

  function keys() {
    const k = (s: string) => s.split(" / ").map((p) => p.split("+").map((x) => `<kbd>${esc(x)}</kbd>`).join("+")).join(" / ");
    return (
      `<table class="set-keys"><tbody>` +
      KEYS.map(([key, what]) => `<tr><td>${k(key)}</td><td>${esc(what)}</td></tr>`).join("") +
      `</tbody></table>`
    );
  }

  function render() {
    nav.innerHTML = SECTIONS.map((s) => `<button data-section="${s.id}" aria-current="${s.id === section ? "page" : "false"}">${s.label}</button>`).join("");
    const title = SECTIONS.find((s) => s.id === section)!.label;
    const content = section === "appearance" ? appearance() : section === "diff" ? diff() : section === "general" ? general() : keys();
    body.innerHTML = `<h3 class="set-h">${title}</h3>${content}`;
  }

  function open(to?: Section | Event) {
    // Also used directly as a click handler, which passes the event.
    if (typeof to === "string") section = to;
    restoreFocus = document.activeElement;
    render();
    scrim.hidden = false;
    (nav.querySelector<HTMLElement>('[aria-current="page"]') ?? closeBtn).focus();
  }
  function close() {
    scrim.hidden = true;
    (restoreFocus as HTMLElement | null)?.focus?.();
  }

  return {
    el: scrim,
    open,
    get isOpen() {
      return !scrim.hidden;
    },
  };
}
