// History panel in the sidebar: branch picker, the paged commit list, and the selected
// commit's message. The commit's files use the regular file list below it.
import type { CommitInfo } from "../api";
import { esc, fmt, h, icon } from "../dom";
import { changed, state, subscribe } from "../state";

export interface HistoryActions {
  selectCommit: (id: string) => void;
  setBranch: (name: string | null) => void;
  loadMore: () => void;
}

const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dayMonthYear = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

/** Compact age: "now", "12m", "5h", "3d", then a date. */
export function age(sec: number, now = Date.now() / 1000): string {
  const d = now - sec;
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (d < 86400) return `${Math.floor(d / 3600)}h`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}d`;
  const date = new Date(sec * 1000);
  return (date.getFullYear() === new Date().getFullYear() ? dayMonth : dayMonthYear).format(date);
}

export function historyPanel(actions: HistoryActions) {
  const branchBtn = h("button", { class: "branch-btn", "aria-haspopup": "listbox", "aria-expanded": "false", "data-tip": "Show another branch" });
  const menu = h("div", { class: "menu", role: "listbox", "aria-label": "Branches", hidden: true });
  const list = h("div", { class: "commit-list", role: "listbox", tabindex: "0", "aria-label": "Commits" });
  const more = h("div", { class: "list-note commit-more" });
  const head = h("div", { class: "commit-head" });
  const el = h("div", { class: "hist" }, h("div", { class: "hist-bar" }, branchBtn, menu), h("div", { class: "commit-scroll" }, list, more), head);
  const scroll = el.querySelector<HTMLElement>(".commit-scroll")!;

  // ---- branch menu ----
  const openMenu = (open: boolean) => {
    menu.hidden = !open;
    branchBtn.setAttribute("aria-expanded", String(open));
    if (open) {
      renderMenu();
      (menu.querySelector<HTMLElement>('[aria-selected="true"]') ?? menu.querySelector<HTMLElement>(".mi"))?.focus();
    }
  };
  branchBtn.addEventListener("click", () => openMenu(menu.hidden));
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !el.querySelector(".hist-bar")!.contains(e.target as Node)) openMenu(false);
  });
  menu.addEventListener("click", (e) => {
    const mi = (e.target as HTMLElement).closest<HTMLElement>(".mi");
    if (!mi) return;
    openMenu(false);
    branchBtn.focus();
    const name = mi.dataset.name!;
    const current = state.history.branches.find((b) => b.current)?.name;
    actions.setBranch(name === current ? null : name);
  });
  menu.addEventListener("keydown", (e) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>(".mi"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[Math.min(items.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      openMenu(false);
      branchBtn.focus();
    }
  });
  function renderMenu() {
    const shown = shownBranch();
    menu.innerHTML = state.history.branches
      .map(
        (b) =>
          `<button class="mi" role="option" data-name="${esc(b.name)}" aria-selected="${b.name === shown}">` +
          `<span class="mi-check">${b.name === shown ? icon.check : ""}</span>` +
          `<span class="mi-name">${esc(b.name === "HEAD" ? "Detached HEAD" : b.name)}</span>` +
          `${b.current ? `<span class="mi-note">current</span>` : ""}</button>`,
      )
      .join("");
  }

  // ---- commit list ----
  const openDetail = (open: boolean) => {
    state.history.detail = open;
    changed();
    if (!open) setTimeout(() => list.focus());
  };
  list.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".crow");
    if (!row) return;
    if (state.history.selected !== row.dataset.id) actions.selectCommit(row.dataset.id!);
    openDetail(true);
  });
  list.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && state.history.selected) openDetail(true);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") stepCommit(e.key === "ArrowDown" ? 1 : -1, actions);
    else return;
    e.preventDefault();
  });
  scroll.addEventListener(
    "scroll",
    () => {
      if (scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 400) actions.loadMore();
    },
    { passive: true },
  );
  head.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.closest(".ch-back")) openDetail(false);
    else if (t.closest(".ch-prev")) stepCommit(-1, actions);
    else if (t.closest(".ch-next")) stepCommit(1, actions);
    else if (t.closest(".ch-fold")) {
      head.classList.toggle("folded");
      const folded = head.classList.contains("folded");
      t.closest(".ch-fold")!.setAttribute("aria-expanded", String(!folded));
      try {
        localStorage.setItem("morphe.commitFolded", folded ? "1" : "");
      } catch {
        /* not persisted */
      }
    } else if (t.closest(".ch-body")) head.classList.toggle("expanded");
  });

  let rendered: CommitInfo[] = [];
  let selectedRow: HTMLElement | null = null;
  let headId = "";
  let lastDay = "";

  subscribe(() => {
    const H = state.history;
    el.hidden = state.mode !== "history";
    if (el.hidden) return;

    const shown = shownBranch();
    branchBtn.innerHTML = `${icon.branch}<span class="bb-name">${esc(shown === "HEAD" ? "Detached HEAD" : shown || "No branches")}</span><span class="bb-chev">${icon.chevron}</span>`;
    branchBtn.toggleAttribute("disabled", H.branches.length === 0);
    // Opened before the branch list arrived: fill it in once it does.
    if (!menu.hidden && menu.childElementCount !== H.branches.length) openMenu(true);

    // The list only grows by pages or resets, so append when it's an extension.
    const extends_ = rendered.length > 0 && H.commits.length >= rendered.length && H.commits[0]?.id === rendered[0].id && H.commits[rendered.length - 1]?.id === rendered[rendered.length - 1].id;
    if (!extends_) {
      list.replaceChildren();
      rendered = [];
      selectedRow = null;
      lastDay = "";
    }
    if (H.commits.length > rendered.length) {
      const frag = document.createDocumentFragment();
      for (const c of H.commits.slice(rendered.length)) {
        const day = dayLabel(c.time);
        if (day !== lastDay) frag.append(h("div", { class: "c-day", role: "presentation" }, day));
        lastDay = day;
        frag.append(commitRow(c));
      }
      list.append(frag);
      rendered = H.commits.slice();
    }
    const sel = H.selected ? list.querySelector<HTMLElement>(`.crow[data-id="${H.selected}"]`) : null;
    if (sel !== selectedRow) {
      selectedRow?.setAttribute("aria-selected", "false");
      sel?.setAttribute("aria-selected", "true");
      if (sel) {
        list.setAttribute("aria-activedescendant", sel.id);
        if (!H.detail) sel.scrollIntoView({ block: "nearest" });
      }
      selectedRow = sel;
    }
    more.textContent = H.loading ? "Loading commits…" : !H.commits.length && H.done ? "No commits yet" : "";
    more.hidden = !more.textContent;

    const open = H.open;
    head.hidden = !open || !H.detail;
    const i = H.commits.findIndex((c) => c.id === H.selected);
    const navKey = `${open?.commit.id}|${i <= 0}|${i >= H.commits.length - 1 && H.done}`;
    if (open && navKey !== headId) {
      headId = navKey;
      head.classList.remove("expanded");
      let folded = false;
      try {
        folded = !!localStorage.getItem("morphe.commitFolded");
      } catch {
        /* default: open */
      }
      head.classList.toggle("folded", folded);
      const c = open.commit;
      const add = open.files.reduce((n, f) => n + f.additions, 0);
      const del = open.files.reduce((n, f) => n + f.deletions, 0);
      const n = open.files.length;
      head.innerHTML =
        `<div class="ch-nav"><button class="ch-back" data-tip="Back to commits" data-kbd="Esc">${icon.back}<span>Commits</span></button>` +
        `<span class="ch-steps"><button class="tgl ch-fold" aria-expanded="${!folded}" aria-label="Show or hide commit details" data-tip="Show or hide details">${icon.chevron}</button><button class="tgl ch-prev" aria-label="Newer commit" data-tip="Newer commit" data-kbd="Shift+K"${i <= 0 ? " disabled" : ""}>${icon.up}</button>` +
        `<button class="tgl ch-next" aria-label="Older commit" data-tip="Older commit" data-kbd="Shift+J"${i >= H.commits.length - 1 && H.done ? " disabled" : ""}>${icon.down}</button></span></div>` +
        `<div class="ch-sum">${esc(c.summary || "(no message)")}</div>` +
        (open.body ? `<div class="ch-body" data-tip="Show the full message">${esc(open.body)}</div>` : "") +
        `<div class="ch-meta"><span class="c-sha">${c.id.slice(0, 7)}</span><span class="ch-author">${esc(c.author)}</span>` +
        `<span class="ch-date">${fullDate.format(new Date(c.time * 1000))}</span></div>` +
        `<div class="ch-stats">${fmt.format(n)} ${n === 1 ? "file" : "files"}` +
        `<span class="ch-add">+${fmt.format(add)}</span><span class="ch-del">−${fmt.format(del)}</span>` +
        `${c.parents > 1 ? `<span class="c-merge">merge, vs first parent</span>` : ""}</div>`;
    }
  });

  function commitRow(c: CommitInfo) {
    return h("div", {
      class: "crow",
      role: "option",
      id: `c-${c.id}`,
      "data-id": c.id,
      "aria-selected": "false",
      html:
        `<span class="c-sum">${esc(c.summary || "(no message)")}</span>` +
        `<span class="c-meta"><span class="c-sha">${c.id.slice(0, 7)}</span><span class="c-author">${esc(c.author)}</span>` +
        `${c.parents > 1 ? `<span class="c-merge">merge</span>` : ""}` +
        `<span class="c-time" data-tip="${esc(fullDate.format(new Date(c.time * 1000)))}">${age(c.time)}</span></span>`,
    });
  }

  return {
    el,
    openBranches() {
      openMenu(true);
    },
    focusList() {
      list.focus();
    },
  };
}

/** "Today", "Yesterday", a weekday within the week, else a date. */
function dayLabel(sec: number): string {
  const d = new Date(sec * 1000);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / 864e5);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

/** The branch whose log is listed (the current one unless another was picked). */
function shownBranch(): string {
  return state.history.branch ?? state.history.branches.find((b) => b.current)?.name ?? "";
}

/** Select the next or previous commit, loading another page at the end. */
export function stepCommit(dir: 1 | -1, actions: HistoryActions) {
  const { commits, selected, done } = state.history;
  if (!commits.length) return;
  const i = commits.findIndex((c) => c.id === selected);
  const next = i < 0 ? 0 : i + dir;
  if (next >= commits.length - 5 && !done) actions.loadMore();
  if (next >= 0 && next < commits.length) actions.selectCommit(commits[next].id);
}
