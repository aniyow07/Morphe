//! Pure git logic: which files differ from HEAD, and what their diffs look like.
//! No Tauri types here, so everything is unit-testable against temp-dir repos.

use git2::{Delta, DiffFindOptions, DiffOptions, ErrorCode, Patch, Repository, Status, StatusOptions};
use serde::Serialize;
use similar::{capture_diff_slices, Algorithm, DiffOp};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// Files larger than this (either side) get a "too large" notice instead of a diff.
pub const MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;
/// Diffs longer than this many lines are cut off with a notice.
pub const MAX_DIFF_LINES: usize = 20_000;
/// Lines longer than this skip word-level emphasis (minified files etc.).
const MAX_EMPHASIS_LEN: usize = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Staged {
    None,
    Partial,
    Full,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Text,
    Binary,
    TooLarge,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    /// One of M, A, D, U (untracked), R, T (type change).
    pub status: &'static str,
    pub staged: Staged,
    pub additions: u32,
    pub deletions: u32,
    pub kind: Kind,
    /// Hash of the rendered diff. Viewed marks are keyed on it.
    pub diff_hash: String,
    /// Working-tree mtime in ms since the epoch (0 when the file is gone).
    pub mtime: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub path: String,
    pub kind: Kind,
    pub truncated: bool,
    /// Number of lines on the new side, so the UI can offer the unchanged tail.
    pub new_total: u32,
    pub hunks: Vec<Hunk>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// The function/section context git prints after the second `@@`.
    pub section: String,
    pub lines: Vec<Line>,
}

/// One diff line, with short field names because large diffs cross the IPC bridge.
#[derive(Debug, Clone, Serialize)]
pub struct Line {
    /// ' ' context, '+' added, '-' removed
    pub k: char,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub o: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    pub t: String,
    /// Word-level emphasis as [start, end) UTF-16 offsets into `t`.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub e: Vec<(u32, u32)>,
}

/// A scanned file plus what's needed to skip rebuilding its diff next time.
#[derive(Debug, Clone)]
pub struct Scanned {
    pub entry: FileEntry,
    pub diff: Arc<FileDiff>,
    /// Fingerprint of everything the diff depends on (ids, size, mtime, status).
    pub fingerprint: u64,
}

