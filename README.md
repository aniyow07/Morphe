# Morphe

A fast, read-only, live viewer of a git repository's working-tree diff. Keep it open beside your
editor (or an agent like Claude Code) and it shows exactly what differs from `HEAD`, file by file,
updating the moment files change.

- Everything that differs from `HEAD`: staged, unstaged and untracked, with renames
- Per file: status (M/A/D/U/R/T), `+`/`−` counts, staged / partially-staged badge
- Unified view with old/new line numbers, hunk headers, word-level highlights, syntax highlighting,
  and collapsed "N unchanged lines" regions you can expand
- Side-by-side view, line wrapping, and a rendered preview for Markdown files
- Live updates with no polling; changed files get a brief accent trace and an "updated" dot
- "Follow latest edit" mode, per-file "Viewed" marks that reset when the file changes again,
  and "Hide viewed"
- History: any local branch's commits, newest first, loaded 100 at a time as you scroll.
  Selecting a commit shows its changes against its first parent in the same file list and diff
  view (unified, side by side, Markdown preview)
- "All files": the whole working tree as a folder tree (loaded one folder at a time, ignored
  files left out), changed files in their status color and folders showing how many changes
  they hold. Unchanged files open read-only; J / K still step through changed files only
- Light, dark, or follow the OS

## Keyboard

| Key | Action |
|---|---|
| `J` / `K` (or `↓` / `↑` in the list) | Next / previous file |
| `Shift+J` / `Shift+K` (or `↓` / `↑` in the commit list) | Next / previous commit, in History |
| `V` | Toggle viewed for the selected file |
| `/` | Focus the filter box (`Esc` clears it) |
| `Ctrl+P` / `⌘P` | Jump to a file |

## Running it

Prerequisites: Rust (stable, 1.85+), Node 20+, and the
[Tauri 2 system dependencies](https://tauri.app/start/prerequisites/) for your OS
(WebView2 on Windows, Xcode command-line tools on macOS, webkit2gtk 4.1 on Linux).

```bash
npm install
npm run tauri dev                      # run with hot reload
npm run tauri dev -- -- C:\path\repo   # open a repository straight away
npm run tauri build                    # release build + installers in src-tauri/target/release/bundle
```

The built binary takes a path too: `morphe <path>`. Any folder inside a repository works.

Tests:

```bash
cd src-tauri && cargo test
```

## How it works

```
src-tauri/src/
  git.rs      status + per-file diffs against HEAD (libgit2), word-level emphasis (similar)
  session.rs  the open repo: cached results, path-limited and full rescans, change sets
  history.rs  branches, the paged commit log, one commit's files and diffs
  watch.rs    notify + 150 ms debounce, classifies events, drops ignored paths
  store.rs    app-data JSON: recent repos, viewed marks per repo
  lib.rs      Tauri commands and events
src/
  main.ts     wiring, keyboard, event handling
  state.ts    app state and derived file list
  ui/         title bar, sidebar, diff view, palette, welcome, tooltip
  highlight.ts, markdown.ts, theme.ts
  styles/tokens.css   every color, size, radius and duration (both themes)
```

**Reading the repo.** The Rust side owns all git and filesystem work through `git2` (libgit2).
`diff_tree_to_workdir_with_index` diffs `HEAD` (or the empty tree when there are no commits)
against the working tree using the index's stat cache, so unchanged files cost a `stat`, not a
read. It applies git's own filters (so `core.autocrlf` doesn't make every file look changed),
detects binaries, finds renames (including an unstaged delete + new file), and skips submodules.
`git status` supplies the staged / partially-staged badge. Morphe never shells out to `git`.

**Live updates.** One recursive `notify` watch on the repository (plus its parent, to notice the
repository itself being moved or deleted), debounced at 150 ms:

- a working-tree file changed: only those paths are rescanned (a rename's other half is included);
- `.git/index`, `HEAD`, `refs/` or `packed-refs` changed: if `HEAD` or the index's entries
  changed (staging, commits, branch switches), a full rescan, where each file's diff is only
  rebuilt when its fingerprint (blob ids, size, mtime, status) changed. Index rewrites that
  only refresh stat data, which `git status` and editors do constantly, cost one index read
  and nothing more;
- ignored paths are dropped using git's own rules (`status_should_ignore`, which covers nested
  `.gitignore`, `.git/info/exclude` and the global excludes file);
- reads that race with git writing the index retry quietly.

The backend sends a change set (`upserts`, `removed`, `branch`) as a Tauri event. The frontend
patches the list in place, refetches the open file's diff (from the Rust cache), and keeps the
scroll position anchored to the same source line.

**Rendering.** Plain TypeScript and DOM, no framework. Diffs render lazily in 200-line chunks
with exact-height placeholders, so a 20,000-line diff keeps a small DOM. Syntax highlighting uses
highlight.js core with one grammar loaded on demand per language, and is skipped for diffs over
5,000 lines. Markdown preview uses marked + DOMPurify; remote images are replaced by their alt
text because Morphe makes no network requests.

**History.** The log is walked newest-first by commit time (git log's default order) with a
resumable walk, so each page of 100 continues where the last one stopped instead of starting
over. Opening a commit diffs its tree against its first parent's (the empty tree for a root
commit) with rename detection; file counts come up front and each file's full diff is built the
first time you open it. The last 32 opened commits stay cached, since commits never change. When
a branch or `HEAD` moves, the list reloads.

**Viewed marks** are stored per repository in the app-data directory as `path → diff hash`. When
the file's diff changes, the hash no longer matches and the file shows "Changed since viewed".

**Speed.** `cargo run --release --example bench -- <repo>` times the scans. On a synthetic
25,000-file repository with 60 changed files (Windows 11, NTFS):

| | time |
|---|---|
| open + first scan | 2.5 s |
| full rescan (after a commit or `git add`) | 2.5 s |
| index rewritten with the same entries | 20 ms |
| one edited file | 24 ms |

The full scan is bound by walking the working tree: a plain `std::fs` walk of the same tree
takes 1.7 s on that machine. A pandas checkout has about a tenth as many files.

**Limits.** Files over 2 MB show a notice instead of a diff. Diffs over 20,000 lines are
truncated with a notice (the `+`/`−` counts stay exact).

## Developing the UI without a window

`src/dev/mock.ts` replaces the Rust side in a normal browser, which is handy for UI work and
screenshots. Dump any repository to a fixture, then open the dev server with `?mock`:

```bash
cd src-tauri && cargo run --example dump -- C:\path\repo > ../.mock/fixture.json
npm run dev    # then open http://localhost:1420/?mock&select=path/to/file
```

The mock is only included in dev builds.
