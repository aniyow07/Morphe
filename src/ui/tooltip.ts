// One shared tooltip for every element with data-tip (and optional data-kbd shortcut hint).
import { h } from "../dom";

export function tooltips() {
  const tip = h("div", { class: "tip", role: "tooltip", hidden: true });
  document.body.append(tip);
  let timer = 0;
  let target: HTMLElement | null = null;

  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.hidden = true;
  };

  document.addEventListener("pointerover", (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>("[data-tip]");
    if (t === target) return;
    hide();
    if (!t) return;
    target = t;
    timer = window.setTimeout(() => show(t), 450);
  });
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);

  function show(t: HTMLElement) {
    if (!t.isConnected) return;
    tip.replaceChildren(t.dataset.tip ?? "");
    if (t.dataset.kbd) tip.append(h("kbd", {}, t.dataset.kbd));
    tip.hidden = false;
    const r = t.getBoundingClientRect();
    const w = tip.offsetWidth;
    const below = r.bottom + 6 + tip.offsetHeight < window.innerHeight;
    tip.style.left = `${Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${below ? r.bottom + 6 : r.top - tip.offsetHeight - 6}px`;
  }
}