/// Scan the working tree against HEAD (or the empty tree when there are no commits).
///
/// With `paths`, only those files or directories are looked at. `prev` lets unchanged
/// files reuse their previous diff instead of rebuilding it.
pub fn scan(
    repo: &Repository,
    paths: Option<&[String]>,
    prev: &HashMap<String, Scanned>,
) -> Result<Vec<Scanned>, git2::Error> {
    let workdir = repo
        .workdir()
        .ok_or_else(|| git2::Error::from_str("bare repositories are not supported"))?
        .to_path_buf();
    let staged = staged_map(repo, paths)?;
    let head_tree = head_tree(repo)?;

    let mut opts = DiffOptions::new();
    opts.include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true)
        .ignore_submodules(true)
        .include_typechange(true)
        .context_lines(3)
        .max_size(MAX_FILE_BYTES as i64);
    if let Some(paths) = paths {
        opts.disable_pathspec_match(true);
        for p in paths {
            opts.pathspec(p);
        }
    }
    let mut diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))?;
    let mut find = DiffFindOptions::new();
    find.renames(true).for_untracked(true);
    diff.find_similar(Some(&mut find))?;

    let mut out = Vec::new();
    for (idx, delta) in diff.deltas().enumerate() {
        let status = match delta.status() {
            Delta::Added | Delta::Copied => "A",
            Delta::Untracked => "U",
            Delta::Deleted => "D",
            Delta::Modified | Delta::Conflicted => "M",
            Delta::Renamed => "R",
            Delta::Typechange => "T",
            _ => continue,
        };
        let Some(path) = delta.new_file().path().or(delta.old_file().path()).map(path_str) else {
            continue;
        };
        let old_path = (status == "R").then(|| delta.old_file().path().map(path_str)).flatten();
        // Submodules (gitlinks) have no content of their own to show here.
        if delta.new_file().mode() == git2::FileMode::Commit || delta.old_file().mode() == git2::FileMode::Commit {
            continue;
        }

        let (size, mtime) = file_meta(&workdir.join(&path));
        let old_id = delta.old_file().id();
        let new_id = delta.new_file().id();
        let fingerprint = fnv(&[
            status.as_bytes(),
            old_id.as_bytes(),
            new_id.as_bytes(),
            &size.to_le_bytes(),
            &mtime.to_le_bytes(),
            old_path.as_deref().unwrap_or("").as_bytes(),
        ]);
        let staged_state = staged.get(&path).copied().unwrap_or(Staged::None);

        if let Some(p) = prev.get(&path) {
            if p.fingerprint == fingerprint {
                let mut entry = p.entry.clone();
                entry.staged = staged_state;
                out.push(Scanned { entry, diff: p.diff.clone(), fingerprint });
                continue;
            }
        }

        let old_size = if old_id.is_zero() {
            0
        } else {
            repo.odb()?.read_header(old_id).map(|(s, _)| s as u64).unwrap_or(0)
        };
        let too_large = size > MAX_FILE_BYTES || old_size > MAX_FILE_BYTES;

        let (diff_obj, additions, deletions) = if too_large {
            (
                FileDiff { path: path.clone(), kind: Kind::TooLarge, truncated: false, new_total: 0, hunks: vec![] },
                0,
                0,
            )
        } else {
            match Patch::from_diff(&diff, idx)? {
                Some(patch) if !patch.delta().flags().is_binary() => build_text_diff(&path, &patch, &workdir)?,
                _ => (
                    FileDiff { path: path.clone(), kind: Kind::Binary, truncated: false, new_total: 0, hunks: vec![] },
                    0,
                    0,
                ),
            }
        };

        let diff_hash = match diff_obj.kind {
            Kind::Text => hash_text_diff(status, &diff_obj),
            // No text to hash: identify the content by its ids, or by size+mtime when
            // libgit2 didn't hash the working-tree file.
            _ => format!(
                "{:016x}",
                fnv(&[status.as_bytes(), old_id.as_bytes(), new_id.as_bytes(), &size.to_le_bytes(), &mtime.to_le_bytes()])
            ),
        };

        out.push(Scanned {
            entry: FileEntry {
                path,
                old_path,
                status,
                staged: staged_state,
                additions,
                deletions,
                kind: diff_obj.kind,
                diff_hash,
                mtime,
            },
            diff: Arc::new(diff_obj),
            fingerprint,
        });
    }
    Ok(out)
}

