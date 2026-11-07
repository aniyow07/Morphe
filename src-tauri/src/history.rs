//! Commit history: local branches, a paged newest-first log, and one commit's changes against
//! its first parent. Read-only; a commit never changes, so its results are cached.

use crate::git::{self, FileDiff, FileEntry, Kind, Staged, MAX_FILE_BYTES};
use git2::{BranchType, Commit, DiffFindOptions, DiffOptions, Oid, Patch, Repository};
use serde::Serialize;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::Path;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    /// Short name, or "HEAD" for a detached HEAD.
    pub name: String,
    pub current: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub id: String,
    pub summary: String,
    pub author: String,
    /// Commit time, seconds since the epoch.
    pub time: i64,
    pub parents: usize,
}

/// What the UI shows for a selected commit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
    pub commit: CommitInfo,
    /// The message after the summary line, trimmed.
    pub body: String,
    pub files: Vec<FileEntry>,
}

/// Local branches, the current one first. A detached HEAD is listed as "HEAD".
pub fn branches(repo: &Repository) -> Result<Vec<Branch>, git2::Error> {
    let mut out = Vec::new();
    if repo.head_detached().unwrap_or(false) {
        out.push(Branch { name: "HEAD".into(), current: true });
    }
    for b in repo.branches(Some(BranchType::Local))? {
        let (b, _) = b?;
        if let Ok(Some(name)) = b.name() {
            out.push(Branch { name: name.to_string(), current: b.is_head() });
        }
    }
    out.sort_by(|a, b| b.current.cmp(&a.current).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// The commit a branch (or HEAD, for `None` or "HEAD") points at; `None` before the first commit.
pub fn tip(repo: &Repository, branch: Option<&str>) -> Result<Option<Oid>, git2::Error> {
    match branch {
        None | Some("HEAD") => Ok(repo.head().ok().and_then(|h| h.target())),
        Some(name) => Ok(repo.find_branch(name, BranchType::Local)?.get().target()),
    }
}

/// Newest-first walk by commit time (git log's default order) that resumes where the last
/// page stopped, so paging through a long history stays linear.
pub struct Walk {
    pub tip: Oid,
    heap: BinaryHeap<(i64, Oid)>,
    seen: HashSet<Oid>,
    /// Commits handed out so far.
    pub produced: usize,
}

impl Walk {
    pub fn new(repo: &Repository, tip: Oid) -> Walk {
        let mut w = Walk { tip, heap: BinaryHeap::new(), seen: HashSet::new(), produced: 0 };
        w.push(repo, tip);
        w
    }

    fn push(&mut self, repo: &Repository, id: Oid) {
        // A shallow clone's boundary parents are missing; the history just ends there.
        if self.seen.insert(id) {
            if let Ok(c) = repo.find_commit(id) {
                self.heap.push((c.time().seconds(), id));
            }
        }
    }

    pub fn next_page(&mut self, repo: &Repository, limit: usize) -> Result<Vec<CommitInfo>, git2::Error> {
        let mut out = Vec::with_capacity(limit);
        while out.len() < limit {
            let Some((_, id)) = self.heap.pop() else { break };
            let c = repo.find_commit(id)?;
            for p in c.parent_ids() {
                self.push(repo, p);
            }
            out.push(info(&c));
        }
        self.produced += out.len();
        Ok(out)
    }
}

fn info(c: &Commit) -> CommitInfo {
    CommitInfo {
        id: c.id().to_string(),
        summary: c.summary().ok().flatten().unwrap_or("").to_string(),
        author: c.author().name().unwrap_or("").to_string(),
        time: c.time().seconds(),
        parents: c.parent_count(),
    }
}

/// A loaded commit: the file list up front, each file's diff built on first request.
pub struct CommitData {
    pub changes: CommitChanges,
    /// path -> (old blob, new blob); a zero id means the side doesn't exist.
    blobs: HashMap<String, (Oid, Oid)>,
    diffs: HashMap<String, Arc<FileDiff>>,
}

impl CommitData {
    pub fn load(repo: &Repository, id: Oid) -> Result<CommitData, git2::Error> {
        let commit = repo.find_commit(id)?;
        let parent_tree = match commit.parent(0) {
            Ok(p) => Some(p.tree()?),
            Err(_) => None, // root commit: everything is added
        };
        let mut opts = DiffOptions::new();
        opts.ignore_submodules(true).include_typechange(true).context_lines(3).max_size(MAX_FILE_BYTES as i64);
        let mut diff = repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&commit.tree()?), Some(&mut opts))?;
        diff.find_similar(Some(DiffFindOptions::new().renames(true)))?;

        let odb = repo.odb()?;
        let size = |id: Oid| if id.is_zero() { 0 } else { odb.read_header(id).map_or(0, |(s, _)| s as u64) };
        let mtime = commit.time().seconds().max(0) as u64 * 1000;
        let mut files = Vec::new();
        let mut blobs = HashMap::new();
        for (idx, delta) in diff.deltas().enumerate() {
            let Some((status, path, old_path)) = git::describe(&delta) else { continue };
            let (old_id, new_id) = (delta.old_file().id(), delta.new_file().id());
            let (kind, additions, deletions) = if size(old_id) > MAX_FILE_BYTES || size(new_id) > MAX_FILE_BYTES {
                (Kind::TooLarge, 0, 0)
            } else {
                match Patch::from_diff(&diff, idx)? {
                    Some(p) if !p.delta().flags().is_binary() => {
                        let (_, add, del) = p.line_stats()?;
                        (Kind::Text, add as u32, del as u32)
                    }
                    _ => (Kind::Binary, 0, 0),
                }
            };
            files.push(FileEntry {
                path: path.clone(),
                old_path,
                status,
                staged: Staged::None,
                additions,
                deletions,
                kind,
                diff_hash: new_id.to_string(),
                mtime,
            });
            blobs.insert(path, (old_id, new_id));
        }
        files.sort_by(|a, b| a.path.cmp(&b.path));
        let body = strip_trailers(commit.body().ok().flatten().unwrap_or(""));
        Ok(CommitData { changes: CommitChanges { commit: info(&commit), body, files }, blobs, diffs: HashMap::new() })
    }

    pub fn diff(&mut self, repo: &Repository, path: &str) -> Result<Option<Arc<FileDiff>>, git2::Error> {
        if let Some(d) = self.diffs.get(path) {
            return Ok(Some(d.clone()));
        }
        let Some(entry) = self.changes.files.iter().find(|f| f.path == path) else { return Ok(None) };
        let (old_id, new_id) = self.blobs[path];
        let d = if entry.kind == Kind::Text {
            let (old, new) = (blob_bytes(repo, old_id)?, blob_bytes(repo, new_id)?);
            let old_path = Path::new(entry.old_path.as_deref().unwrap_or(path));
            let mut opts = DiffOptions::new();
            opts.context_lines(3);
            let patch = Patch::from_buffers(&old, Some(old_path), &new, Some(Path::new(path)), Some(&mut opts))?;
            let (mut d, _, _) = git::build_text_diff(path, &patch)?;
            d.new_total = git::count_lines(&new);
            d
        } else {
            FileDiff { path: path.to_string(), kind: entry.kind, truncated: false, new_total: 0, hunks: vec![] }
        };
        let d = Arc::new(d);
        self.diffs.insert(path.to_string(), d.clone());
        Ok(Some(d))
    }

    /// Lines `start..=end` (1-based) of the file as of this commit.
    pub fn lines(&self, repo: &Repository, path: &str, start: u32, end: u32) -> Result<Vec<String>, git2::Error> {
        let Some(&(_, new_id)) = self.blobs.get(path) else { return Ok(vec![]) };
        Ok(git::slice_lines(&blob_bytes(repo, new_id)?, start, end))
    }

    /// Full text as of this commit (the old text for a deleted file); `None` for binary or
    /// oversized content.
    pub fn text(&self, repo: &Repository, path: &str) -> Result<Option<String>, git2::Error> {
        let Some(&(old_id, new_id)) = self.blobs.get(path) else {
            // A file this commit didn't touch: its content as of the commit.
            let oid = Oid::from_str(&self.changes.commit.id)?;
            let tree = repo.find_commit(oid)?.tree()?;
            let Ok(entry) = tree.get_path(std::path::Path::new(path)) else { return Ok(None) };
            return Ok(git::text_of(blob_bytes(repo, entry.id())?));
        };
        let bytes = blob_bytes(repo, if new_id.is_zero() { old_id } else { new_id })?;
        Ok(git::text_of(bytes))
    }
}

