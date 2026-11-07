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
};

export const events = {
  onChanged: (cb: (c: Change) => void): Promise<UnlistenFn> => listen<Change>("repo:changed", (e) => cb(e.payload)),
  onBranch: (cb: (b: string) => void): Promise<UnlistenFn> => listen<string>("repo:branch", (e) => cb(e.payload)),
  onGone: (cb: (root: string) => void): Promise<UnlistenFn> => listen<string>("repo:gone", (e) => cb(e.payload)),
};
