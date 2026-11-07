// Slim title bar: repo, branch chip, summary stats, live dot, window controls.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { esc, fmt, h, icon, isMac, modKey } from "../dom";
import { changed, state, subscribe, totals } from "../state";
import { shownKind, toggleLightDark } from "../theme";

export function titlebar(onRepoClick: () => void, onSettings: () => void, onBranch: () => void): HTMLElement {
  const win = getCurrentWindow();
  const live = h("span", { class: "live-dot", "aria-hidden": "true" });
  const repo = h("button", { class: "tb-repo", "data-tip": "Switch repository", onclick: onRepoClick }, live, h("span", { class: "tb-repo-name" }));
  const branch = h("button", { class: "tb-branch", "data-tip": "Branches and history", onclick: onBranch });
  const stats = h("div", { class: "tb-stats", "data-tauri-drag-region": true, "aria-live": "polite" });

  const themeBtn = h("button", { class: "tgl tb-theme", onclick: () => (toggleLightDark(), changed()) });
  const settingsBtn = h("button", { class: "tgl tb-settings", "aria-label": "Settings", "data-tip": "Settings", "data-kbd": `${modKey}+,`, html: icon.gear, onclick: onSettings });

  const maxBtn = h("button", { class: "wc", "aria-label": "Maximize", html: icon.max, onclick: () => win.toggleMaximize() });
  const controls = isMac
    ? null
    : h(
        "div",
        { class: "wc-group" },
        h("button", { class: "wc", "aria-label": "Minimize", html: icon.min, onclick: () => win.minimize() }),
        maxBtn,
        h("button", { class: "wc wc-close", "aria-label": "Close", html: icon.winClose, onclick: () => win.close() }),
      );
  if (controls) {
    const syncMax = async () => {
      const m = await win.isMaximized();
      maxBtn.innerHTML = m ? icon.restore : icon.max;
      maxBtn.setAttribute("aria-label", m ? "Restore" : "Maximize");
    };
    win.onResized(syncMax);
    syncMax();
  }

  const bar = h(
    "header",
    { class: `titlebar${isMac ? " mac" : ""}`, "data-tauri-drag-region": true },
    repo,
    branch,
    h("div", { class: "tb-spacer", "data-tauri-drag-region": true }),
    stats,
    themeBtn,
    settingsBtn,
    controls,
  );

  subscribe(() => {
    // Shows what a click does: the moon switches to dark, the sun to light.
    const dark = shownKind() === "dark";
    themeBtn.innerHTML = dark ? icon.sun : icon.moon;
    themeBtn.setAttribute("aria-label", dark ? "Switch to light" : "Switch to dark");
    themeBtn.dataset.tip = dark ? "Switch to light" : "Switch to dark";
    const inRepo = state.screen === "repo" || state.screen === "gone";
    repo.disabled = !inRepo;
    if (inRepo) repo.dataset.tip = "Switch repository";
    else delete repo.dataset.tip;
    live.hidden = !inRepo;
    branch.hidden = !inRepo || !state.branch;
    stats.hidden = state.screen !== "repo";
    (repo.lastChild as HTMLElement).textContent = inRepo ? state.name : "Morphe";
    branch.innerHTML = `${icon.branch}<span>${esc(state.branch)}</span>`;
    branch.title = state.branch;
    const t = totals();
    stats.innerHTML = t.files
      ? `<span><b>${fmt.format(t.files)}</b> ${t.files === 1 ? "file" : "files"}</span>` +
        `<span class="add">+${fmt.format(t.add)}</span><span class="del">−${fmt.format(t.del)}</span>` +
        (state.mode === "changes" ? `<span class="viewed-count"><b>${fmt.format(t.viewed)}</b>/${fmt.format(t.files)} viewed</span>` : "")
      : "";
  });
  return bar;
}

/** One soft tick of the live dot whenever a change arrives. */
export function tickLive() {
  const dot = document.querySelector(".live-dot");
  if (!dot) return;
  dot.classList.remove("tick");
  void (dot as HTMLElement).offsetWidth; // restart the animation
  dot.classList.add("tick");
}

