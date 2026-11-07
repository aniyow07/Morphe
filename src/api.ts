// Typed bridge to the Rust side. Every command and event Morphe uses is declared here.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Status = "M" | "A" | "D" | "U" | "R" | "T";
export type Staged = "none" | "partial" | "full";
export type Kind = "text" | "binary" | "tooLarge";

export interface FileEntry {
  path: string;
  oldPath?: string;
  status: Status;
  staged: Staged;
  additions: number;
  deletions: number;
  kind: Kind;
  diffHash: string;
  mtime: number;
}

export interface Line {
  k: " " | "+" | "-";
  o?: number;
  n?: number;
  t: string;
  e?: [number, number][];
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  section: string;
  lines: Line[];
}

export interface FileDiff {
  path: string;
  kind: Kind;
  truncated: boolean;
  newTotal: number;
  hunks: Hunk[];
}

export interface Snapshot {
  root: string;
  name: string;
  branch: string;
  files: FileEntry[];
  viewed: Record<string, string>;
}

export interface Upsert extends FileEntry {
  contentChanged: boolean;
}

export interface Change {
  upserts: Upsert[];
  removed: string[];
  branch: string;
}

export interface DirEntry {
  name: string;
  dir: boolean;
}

export interface Branch {
  /** Short name, or "HEAD" for a detached HEAD. */
  name: string;
  current: boolean;
}

export interface CommitInfo {
  id: string;
  summary: string;
  author: string;
  /** Seconds since the epoch. */
  time: number;
  parents: number;
}

export interface CommitChanges {
  commit: CommitInfo;
  body: string;
  files: FileEntry[];
}

export interface Recent {
  path: string;
  name: string;
  openedAt: number;
}

export const api = {
  openRepo: (path: string) => invoke<Snapshot>("open_repo", { path }),
  closeRepo: () => invoke<void>("close_repo"),
  getDiff: (path: string) => invoke<FileDiff | null>("get_diff", { path }),
  getLines: (path: string, start: number, end: number) => invoke<string[]>("get_lines", { path, start, end }),
  getFileText: (path: string) => invoke<string | null>("get_file_text", { path }),
  setViewed: (path: string, hash: string | null) => invoke<void>("set_viewed", { path, hash }),
  recentRepos: () => invoke<Recent[]>("recent_repos"),
  forgetRecent: (path: string) => invoke<void>("forget_recent", { path }),
  launchPath: () => invoke<string | null>("launch_path"),
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  listBranches: () => invoke<Branch[]>("list_branches"),
  /** Rescan with whitespace ignored or not, against HEAD or the merge base with `base`. */
  setScanOptions: (ignoreWhitespace: boolean, base: string | null) => invoke<Snapshot>("set_scan_options", { ignoreWhitespace, base }),
  openInEditor: (path: string, line: number | null, editor: string) => invoke<void>("open_in_editor", { path, line, editor }),
  listCommits: (branch: string | null, skip: number, limit: number) => invoke<CommitInfo[]>("list_commits", { branch, skip, limit }),
  openCommit: (id: string) => invoke<CommitChanges>("open_commit", { id }),
};

/** Reads that work against the working tree, or against a commit when `commit` is set. */
export const source = {
  diff: (path: string, commit: string | null) =>
    commit ? invoke<FileDiff | null>("get_commit_diff", { id: commit, path }) : api.getDiff(path),
  lines: (path: string, start: number, end: number, commit: string | null) =>
    commit ? invoke<string[]>("get_commit_lines", { id: commit, path, start, end }) : api.getLines(path, start, end),
  text: (path: string, commit: string | null) =>
    commit ? invoke<string | null>("get_commit_file_text", { id: commit, path }) : api.getFileText(path),
};

export const events = {
  onChanged: (cb: (c: Change) => void): Promise<UnlistenFn> => listen<Change>("repo:changed", (e) => cb(e.payload)),
  onBranch: (cb: (b: string) => void): Promise<UnlistenFn> => listen<string>("repo:branch", (e) => cb(e.payload)),
  onGone: (cb: (root: string) => void): Promise<UnlistenFn> => listen<string>("repo:gone", (e) => cb(e.payload)),
  /** A branch or HEAD moved (commit, checkout, fetch into a local branch). */
  onRefs: (cb: () => void): Promise<UnlistenFn> => listen("repo:refs", () => cb()),
};
