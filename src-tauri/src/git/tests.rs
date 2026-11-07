use super::*;
use git2::{IndexAddOption, Signature};
use std::fs;
use tempfile::TempDir;

struct Fixture {
    dir: TempDir,
    repo: Repository,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        // Keep tests independent of the machine's global git config.
        let mut cfg = repo.config().unwrap();
        cfg.set_bool("core.autocrlf", false).unwrap();
        Fixture { dir, repo }
    }

    fn write(&self, path: &str, content: impl AsRef<[u8]>) {
        let p = self.dir.path().join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    fn remove(&self, path: &str) {
        fs::remove_file(self.dir.path().join(path)).unwrap();
    }

    fn stage(&self, path: &str) {
        let mut index = self.repo.index().unwrap();
        if self.dir.path().join(path).exists() {
            index.add_path(Path::new(path)).unwrap();
        } else {
            index.remove_path(Path::new(path)).unwrap();
        }
        index.write().unwrap();
    }

    fn commit_all(&self) {
        let mut index = self.repo.index().unwrap();
        index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
        index.write().unwrap();
        let tree = self.repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = Signature::now("Test", "test@example.com").unwrap();
        let parent = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&git2::Commit> = parent.iter().collect();
        self.repo.commit(Some("HEAD"), &sig, &sig, "commit", &tree, &parents).unwrap();
    }

    fn scan(&self) -> Vec<Scanned> {
        scan(&self.repo, None, &HashMap::new()).unwrap()
    }

    fn entry(&self, path: &str) -> FileEntry {
        self.scan()
            .into_iter()
            .find(|s| s.entry.path == path)
            .unwrap_or_else(|| panic!("{path} not in scan"))
            .entry
    }
}

#[test]
fn clean_tree_has_no_entries() {
    let f = Fixture::new();
    f.write("a.txt", "one\n");
    f.commit_all();
    assert!(f.scan().is_empty());
}

#[test]
fn new_untracked_file() {
    let f = Fixture::new();
    f.write("a.txt", "one\n");
    f.commit_all();
    f.write("new.txt", "x\ny\n");
    let e = f.entry("new.txt");
    assert_eq!((e.status, e.additions, e.deletions, e.staged), ("U", 2, 0, Staged::None));
}

#[test]
fn deleted_file() {
    let f = Fixture::new();
    f.write("a.txt", "one\ntwo\n");
    f.commit_all();
    f.remove("a.txt");
    let e = f.entry("a.txt");
    assert_eq!((e.status, e.additions, e.deletions), ("D", 0, 2));
}

#[test]
fn partial_and_full_staging() {
    let f = Fixture::new();
    f.write("a.txt", "one\ntwo\nthree\n");
    f.write("b.txt", "b\n");
    f.commit_all();

    f.write("a.txt", "ONE\ntwo\nthree\n");
    f.stage("a.txt");
    f.write("a.txt", "ONE\ntwo\nTHREE\n");
    f.write("b.txt", "B\n");
    f.stage("b.txt");

    let a = f.entry("a.txt");
    assert_eq!((a.status, a.staged, a.additions, a.deletions), ("M", Staged::Partial, 2, 2));
    assert_eq!(f.entry("b.txt").staged, Staged::Full);
}

#[test]
fn binary_file_has_no_hunks() {
    let f = Fixture::new();
    f.write("img.bin", [0u8, 1, 2, 3, 0, 255]);
    let s = f.scan();
    assert_eq!(s[0].entry.kind, Kind::Binary);
    assert!(s[0].diff.hunks.is_empty());
}

#[test]
fn repo_without_commits_diffs_against_empty_tree() {
    let f = Fixture::new();
    f.write("staged.txt", "a\n");
    f.stage("staged.txt");
    f.write("loose.txt", "b\nc\n");
    let branch = branch_name(&f.repo);
    assert!(branch != "HEAD" && !branch.is_empty(), "unborn branch name: {branch}");
    let staged = f.entry("staged.txt");
    assert_eq!((staged.status, staged.staged, staged.additions), ("A", Staged::Full, 1));
    let loose = f.entry("loose.txt");
    assert_eq!((loose.status, loose.additions), ("U", 2));
}

#[test]
fn staged_rename_is_detected() {
    let f = Fixture::new();
    let body = (0..40).map(|i| format!("line {i}\n")).collect::<String>();
    f.write("old name.txt", &body);
    f.commit_all();
    fs::rename(f.dir.path().join("old name.txt"), f.dir.path().join("new name.txt")).unwrap();
    f.stage("old name.txt");
    f.stage("new name.txt");
    let e = f.entry("new name.txt");
    assert_eq!(e.status, "R");
    assert_eq!(e.old_path.as_deref(), Some("old name.txt"));
}

#[test]
fn too_large_file_is_flagged() {
    let f = Fixture::new();
    f.write("big.txt", "x\n".repeat((MAX_FILE_BYTES as usize / 2) + 10));
    let e = f.entry("big.txt");
    assert_eq!(e.kind, Kind::TooLarge);
}

