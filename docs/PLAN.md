# Morphe – implementation plan

A read-only, live viewer of a repo's working-tree diff against HEAD.

## Architecture

```
src-tauri/ (Rust, owns all git + filesystem work)
  git.rs      pure core: scan status, build per-file diffs, word-level emphasis (unit-tested)
  watch.rs    notify watcher, 150 ms debounce, path filtering, emits batches
  session.rs  open repo state: cached FileEntry/FileDiff per path, incremental refresh
  store.rs    app-data JSON: recent repos, viewed marks per repo
  lib.rs      Tauri setup, typed commands, event emission
src/ (Vite + TypeScript, plain DOM, no framework)
  api.ts      typed wrappers over invoke/listen
  state.ts    tiny store + derived lists (filter, hide viewed, grouping)
  ui/*.ts     titlebar, sidebar, file list, diff view, palette, welcome
  highlight.ts  lazy highlight.js per language, merged with word-diff ranges
  styles/     tokens.css (all theming), components css
```

## Crates

- **git2** (libgit2, vendored, no network features). Chosen over gix because libgit2's
  `diff_tree_to_workdir_with_index` + `statuses` give, in one well-trodden API: the index stat
  cache (fast on big repos), git's own filters (autocrlf etc., so files don't all show as changed on
  Windows), binary detection, rename detection, submodule skipping and an empty-tree diff for
  repos with no commits. gix's status/worktree-diff is still maturing.
- **similar**: word-level emphasis inside paired removed/added lines (libgit2 is line-based only).
- **notify** + **notify-debouncer-full** (150 ms).
- Ignore rules: the brief suggests the `ignore` crate. I'm using libgit2's
  `status_should_ignore` instead, because it applies exactly git's rules (nested .gitignore,
  .git/info/exclude, core.excludesFile) with no second implementation to keep in sync.
  If you'd rather have `ignore`, it's a one-function swap.
- **tauri 2**, **tauri-plugin-dialog** (folder picker), serde, tempfile (tests).
- Frontend: vite, typescript, highlight.js (core + lazily imported languages),
  @fontsource-variable/geist and jetbrains-mono (bundled locally).

No shelling out to git.

## Data model (Rust → TS, serde camelCase)

```
FileEntry { path, oldPath?, status: M|A|D|U|R|T, staged: none|partial|full,
            additions, deletions, binary, tooLarge, diffHash, changedAt }
FileDiff  { path, kind: text|binary|tooLarge|submodule, truncated, hunks: Hunk[] }
Hunk      { oldStart, oldLines, newStart, newLines, header, lines: Line[] }
Line      { k: ' '|'+'|'-', o?: u32, n?: u32, t: string, e?: [start,end][] }   // e = word emphasis
Snapshot  { root, name, branch, files: FileEntry[] }
```

`diffHash` is a hash of the file's rendered diff; viewed marks store `path -> diffHash`, so a mark
silently becomes "changed since viewed" when the diff changes.

## Event flow

1. `open_repo(path)` → full scan → `Snapshot`. Watcher starts.
2. Watcher batches (150 ms debounce) are classified:
   - worktree paths (ignored paths dropped) → rescan **only those paths** (pathspec-limited status +
     diff), plus the other half of any rename pair they belong to;
   - `.git/index`, `.git/HEAD`, `.git/refs/**`, `.git/packed-refs` → full rescan (staging,
     commits and branch switches can touch any file; libgit2's stat cache keeps it cheap) but
     diffs are only rebuilt for files whose fingerprint changed;
   - `index.lock` and other `.git` noise are ignored.
3. Rust emits `repo:changed { upserts, removed, branch }`; the frontend patches the list, pulses
   updated rows, and refetches the open diff via `get_diff(path)` (served from the Rust cache).
4. Repo root removed/moved → `repo:gone`.

Reads that hit a mid-write index retry up to 3× with short backoff, silently.

## Limits

- Files > 2 MB: "too large" notice, no diff. Diffs > 20 000 lines: truncated with a notice.
- Syntax highlighting skipped for diffs over ~5 000 lines.
- Diff view renders lazily in 200-line chunks (IntersectionObserver + `content-visibility`), which
  keeps the DOM small, works with line-wrap, and preserves scroll position on refresh.

## Milestones (one commit each)

a. Scaffold, open repo (picker / CLI arg / recents), static file list
b. Diff rendering (unified, hunk headers, collapsed regions, word emphasis, highlighting)
c. Live watching
d. Viewed state, follow mode, shortcuts, command palette
e. Edge cases, polish pass, screenshots in both themes, README, release build
