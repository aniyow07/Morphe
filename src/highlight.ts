// Lazy syntax highlighting: highlight.js core, one language chunk loaded per file type.
import hljs from "highlight.js/lib/core";
import { state } from "./state";

/** A run of text and the highlight class it belongs to ("" for plain). */
export type Seg = [text: string, cls: string];

type Loader = () => Promise<{ default: Parameters<typeof hljs.registerLanguage>[1] }>;

const LANGS: Record<string, [name: string, load: Loader]> = {
  ts: ["typescript", () => import("highlight.js/lib/languages/typescript")],
  js: ["javascript", () => import("highlight.js/lib/languages/javascript")],
  py: ["python", () => import("highlight.js/lib/languages/python")],
  rs: ["rust", () => import("highlight.js/lib/languages/rust")],
  go: ["go", () => import("highlight.js/lib/languages/go")],
  java: ["java", () => import("highlight.js/lib/languages/java")],
  kt: ["kotlin", () => import("highlight.js/lib/languages/kotlin")],
  c: ["c", () => import("highlight.js/lib/languages/c")],
  cpp: ["cpp", () => import("highlight.js/lib/languages/cpp")],
  cs: ["csharp", () => import("highlight.js/lib/languages/csharp")],
  rb: ["ruby", () => import("highlight.js/lib/languages/ruby")],
  php: ["php", () => import("highlight.js/lib/languages/php")],
  swift: ["swift", () => import("highlight.js/lib/languages/swift")],
  css: ["css", () => import("highlight.js/lib/languages/css")],
  scss: ["scss", () => import("highlight.js/lib/languages/scss")],
  html: ["xml", () => import("highlight.js/lib/languages/xml")],
  json: ["json", () => import("highlight.js/lib/languages/json")],
  yaml: ["yaml", () => import("highlight.js/lib/languages/yaml")],
  toml: ["ini", () => import("highlight.js/lib/languages/ini")],
  md: ["markdown", () => import("highlight.js/lib/languages/markdown")],
  sh: ["bash", () => import("highlight.js/lib/languages/bash")],
  sql: ["sql", () => import("highlight.js/lib/languages/sql")],
  lua: ["lua", () => import("highlight.js/lib/languages/lua")],
  dockerfile: ["dockerfile", () => import("highlight.js/lib/languages/dockerfile")],
  makefile: ["makefile", () => import("highlight.js/lib/languages/makefile")],
  diff: ["diff", () => import("highlight.js/lib/languages/diff")],
};

const ALIASES: Record<string, string> = {
  tsx: "ts", mts: "ts", cts: "ts", jsx: "js", mjs: "js", cjs: "js", pyi: "py", pyx: "py",
  h: "c", hpp: "cpp", cc: "cpp", cxx: "cpp", hh: "cpp", xml: "html", svg: "html", vue: "html",
  svelte: "html", yml: "yaml", ini: "toml", cfg: "toml", markdown: "md", mdx: "md", bash: "sh",
  zsh: "sh", kts: "kt", patch: "diff",
};

const loaded = new Map<string, Promise<string | null>>();

function keyFor(path: string): string | null {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  const k = ALIASES[ext] ?? ext;
  return k in LANGS ? k : null;
}

/** Synchronous: the language name if its grammar is already loaded. */
export function readyLanguage(path: string): string | null {
  if (!state.prefs.syntax) return null;
  const k = keyFor(path);
  return k && hljs.getLanguage(LANGS[k][0]) ? LANGS[k][0] : null;
}

/** Load the grammar for this file type (once). Resolves to its name, or null. */
export function loadLanguage(path: string): Promise<string | null> {
  if (!state.prefs.syntax) return Promise.resolve(null);
  const k = keyFor(path);
  if (!k) return Promise.resolve(null);
  let p = loaded.get(k);
  if (!p) {
    const [name, load] = LANGS[k];
    p = load()
      .then((m) => (hljs.registerLanguage(name, m.default), name))
      .catch(() => null);
    loaded.set(k, p);
  }
  return p;
}

/** Highlight consecutive lines and return per-line segments. */
export function highlightLines(lines: string[], lang: string): Seg[][] {
  const html = hljs.highlight(lines.join("\n"), { language: lang, ignoreIllegals: true }).value;
  return splitHtml(html, lines.length);
}

const ENT: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#x27;": "'", "&#39;": "'" };
const decode = (s: string) => (s.includes("&") ? s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (m) => ENT[m]) : s);

/** Turn highlight.js HTML into lines of [text, class] runs, carrying open spans across newlines. */
function splitHtml(html: string, count: number): Seg[][] {
  const out: Seg[][] = [[]];
  const stack: string[] = [];
  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(m[1].replace(/hljs-/g, "").split(" ")[0]);
    else if (m[2] === undefined) stack.pop();
    else {
      const cls = stack.length ? stack[stack.length - 1] : "";
      const parts = decode(m[2]).split("\n");
      parts.forEach((part, i) => {
        if (i > 0) out.push([]);
        if (part) out[out.length - 1].push([part, cls]);
      });
    }
  }
  while (out.length < count) out.push([]);
  return out;
}
