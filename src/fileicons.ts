// File type icons: one-color language marks (Simple Icons, CC0), tinted with each brand's color.
// Only the icons imported here end up in the bundle.
import {
  siAstro, siBun, siC, siClojure, siCmake, siCplusplus, siCss, siDart, siDeno, siDocker, siDotnet, siElixir, siErlang,
  siEslint, siFortran, siGit, siGithubactions, siGnubash, siGo, siGradle, siGraphql, siHaskell, siHtml5, siJavascript,
  siJson, siJulia, siJupyter, siKotlin, siLatex, siLess, siLua, siMarkdown, siMdx, siNixos, siNodedotjs, siNpm, siOcaml,
  siOpenjdk, siPerl, siPhp, siPnpm, siPostgresql, siPrettier, siPython, siR, siReact, siRuby, siRust, siSass, siScala,
  siSharp, siSqlite, siSvelte, siSvg, siSwift, siTauri, siTerraform, siToml, siTypescript, siVim, siVite, siVuedotjs,
  siWebassembly, siXml, siYaml, siYarn, siZig,
  type SimpleIcon,
} from "simple-icons";

const EXT: Record<string, SimpleIcon> = {
  rs: siRust, ts: siTypescript, mts: siTypescript, cts: siTypescript, tsx: siReact, jsx: siReact,
  js: siJavascript, mjs: siJavascript, cjs: siJavascript, py: siPython, pyi: siPython, pyx: siPython, ipynb: siJupyter,
  go: siGo, html: siHtml5, htm: siHtml5, css: siCss, scss: siSass, sass: siSass, less: siLess,
  json: siJson, jsonc: siJson, json5: siJson, md: siMarkdown, markdown: siMarkdown, mdx: siMdx,
  toml: siToml, yml: siYaml, yaml: siYaml, xml: siXml, svg: siSvg, vue: siVuedotjs, svelte: siSvelte, astro: siAstro,
  sh: siGnubash, bash: siGnubash, zsh: siGnubash, fish: siGnubash,
  c: siC, h: siC, cc: siCplusplus, cpp: siCplusplus, cxx: siCplusplus, hpp: siCplusplus, hh: siCplusplus,
  cs: siSharp, fs: siDotnet, vb: siDotnet, csproj: siDotnet, sln: siDotnet,
  java: siOpenjdk, kt: siKotlin, kts: siKotlin, swift: siSwift, rb: siRuby, php: siPhp, lua: siLua, zig: siZig,
  dart: siDart, ex: siElixir, exs: siElixir, erl: siErlang, hs: siHaskell, scala: siScala, r: siR, jl: siJulia,
  clj: siClojure, cljs: siClojure, ml: siOcaml, mli: siOcaml, pl: siPerl, pm: siPerl, f90: siFortran, f: siFortran,
  sql: siPostgresql, sqlite: siSqlite, db: siSqlite, nix: siNixos, tf: siTerraform, graphql: siGraphql, gql: siGraphql,
  tex: siLatex, vim: siVim, wasm: siWebassembly, wat: siWebassembly, cmake: siCmake, gradle: siGradle,
};

/** Whole file names that say more than their extension. */
const NAME: Record<string, SimpleIcon> = {
  "cargo.toml": siRust, "cargo.lock": siRust, "package.json": siNpm, "package-lock.json": siNpm, ".npmrc": siNpm,
  "pnpm-lock.yaml": siPnpm, "yarn.lock": siYarn, "bun.lockb": siBun, "bun.lock": siBun, "deno.json": siDeno,
  dockerfile: siDocker, ".dockerignore": siDocker, "docker-compose.yml": siDocker, "docker-compose.yaml": siDocker, "compose.yaml": siDocker,
  ".gitignore": siGit, ".gitattributes": siGit, ".gitmodules": siGit, "cmakelists.txt": siCmake,
  "tauri.conf.json": siTauri, ".nvmrc": siNodedotjs, ".prettierrc": siPrettier, ".eslintrc": siEslint, "tsconfig.json": siTypescript,
};

const PREFIX: [string, SimpleIcon][] = [
  ["vite.config.", siVite],
  ["eslint.config.", siEslint],
  [".eslintrc.", siEslint],
  [".prettierrc.", siPrettier],
  ["prettier.config.", siPrettier],
  ["dockerfile.", siDocker],
];

const GENERIC =
  '<svg class="fi fi-plain" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.75h5l3 3v9.5H4z"/><path d="M9 1.75v3h3"/></svg>';

const cache = new Map<SimpleIcon, string>();

/** The icon for a path, as an HTML string. */
export function fileIcon(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  let ic: SimpleIcon | undefined = NAME[name] ?? PREFIX.find(([p]) => name.startsWith(p))?.[1];
  if (!ic && path.includes(".github/workflows/")) ic = siGithubactions;
  if (!ic) ic = EXT[name.slice(name.lastIndexOf(".") + 1)];
  if (!ic) return GENERIC;
  let html = cache.get(ic);
  if (!html) {
    // Near-black marks (Rust, Markdown, JSON) would vanish on dark themes; they take the text color.
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(ic!.hex.slice(i, i + 2), 16));
    const dark = 0.2126 * r + 0.7152 * g + 0.0722 * b < 56;
    html = `<svg class="fi${dark ? " fi-mono" : ""}" viewBox="0 0 24 24"${dark ? "" : ` style="color:#${ic.hex}"`} aria-hidden="true"><path d="${ic.path}"/></svg>`;
    cache.set(ic, html);
  }
  return html;
}
