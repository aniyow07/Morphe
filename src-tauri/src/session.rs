//! An open repository: the cached scan results and incremental refresh.

use crate::git::{self, FileDiff, FileEntry, Scanned};
use git2::{ErrorCode, Repository};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub root: String,
    pub name: String,
    pub branch: String,
    pub files: Vec<FileEntry>,
    pub viewed: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Upsert {
    #[serde(flatten)]
    pub entry: FileEntry,
    /// False when only metadata (e.g. the staged badge) changed.
    pub content_changed: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub upserts: Vec<Upsert>,
    pub removed: Vec<String>,
    pub branch: String,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        self.upserts.is_empty() && self.removed.is_empty()
    }
}

pub struct Session {
    pub root: PathBuf,
    pub git_dir: PathBuf,
    pub name: String,
    pub branch: String,
    files: HashMap<String, Scanned>,
}

impl Session {
    /// Open the repository containing `path` and do the initial scan.
    pub fn open(path: &Path) -> Result<Session, String> {
        let repo = Repository::discover(path).map_err(|e| match e.code() {
            ErrorCode::NotFound => format!("{} is not inside a git repository", path.display()),
            _ => e.message().to_string(),
        })?;
        let root = repo
            .workdir()
            .ok_or("Bare repositories have no working tree to show")?
            .to_path_buf();
        let root = dunce(root);
        let git_dir = dunce(repo.path().to_path_buf());
        let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let mut s = Session { root, git_dir, name, branch: String::new(), files: HashMap::new() };
        s.full_rescan().map_err(|e| e.message().to_string())?;
        Ok(s)
    }

    pub fn snapshot(&self, viewed: HashMap<String, String>) -> Snapshot {
        let mut files: Vec<FileEntry> = self.files.values().map(|s| s.entry.clone()).collect();
        files.sort_by(|a, b| a.path.cmp(&b.path));
        Snapshot {
            root: self.root.to_string_lossy().into_owned(),
            name: self.name.clone(),
            branch: self.branch.clone(),
            files,
            viewed,
        }
    }

    pub fn diff(&self, path: &str) -> Option<Arc<FileDiff>> {
        self.files.get(path).map(|s| s.diff.clone())
    }

    pub fn repo(&self) -> Result<Repository, git2::Error> {
        // A fresh handle per scan: libgit2 then always sees the current index, config and
        // ignore files, and opening is cheap compared to the scan itself.
        Repository::open(&self.root)
    }

    /// Rescan everything. Diffs are only rebuilt for files whose fingerprint changed.
    pub fn full_rescan(&mut self) -> Result<Change, git2::Error> {
        let (results, branch) = with_retry(|| {
            let repo = self.repo()?;
            Ok((git::scan(&repo, None, &self.files)?, git::branch_name(&repo)))
        })?;
        self.branch = branch;
        Ok(self.apply(results, |_| true))
    }

    /// Rescan only the given working-tree paths (files or directories).
    pub fn rescan_paths(&mut self, paths: Vec<String>) -> Result<Change, git2::Error> {
        let mut set: HashSet<String> = paths.into_iter().collect();
        // Keep rename pairs together, so a rename doesn't split into add + delete.
        for s in self.files.values() {
            if let Some(old) = &s.entry.old_path {
                if set.contains(old) || set.contains(&s.entry.path) {
                    set.insert(old.clone());
                    set.insert(s.entry.path.clone());
                }
            }
        }
        let paths: Vec<String> = set.into_iter().collect();
        let results = with_retry(|| git::scan(&self.repo()?, Some(&paths), &self.files))?;
        let in_scope = |p: &str| {
            paths.iter().any(|s| p == s || (p.starts_with(s.as_str()) && p.as_bytes().get(s.len()) == Some(&b'/')))
        };
        Ok(self.apply(results, in_scope))
    }

    fn apply(&mut self, results: Vec<Scanned>, in_scope: impl Fn(&str) -> bool) -> Change {
        let mut change = Change { branch: self.branch.clone(), ..Default::default() };
        let fresh: HashSet<&str> = results.iter().map(|s| s.entry.path.as_str()).collect();
        change.removed = self
            .files
            .keys()
            .filter(|p| in_scope(p) && !fresh.contains(p.as_str()))
            .cloned()
            .collect();
        for p in &change.removed {
            self.files.remove(p);
        }
        for s in results {
            let prev = self.files.get(&s.entry.path);
            if prev.map_or(true, |p| p.entry != s.entry) {
                change.upserts.push(Upsert {
                    entry: s.entry.clone(),
                    content_changed: prev.map_or(true, |p| p.entry.diff_hash != s.entry.diff_hash),
                });
            }
            self.files.insert(s.entry.path.clone(), s);
        }
        change
    }
}

/// Git writes the index via index.lock + rename, so reads can briefly fail mid-write.
/// Retry a few times quietly before surfacing an error.
fn with_retry<T>(mut f: impl FnMut() -> Result<T, git2::Error>) -> Result<T, git2::Error> {
    let mut delay = Duration::from_millis(30);
    for _ in 0..3 {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if e.code() == ErrorCode::NotFound && e.class() == git2::ErrorClass::Repository => return Err(e),
            Err(_) => {
                std::thread::sleep(delay);
                delay *= 2;
            }
        }
    }
    f()
}

/// Strip Windows' `\\?\` verbatim prefix and trailing separators so paths compare cleanly.
fn dunce(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let s = s.trim_end_matches(['/', '\\']);
    PathBuf::from(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn repo_with(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        repo.config().unwrap().set_bool("core.autocrlf", false).unwrap();
        for (p, c) in files {
            fs::write(dir.path().join(p), c).unwrap();
        }
        dir
    }

    #[test]
    fn path_rescan_reports_upserts_and_removals() {
        let dir = repo_with(&[("a.txt", "a\n"), ("b.txt", "b\n")]);
        let mut s = Session::open(dir.path()).unwrap();
        assert_eq!(s.snapshot(Default::default()).files.len(), 2);

        fs::write(dir.path().join("a.txt"), "a\nmore\n").unwrap();
        fs::remove_file(dir.path().join("b.txt")).unwrap();
        let c = s.rescan_paths(vec!["a.txt".into(), "b.txt".into()]).unwrap();
        assert_eq!(c.upserts.len(), 1);
        assert!(c.upserts[0].content_changed);
        assert_eq!(c.removed, vec!["b.txt".to_string()]);

        // Nothing changed: an empty change set.
        assert!(s.rescan_paths(vec!["a.txt".into()]).unwrap().is_empty());
    }

    #[test]
    fn staging_only_changes_metadata() {
        let dir = repo_with(&[("a.txt", "a\n")]);
        let mut s = Session::open(dir.path()).unwrap();
        let repo = Repository::open(dir.path()).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("a.txt")).unwrap();
        index.write().unwrap();
        let c = s.full_rescan().unwrap();
        assert_eq!(c.upserts.len(), 1);
        assert_eq!(c.upserts[0].entry.status, "A");
        // Status changed U -> A, so the diff hash (which includes status) changes too;
        // a second rescan with nothing new reports nothing.
        assert!(s.full_rescan().unwrap().is_empty());
    }
}
