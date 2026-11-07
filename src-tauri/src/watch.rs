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
