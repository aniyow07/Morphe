<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="112" height="112" alt="Morphe icon">
</p>

<h1 align="center">Morphe</h1>

<p align="center">
  <b>A live, read-only view of what's changing in your git repository.</b><br>
  Keep it open beside your editor, or beside an agent like Claude Code, and watch every edit land as a diff.
</p>

<p align="center">
  Tauri 2 · Rust + libgit2 · plain TypeScript · Windows, macOS, Linux
</p>

---

## What it does

**Watch changes as they happen**

- Shows everything that differs from `HEAD`: staged, unstaged and untracked files, with renames.
- Updates the moment a file is saved. There's no polling, and changed files flash briefly so you can see what just moved.
- **Follow latest edit** jumps to each file as it changes.
- **Compare with** another branch to see everything since your branch split off, committed and uncommitted.

**Read diffs comfortably**

- Unified or side-by-side view, with word-level highlights and syntax highlighting.
- Collapsed "N unchanged lines" sections, each labelled with the function or heading it sits in.
- A rendered preview for Markdown files.
- Find in the open file, an ignore-whitespace setting, and a line-wrap toggle.
- Open any file in VS Code, Cursor or Zed, or double-click a line to jump straight to it. The editor opens the whole repository, then the file at that line.
- In side-by-side view, drag the middle line to give one side more room (double-click resets it).
- A change map beside the scrollbar shows where the additions and removals sit in the file. Click it to jump, or step through changes with `N` and `P`.
- Click a line number (Shift-click for a range) to copy a `@path#L10-20` reference for Claude Code, copy the code, or open that line in your editor.

**Keep track of what you've reviewed**

- Tick files as **Viewed**. A tick resets when the file changes again, and **Hide viewed** clears the list down to what's left.
- Each file shows its status (M, A, D, U, R, T), a file type icon, `+`/`−` counts and a staged badge.
- A progress ring in the title bar counts what's left. `U` moves to the next file you haven't viewed, and the command palette can mark everything viewed or clear the marks.

**Do anything from the keyboard**

- `Ctrl+Shift+P` opens a command palette with every action; `Ctrl+P` jumps to a file.

**Look back through history**

- Browse any local branch's commits, grouped by day on a timeline and loaded 100 at a time.
- Open a commit to see its files and diffs, step to newer or older commits, and fold the details away.
- **All files** shows the whole repository as a folder tree, for your working tree or as it was at any commit, with changed files marked in their status color.

**Make it yours**

- Eight themes: Graphite, Midnight, Ember, Forest and High contrast (dark), and Paper, Sand and Mist (light). Choose one of each, then follow the OS or pick a mode.
- You can also set the diff text size, tab width, row density and reduced motion, and choose to reopen your last repository on launch.

## Install

Build the installer (see [Building](#building)), then run:

```
src-tauri\target\release\bundle\nsis\Morphe_0.1.0_x64-setup.exe
```

The same folder has an `.msi` too. On macOS and Linux, `npm run tauri build` produces a `.dmg` or `.app`, or a `.deb` or `.AppImage`.

Open a repository from the start screen, or pass a path: `morphe C:\path\to\repo`. Any folder inside a repository works.

## Keyboard

| Key | Action |
|---|---|
| `J` / `K` | Next / previous file |
| `Shift+J` / `Shift+K` | Next / previous commit, in History |
| `N` / `P` | Next / previous change in the open file |
| `V` | Mark the selected file viewed |
| `U` | Next file you haven't viewed |
| `C` | Copy the file path, or a reference to the selected lines |
| `O` | Open the file in your editor |
| `S` / `W` | Side by side / wrap long lines |
| `E` | Show all unchanged lines |
| `Ctrl+Shift+P` | Run a command |
| `Ctrl+=` / `Ctrl+-` | Larger / smaller diff text |
| `?` | Keyboard shortcuts |
| `/` | Filter files (`Esc` clears) |
| `Ctrl+P` / `⌘P` | Jump to a file |
| `Ctrl+F` / `⌘F` | Find in the open file (`Enter` / `Shift+Enter` for next / previous) |
| `Ctrl+,` / `⌘,` | Settings |
| `Esc` | Back from a commit to the commit list |

## Building

Prerequisites: Rust (stable, 1.85+), Node 20+, and the
[Tauri 2 system dependencies](https://tauri.app/start/prerequisites/) for your OS
(WebView2 on Windows, Xcode command-line tools on macOS, webkit2gtk 4.1 on Linux).

```bash
npm install
npm run tauri dev                      # run with hot reload
npm run tauri dev -- -- C:\path\repo   # open a repository straight away
npm run tauri build                    # release build + installers in src-tauri/target/release/bundle
```

Tests:

```bash
cd src-tauri && cargo test
```

The app icon's source is `src-tauri/icons/icon-source.svg`. To regenerate every size from it,
export it to a 1024×1024 PNG and run `npx tauri icon <that png>`.

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
  ui/         title bar, sidebar, history, file tree, diff view, settings, palette, welcome
  highlight.ts, markdown.ts, theme.ts
  styles/tokens.css   every color, size, radius and duration (base light and dark, plus each alternate theme)
```

**Reading the repo.** The Rust side owns all git and filesystem work through `git2` (libgit2).
It diffs `HEAD` (or the empty tree when there are no commits, or the merge base when comparing
with a branch) against the index, and the index against the working tree using its stat cache,
so unchanged files cost a `stat`, not a read. Keeping the two halves gives the staged badges
without a second walk. It applies git's own filters (so `core.autocrlf` doesn't make every file look changed),
detects binaries, finds renames (including an unstaged delete + new file), and skips submodules.
Morphe never shells out to `git`.

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
