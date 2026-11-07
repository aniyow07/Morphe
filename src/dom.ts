// Minimal DOM helpers and the icon set (1.5px strokes on a 16px grid).

type Attrs = Record<string, string | number | boolean | undefined | EventListener>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else if (k === "html") el.innerHTML = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c != null && c !== false) el.append(c);
  return el;
}

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESC[c]);

export const fmt = new Intl.NumberFormat();

const svg = (body: string, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const icon = {
  branch: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-2 3-7 4"/>', 14),
  folder: svg('<path d="M2 4.5c0-.8.7-1.5 1.5-1.5h3l1.5 1.5h4.5c.8 0 1.5.7 1.5 1.5v5.5c0 .8-.7 1.5-1.5 1.5h-9c-.8 0-1.5-.7-1.5-1.5z"/>'),
  chevron: svg('<path d="M6 4l4 4-4 4"/>', 12),
  check: svg('<path d="M3.5 8.5l3 3 6-7"/>', 12),
  search: svg('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>', 14),
  follow: svg('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.75" fill="currentColor" stroke="none"/>', 14),
  eyeOff: svg('<path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z"/><circle cx="8" cy="8" r="1.75"/><path d="M2.5 13.5l11-11"/>', 14),
  tree: svg('<path d="M3 2.5v9.5h3.5M3 6.5h3.5"/><rect x="7.5" y="4.5" width="6" height="4" rx="1"/><rect x="7.5" y="10" width="6" height="4" rx="1"/>', 14),
  group: svg('<path d="M2.5 3.5h5M5 6.5h8.5M5 9.5h8.5M2.5 12.5h5M2.5 3.5v9"/>', 14),
  wrap: svg('<path d="M2.5 4h11M2.5 8h9a2 2 0 010 4H8.5M2.5 12h3M10 10.5L8.5 12l1.5 1.5"/>', 14),
  split: svg('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M8 2.5v11"/>', 14),
  sun: svg('<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>', 14),
  moon: svg('<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 100 10 5.5 5.5 0 006.5-3.5z"/>', 14),
  monitor: svg('<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5"/>', 14),
  preview: svg('<path d="M2 8s2.2-4.5 6-4.5S14 8 14 8s-2.2 4.5-6 4.5S2 8 2 8z"/><circle cx="8" cy="8" r="1.75"/>', 14),
  code: svg('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>', 14),
  close: svg('<path d="M4 4l8 8M12 4l-8 8"/>', 12),
  min: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 5h10" stroke="currentColor" stroke-width="1"/></svg>',
  max: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  restore:
    '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 2.5V.5h7v7h-2M.5 2.5h7v7h-7z" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
  winClose: '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1"/></svg>',
};

export const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  U: "Untracked",
  R: "Renamed",
  T: "Type changed",
};

export const isMac = navigator.userAgent.includes("Mac");
export const modKey = isMac ? "⌘" : "Ctrl";
