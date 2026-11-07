// Welcome screen (no repo open) and the "repository is gone" state.
import { api, type Recent } from "../api";
import { esc, h, icon } from "../dom";
import { state } from "../state";

export function welcome(open: (path: string) => void, pick: () => void) {
  const recentList = h("ul", { class: "recents", "aria-label": "Recent repositories" });
  const error = h("p", { class: "wl-error", role: "alert" });
  const el = h(
    "section",
    { class: "welcome" },
    h(
      "div",
      { class: "wl-inner" },
      h("img", { class: "wl-mark", src: "/icon.svg", alt: "", width: "44", height: "44" }),
      h("h1", { class: "wl-title" }, "Open a repository"),
      h("p", { class: "wl-sub" }, "Morphe shows everything that differs from HEAD and updates as files change."),
      h("button", { class: "btn primary", onclick: pick, html: `${icon.folder}<span>Choose folder…</span>` }),
      error,
      recentList,
      h("p", { class: "wl-cli" }, "You can also start it from a terminal: ", h("code", {}, "morphe <path>")),
    ),
  );

  async function refresh() {
    error.textContent = state.error;
    error.hidden = !state.error;
    let recents: Recent[] = [];
    try {
      recents = await api.recentRepos();
    } catch {
      /* no recents yet */
    }
    recentList.replaceChildren(
      ...recents.map((r) => {
        const li = h("li", { class: "recent" });
        li.innerHTML =
          `<button class="recent-open"><span class="recent-name">${esc(r.name)}</span><span class="recent-path">${esc(r.path)}</span></button>` +
          `<button class="recent-forget" aria-label="Remove ${esc(r.name)} from recent" data-tip="Remove from recent">${icon.close}</button>`;
        li.querySelector(".recent-open")!.addEventListener("click", () => open(r.path));
        li.querySelector(".recent-forget")!.addEventListener("click", async () => {
          await api.forgetRecent(r.path);
          refresh();
        });
        return li;
      }),
    );
    recentList.hidden = recents.length === 0;
  }

  return { el, refresh };
}

export function goneState(pickAnother: () => void, retry: () => void) {
  const path = h("code", {});
  const el = h(
    "section",
    { class: "empty gone" },
    h("h2", { class: "empty-title" }, "This repository is no longer available"),
    h("p", { class: "empty-sub" }, "Nothing is at ", path, " any more. It may have been moved, renamed or deleted."),
    h(
      "div",
      { class: "empty-actions" },
      h("button", { class: "btn primary", onclick: pickAnother }, "Open another repository"),
      h("button", { class: "btn", onclick: retry }, "Try again"),
    ),
  );
  return {
    el,
    set(root: string) {
      path.textContent = root;
    },
  };
}
