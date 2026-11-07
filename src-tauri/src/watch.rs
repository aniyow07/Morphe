//! Filesystem watching: debounced notify events, classified into what needs rescanning.

use git2::Repository;
use notify::event::{AccessKind, AccessMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub type Watcher = Debouncer<RecommendedWatcher, RecommendedCache>;

/// Above this many paths in one batch (checkouts, stashes), a full rescan is cheaper.
const MAX_PATHS_PER_BATCH: usize = 400;

#[derive(Debug, Default)]
pub struct Batch {
    /// Index, HEAD, refs or ignore rules changed: rescan everything.
    pub full: bool,
    /// Working-tree paths (relative, forward slashes) to rescan.
    pub paths: Vec<String>,
    /// The repository disappeared (deleted or moved).
    pub gone: bool,
}

pub fn start(root: PathBuf, git_dir: PathBuf, on_batch: impl Fn(Batch) + Send + 'static) -> notify::Result<Watcher> {
    let (r, g) = (root.clone(), git_dir.clone());
    let mut debouncer = new_debouncer(Duration::from_millis(150), None, move |res: DebounceEventResult| {
        let batch = match res {
            Ok(events) => classify(&r, &g, events.iter().filter(|e| relevant(&e.kind)).flat_map(|e| e.paths.iter())),
            Err(_) => Batch { full: true, ..Default::default() },
        };
        let batch = if !r.exists() || !g.exists() { Batch { gone: true, ..Default::default() } } else { batch };
        if batch.gone || batch.full || !batch.paths.is_empty() {
            on_batch(batch);
        }
    })?;
    debouncer.watch(&root, RecursiveMode::Recursive)?;
    // A recursive watch doesn't report the root itself being moved or deleted; watching the
    // parent (non-recursively) does, so the UI can say the repository is gone.
    if let Some(parent) = root.parent() {
        let _ = debouncer.watch(parent, RecursiveMode::NonRecursive);
    }
    // Linked worktrees and `--separate-git-dir` keep the git dir outside the tree.
    if !git_dir.starts_with(&root) {
        debouncer.watch(&git_dir, RecursiveMode::Recursive)?;
    }
    Ok(debouncer)
}

fn relevant(kind: &EventKind) -> bool {
    match kind {
        EventKind::Access(AccessKind::Close(AccessMode::Write)) => true,
        EventKind::Access(_) => false,
        _ => true,
    }
}

fn classify<'a>(root: &Path, git_dir: &Path, paths: impl Iterator<Item = &'a PathBuf>) -> Batch {
    let mut batch = Batch::default();
    let mut work = BTreeSet::new();
    for p in paths {
        if let Ok(rel) = p.strip_prefix(git_dir) {
            batch.full |= is_git_state(rel);
            continue;
        }
        let Ok(rel) = p.strip_prefix(root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.is_empty() || rel.split('/').any(|c| c == ".git") {
            continue;
        }
        if rel.ends_with(".gitignore") {
            batch.full = true; // ignore rules changed: what counts as "changed" may shift anywhere
        }
        work.insert(rel);
    }
    if batch.full || work.is_empty() {
        return batch;
    }
    if work.len() > MAX_PATHS_PER_BATCH {
        batch.full = true;
        return batch;
    }
    // Drop ignored paths (build output, node_modules, ...) using git's own rules.
    match Repository::open(root) {
        Ok(repo) => {
            batch.paths = work
                .into_iter()
                .filter(|rel| !repo.status_should_ignore(Path::new(rel)).unwrap_or(false))
                .collect();
        }
        Err(_) => batch.gone = !root.exists(),
    }
    batch
}

/// Files under .git whose change means staging, a commit or a branch switch happened.
fn is_git_state(rel: &Path) -> bool {
    let s = rel.to_string_lossy().replace('\\', "/");
    s == "index" || s == "HEAD" || s == "packed-refs" || s.starts_with("refs/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_state_files_trigger_full_rescan() {
        assert!(is_git_state(Path::new("index")));
        assert!(is_git_state(Path::new("refs/heads/main")));
        assert!(!is_git_state(Path::new("index.lock")));
        assert!(!is_git_state(Path::new("objects/ab/cdef")));
    }
}

#[cfg(test)]
mod live_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn edits_arrive_as_path_batches_and_ignored_files_are_dropped() {
        let dir = tempfile::TempDir::new().unwrap();
        Repository::init(dir.path()).unwrap();
        std::fs::write(dir.path().join(".gitignore"), "build/\n").unwrap();
        std::fs::create_dir(dir.path().join("build")).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let root = PathBuf::from(root.to_string_lossy().trim_start_matches(r"\\?\"));
        let (tx, rx) = mpsc::channel();
        let _w = start(root.clone(), root.join(".git"), move |b| tx.send(b).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(300));

        std::fs::write(root.join("build/out.o"), "ignored").unwrap();
        std::fs::write(root.join("src.txt"), "hello").unwrap();
        let mut paths = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline && !paths.contains(&"src.txt".to_string()) {
            if let Ok(b) = rx.recv_timeout(Duration::from_millis(500)) {
                assert!(!b.gone);
                paths.extend(b.paths);
            }
        }
        assert!(paths.contains(&"src.txt".to_string()), "got {paths:?}");
        assert!(!paths.iter().any(|p| p.starts_with("build")), "ignored path leaked: {paths:?}");
    }
}

#[cfg(test)]
mod gone_tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn moving_the_repo_away_reports_gone() {
        let parent = tempfile::TempDir::new().unwrap();
        let root = parent.path().join("repo");
        std::fs::create_dir(&root).unwrap();
        Repository::init(&root).unwrap();
        let (tx, rx) = mpsc::channel();
        let w = start(root.clone(), root.join(".git"), move |b| {
            let _ = tx.send(b);
        })
        .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        // Windows refuses to rename a directory with an open watch handle; deleting its
        // contents still has to be noticed. Try the move first, fall back to deletion.
        if std::fs::rename(&root, parent.path().join("moved")).is_err() {
            std::fs::remove_dir_all(root.join(".git")).unwrap();
        }
        let gone = rx.recv_timeout(Duration::from_secs(5)).map(|b| b.gone).unwrap_or(false)
            || rx.recv_timeout(Duration::from_secs(2)).map(|b| b.gone).unwrap_or(false);
        drop(w);
        assert!(gone);
    }
}