/// One folder of the repository as of commit `id`: folders first, then by name.
pub fn list_tree_dir(repo: &Repository, id: &str, rel: &str) -> Result<Vec<git::DirEntry>, git2::Error> {
    let root = repo.find_commit(Oid::from_str(id)?)?.tree()?;
    let tree = if rel.is_empty() {
        root
    } else {
        let entry = root.get_path(std::path::Path::new(rel))?;
        repo.find_tree(entry.id())?
    };
    let mut out: Vec<git::DirEntry> = tree
        .iter()
        // Submodules (commits) have no content here; skip them like the diff does.
        .filter(|e| e.kind() != Some(git2::ObjectType::Commit))
        .map(|e| git::DirEntry { name: e.name().unwrap_or_default().to_string(), dir: e.kind() == Some(git2::ObjectType::Tree) })
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

/// Drop a final paragraph of git trailers (`Signed-off-by: …`, `Co-Authored-By: …`). Real
/// trailer keys are hyphenated, which keeps a line like "Note: …" in the message.
fn strip_trailers(body: &str) -> String {
    let body = body.trim();
    let (rest, last) = body.rsplit_once("\n\n").unwrap_or(("", body));
    let is_trailer = |l: &str| {
        l.split_once(": ").is_some_and(|(k, _)| k.contains('-') && k.chars().all(|c| c.is_alphanumeric() || c == '-'))
    };
    if last.lines().all(is_trailer) { rest.trim().to_string() } else { body.to_string() }
}

fn blob_bytes(repo: &Repository, id: Oid) -> Result<Vec<u8>, git2::Error> {
    if id.is_zero() {
        return Ok(Vec::new());
    }
    Ok(repo.find_blob(id)?.content().to_vec())
}

#[cfg(test)]
mod tests;