fn head_tree(repo: &Repository) -> Result<Option<git2::Tree<'_>>, git2::Error> {
    match repo.head() {
        Ok(head) => Ok(Some(head.peel_to_tree()?)),
        Err(e) if matches!(e.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// path -> staged state, from git status (HEAD vs index, index vs working tree).
fn staged_map(repo: &Repository, paths: Option<&[String]>) -> Result<HashMap<String, Staged>, git2::Error> {
    let mut so = StatusOptions::new();
    so.include_untracked(true)
        .recurse_untracked_dirs(true)
        .exclude_submodules(true)
        .renames_head_to_index(true);
    if let Some(paths) = paths {
        so.disable_pathspec_match(true);
        for p in paths {
            so.pathspec(p);
        }
    }
    let statuses = repo.statuses(Some(&mut so))?;
    let index_bits =
        Status::INDEX_NEW | Status::INDEX_MODIFIED | Status::INDEX_DELETED | Status::INDEX_RENAMED | Status::INDEX_TYPECHANGE;
    let wt_bits = Status::WT_MODIFIED | Status::WT_DELETED | Status::WT_RENAMED | Status::WT_TYPECHANGE;
    let mut map = HashMap::new();
    for e in statuses.iter() {
        let s = e.status();
        let staged = match (s.intersects(index_bits), s.intersects(wt_bits)) {
            (true, true) => Staged::Partial,
            (true, false) => Staged::Full,
            _ => Staged::None,
        };
        let path = e
            .head_to_index()
            .and_then(|d| d.new_file().path().map(path_str))
            .or_else(|| e.path().ok().map(str::to_string));
        if let Some(path) = path {
            map.insert(path, staged);
        }
    }
    Ok(map)
}

fn build_text_diff(path: &str, patch: &Patch, workdir: &Path) -> Result<(FileDiff, u32, u32), git2::Error> {
    let mut hunks = Vec::with_capacity(patch.num_hunks());
    let mut total = 0usize;
    let mut truncated = false;
    for h in 0..patch.num_hunks() {
        let (hunk, count) = patch.hunk(h)?;
        let mut lines = Vec::with_capacity(count);
        for l in 0..count {
            if total >= MAX_DIFF_LINES {
                truncated = true;
                break;
            }
            let dl = patch.line_in_hunk(h, l)?;
            let k = dl.origin();
            if !matches!(k, ' ' | '+' | '-') {
                continue; // "\ No newline at end of file" markers
            }
            lines.push(Line { k, o: dl.old_lineno(), n: dl.new_lineno(), t: clean_line(dl.content()), e: vec![] });
            total += 1;
        }
        add_word_emphasis(&mut lines);
        let header = String::from_utf8_lossy(hunk.header());
        let section = header.splitn(3, "@@").nth(2).unwrap_or("").trim().to_string();
        hunks.push(Hunk {
            old_start: hunk.old_start(),
            old_lines: hunk.old_lines(),
            new_start: hunk.new_start(),
            new_lines: hunk.new_lines(),
            section,
            lines,
        });
        if truncated {
            break;
        }
    }
    let (_, additions, deletions) = patch.line_stats()?;
    let new_total = std::fs::read(workdir.join(path)).map(|b| count_lines(&b)).unwrap_or(0);
    Ok((
        FileDiff { path: path.to_string(), kind: Kind::Text, truncated, new_total, hunks },
        additions as u32,
        deletions as u32,
    ))
}

fn hash_text_diff(status: &str, d: &FileDiff) -> String {
    let mut h = Fnv::new();
    h.write(status.as_bytes());
    for hunk in &d.hunks {
        for line in &hunk.lines {
            h.write(&[line.k as u8]);
            h.write(line.t.as_bytes());
            h.write(b"\n");
        }
    }
    format!("{:016x}", h.0)
}

/// Lines `start..=end` (1-based) of the working-tree file, for expanding unchanged regions.
pub fn read_lines(workdir: &Path, path: &str, start: u32, end: u32) -> std::io::Result<Vec<String>> {
    let bytes = std::fs::read(workdir.join(path))?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text
        .split('\n')
        .skip(start.saturating_sub(1) as usize)
        .take((end + 1).saturating_sub(start) as usize)
        .map(|l| l.strip_suffix('\r').unwrap_or(l).to_string())
        .collect())
}

/// Full text of the working-tree file, or the HEAD version if it was deleted.
/// `None` for binary or oversized content.
pub fn file_text(repo: &Repository, path: &str) -> Result<Option<String>, git2::Error> {
    let workdir = repo.workdir().ok_or_else(|| git2::Error::from_str("bare repository"))?;
    let bytes = match std::fs::read(workdir.join(path)) {
        Ok(b) => b,
        Err(_) => match head_tree(repo)? {
            Some(tree) => {
                let entry = tree.get_path(Path::new(path))?;
                repo.find_blob(entry.id())?.content().to_vec()
            }
            None => return Ok(None),
        },
    };
    if bytes.len() as u64 > MAX_FILE_BYTES || bytes.iter().take(8000).any(|&b| b == 0) {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
}

/// Short name of the current branch, also for unborn branches and detached HEAD.
pub fn branch_name(repo: &Repository) -> String {
    match repo.head() {
        Ok(head) if head.is_branch() => head.shorthand().unwrap_or("HEAD").to_string(),
        Ok(head) => match head.target() {
            Some(oid) => format!("detached at {}", &oid.to_string()[..7]),
            None => "HEAD".into(),
        },
        Err(_) => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().ok().flatten().map(|t| t.trim_start_matches("refs/heads/").to_string()))
            .unwrap_or_else(|| "HEAD".into()),
    }
}

// ---------- word-level emphasis ----------

/// Pairs each run of removed lines with the added lines that follow and marks the
/// words that differ, when the two lines are similar enough for that to help.
fn add_word_emphasis(lines: &mut [Line]) {
    let mut i = 0;
    while i < lines.len() {
        if lines[i].k != '-' {
            i += 1;
            continue;
        }
        let del_start = i;
        while i < lines.len() && lines[i].k == '-' {
            i += 1;
        }
        let add_start = i;
        while i < lines.len() && lines[i].k == '+' {
            i += 1;
        }
        let pairs = (add_start - del_start).min(i - add_start);
        for p in 0..pairs {
            let (o, n) = (del_start + p, add_start + p);
            if let Some((eo, en)) = word_ranges(&lines[o].t, &lines[n].t) {
                lines[o].e = eo;
                lines[n].e = en;
            }
        }
    }
}

type Ranges = Vec<(u32, u32)>;

pub fn word_ranges(a: &str, b: &str) -> Option<(Ranges, Ranges)> {
    if a.len() > MAX_EMPHASIS_LEN || b.len() > MAX_EMPHASIS_LEN || a == b {
        return None;
    }
    let (ta, tb) = (tokens(a), tokens(b));
    let (oa, ob) = (utf16_offsets(&ta), utf16_offsets(&tb));
    let (mut ra, mut rb) = (Vec::new(), Vec::new());
    let mut same = 0u32;
    for op in capture_diff_slices(Algorithm::Myers, &ta, &tb) {
        match op {
            DiffOp::Equal { old_index, len, .. } => same += oa[old_index + len] - oa[old_index],
            DiffOp::Delete { old_index, old_len, .. } => push_range(&mut ra, oa[old_index], oa[old_index + old_len]),
            DiffOp::Insert { new_index, new_len, .. } => push_range(&mut rb, ob[new_index], ob[new_index + new_len]),
            DiffOp::Replace { old_index, old_len, new_index, new_len } => {
                push_range(&mut ra, oa[old_index], oa[old_index + old_len]);
                push_range(&mut rb, ob[new_index], ob[new_index + new_len]);
            }
        }
    }
    let total = oa[ta.len()] + ob[tb.len()];
    // Below ~50% shared text the line was rewritten; highlighting fragments is just noise.
    if total == 0 || same * 4 < total {
        return None;
    }
    Some((ra, rb))
}

fn push_range(ranges: &mut Ranges, start: u32, end: u32) {
    if start == end {
        return;
    }
    match ranges.last_mut() {
        Some(last) if last.1 == start => last.1 = end,
        _ => ranges.push((start, end)),
    }
}

/// Split into identifier runs, whitespace runs, and single punctuation characters.
fn tokens(s: &str) -> Vec<&str> {
    #[derive(PartialEq)]
    enum C {
        Word,
        Space,
        Other,
    }
    let class = |c: char| {
        if c.is_alphanumeric() || c == '_' {
            C::Word
        } else if c.is_whitespace() {
            C::Space
        } else {
            C::Other
        }
    };
    let mut out = Vec::new();
    let mut start = 0;
    let mut prev: Option<C> = None;
    for (i, c) in s.char_indices() {
        let cl = class(c);
        if let Some(p) = &prev {
            if *p != cl || cl == C::Other {
                out.push(&s[start..i]);
                start = i;
            }
        }
        prev = Some(cl);
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

fn utf16_offsets(tokens: &[&str]) -> Vec<u32> {
    let mut out = Vec::with_capacity(tokens.len() + 1);
    let mut acc = 0u32;
    out.push(0);
    for t in tokens {
        acc += t.encode_utf16().count() as u32;
        out.push(acc);
    }
    out
}

// ---------- small helpers ----------

fn path_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn clean_line(content: &[u8]) -> String {
    let s = String::from_utf8_lossy(content);
    let s = s.strip_suffix('\n').unwrap_or(&s);
    s.strip_suffix('\r').unwrap_or(s).to_string()
}

fn count_lines(bytes: &[u8]) -> u32 {
    if bytes.is_empty() {
        return 0;
    }
    let n = bytes.iter().filter(|&&b| b == b'\n').count() as u32;
    if bytes.ends_with(b"\n") {
        n
    } else {
        n + 1
    }
}

fn file_meta(p: &Path) -> (u64, u64) {
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            let mtime = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            (m.len(), mtime)
        }
        Err(_) => (0, 0),
    }
}

/// FNV-1a: tiny, stable across Rust versions (viewed marks are persisted).
struct Fnv(u64);
impl Fnv {
    fn new() -> Self {
        Fnv(0xcbf29ce484222325)
    }
    fn write(&mut self, bytes: &[u8]) {
        for b in bytes {
            self.0 ^= *b as u64;
            self.0 = self.0.wrapping_mul(0x100000001b3);
        }
    }
}

pub fn fnv(parts: &[&[u8]]) -> u64 {
    let mut h = Fnv::new();
    for p in parts {
        h.write(p);
        h.write(&[0xff]);
    }
    h.0
}

#[cfg(test)]
mod tests;
