// Settings sheet (gear in the title bar, or Ctrl/Cmd+,): appearance mode and themes.
import { esc, h, icon, modKey } from "../dom";
import { changed, state } from "../state";
import { setMode, setTheme, shownKind, THEMES, type ThemeDef } from "../theme";

const MODES = [
  { id: "system", label: "Match system" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
] as const;

export function settings() {
  const body = h("div", { class: "set-body" });
  const closeBtn = h("button", { class: "tgl set-close", "aria-label": "Close settings", "data-tip": "Close", "data-kbd": "Esc", html: icon.close });
  const sheet = h(
    "div",
    { class: "set", role: "dialog", "aria-modal": "true", "aria-labelledby": "set-title" },
    h("div", { class: "set-head" }, h("h2", { class: "set-title", id: "set-title" }, "Settings"), closeBtn),
    body,
  );
  const scrim = h("div", { class: "pal-scrim set-scrim", hidden: true }, sheet);
  let restoreFocus: Element | null = null;

  scrim.addEventListener("mousedown", (e) => e.target === scrim && close());
  closeBtn.addEventListener("click", close);
  scrim.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  });
  body.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>("[data-set-mode]");
    if (m) setMode(m.dataset.setMode as "system" | "light" | "dark");
    const card = t.closest<HTMLElement>("[data-theme-id]");
    if (card) setTheme(THEMES.find((x) => x.id === card.dataset.themeId)!);
    if (m || card) {
      render();
      changed();
    }
  });
  document.addEventListener("morphe:theme", () => !scrim.hidden && render());

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

  function render() {
    const mode = state.prefs.theme;
    const kind = shownKind();
    const group = (k: "dark" | "light", title: string) =>
      `<div class="set-group"><div class="set-label">${title}${kind === k ? `<span class="set-note">showing now</span>` : ""}</div>` +
      `<div class="theme-grid">${THEMES.filter((t) => t.kind === k).map(card).join("")}</div></div>`;
    body.innerHTML =
      `<section class="set-section"><h3 class="set-h">Appearance</h3>` +
      `<div class="set-row"><div><div class="set-label">Mode</div>` +
      `<p class="set-help">Match system switches between your dark and light theme with the OS.</p></div>` +
      `<span class="seg" role="group" aria-label="Mode">${MODES.map((m) => `<button data-set-mode="${m.id}" aria-pressed="${mode === m.id}">${m.label}</button>`).join("")}</span></div>` +
      group("dark", "Dark theme") +
      group("light", "Light theme") +
      `</section>`;
  }

  function open() {
    restoreFocus = document.activeElement;
    render();
    scrim.hidden = false;
    (body.querySelector<HTMLElement>('[aria-pressed="true"]') ?? closeBtn).focus();
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
    shortcut: `${modKey}+,`,
  };
}