#[test]
fn non_utf8_and_unicode_paths_do_not_break() {
    let f = Fixture::new();
    f.write("dir with space/naïve ✓.txt", b"caf\xe9\nok\n");
    let s = f.scan();
    assert_eq!(s[0].entry.path, "dir with space/naïve ✓.txt");
    assert_eq!(s[0].diff.hunks[0].lines[0].t, "caf\u{fffd}");
}

#[test]
fn hunks_carry_line_numbers_and_word_emphasis() {
    let f = Fixture::new();
    f.write("a.rs", "fn main() {\n    let x = 1;\n}\n");
    f.commit_all();
    f.write("a.rs", "fn main() {\n    let x = 2;\n}\n");
    let s = f.scan();
    let lines = &s[0].diff.hunks[0].lines;
    let del = lines.iter().find(|l| l.k == '-').unwrap();
    let add = lines.iter().find(|l| l.k == '+').unwrap();
    assert_eq!((del.o, del.n, add.o, add.n), (Some(2), None, None, Some(2)));
    assert_eq!(del.e, vec![(12, 13)]);
    assert_eq!(add.e, vec![(12, 13)]);
    assert_eq!(s[0].diff.new_total, 3);
}

#[test]
fn path_limited_scan_only_returns_requested_paths() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    f.write("b.txt", "b\n");
    f.write("sub/c.txt", "c\n");
    let only = scan(&f.repo, Some(&["a.txt".to_string(), "sub".to_string()]), &HashMap::new()).unwrap();
    let mut paths: Vec<_> = only.iter().map(|s| s.entry.path.as_str()).collect();
    paths.sort();
    assert_eq!(paths, ["a.txt", "sub/c.txt"]);
}

#[test]
fn unchanged_files_reuse_previous_diff() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    let first = f.scan();
    let prev: HashMap<_, _> = first.into_iter().map(|s| (s.entry.path.clone(), s)).collect();
    let second = scan(&f.repo, None, &prev).unwrap();
    assert!(Arc::ptr_eq(&second[0].diff, &prev["a.txt"].diff));
}

#[test]
fn diff_hash_changes_with_content() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    let h1 = f.entry("a.txt").diff_hash;
    f.write("a.txt", "a\nb\n");
    let h2 = f.entry("a.txt").diff_hash;
    assert_ne!(h1, h2);
}

#[test]
fn word_ranges_skip_rewritten_lines() {
    assert!(word_ranges("completely different", "nothing alike here at all").is_none());
    let (a, b) = word_ranges("let total = a + b;", "let total = a - b;").unwrap();
    assert_eq!((a, b), (vec![(14, 15)], vec![(14, 15)]));
}

#[test]
fn read_lines_returns_requested_range() {
    let f = Fixture::new();
    f.write("a.txt", "1\r\n2\r\n3\r\n4\r\n");
    assert_eq!(read_lines(f.dir.path(), "a.txt", 2, 3).unwrap(), ["2", "3"]);
}

#[test]
fn long_diffs_are_truncated() {
    let f = Fixture::new();
    f.write("long.txt", "line\n".repeat(MAX_DIFF_LINES + 500));
    let s = f.scan();
    let d = &s[0].diff;
    assert!(d.truncated);
    assert_eq!(d.hunks.iter().map(|h| h.lines.len()).sum::<usize>(), MAX_DIFF_LINES);
    assert_eq!(s[0].entry.additions as usize, MAX_DIFF_LINES + 500, "counts stay exact");
}

#[test]
fn submodules_are_skipped() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    f.commit_all();
    // A gitlink entry, as `git submodule add` would create, pointing at an arbitrary commit.
    let head = f.repo.head().unwrap().target().unwrap();
    let mut index = f.repo.index().unwrap();
    let entry = git2::IndexEntry {
        ctime: git2::IndexTime::new(0, 0),
        mtime: git2::IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode: 0o160000,
        uid: 0,
        gid: 0,
        file_size: 0,
        id: head,
        flags: 0,
        flags_extended: 0,
        path: b"vendor/lib".to_vec(),
    };
    index.add(&entry).unwrap();
    index.write().unwrap();
    fs::create_dir_all(f.dir.path().join("vendor/lib")).unwrap();
    f.write("vendor/lib/inner.txt", "inside the submodule\n");
    let paths: Vec<_> = f.scan().into_iter().map(|s| (s.entry.path, s.entry.status)).collect();
    assert!(paths.iter().all(|(p, _)| !p.starts_with("vendor/lib")), "{paths:?}");
}

#[test]
fn scan_works_while_index_is_locked() {
    let f = Fixture::new();
    f.write("a.txt", "a\n");
    f.commit_all();
    f.write("a.txt", "b\n");
    fs::write(f.repo.path().join("index.lock"), b"partial write").unwrap();
    assert_eq!(f.entry("a.txt").status, "M");
}

#[test]
fn deleted_and_untracked_pair_shows_as_rename() {
    let f = Fixture::new();
    let body = (0..30).map(|i| format!("row {i}\n")).collect::<String>();
    f.write("before.txt", &body);
    f.commit_all();
    fs::rename(f.dir.path().join("before.txt"), f.dir.path().join("after.txt")).unwrap();
    let s = f.scan();
    assert_eq!(s.len(), 1);
    assert_eq!((s[0].entry.status, s[0].entry.old_path.as_deref()), ("R", Some("before.txt")));
}
