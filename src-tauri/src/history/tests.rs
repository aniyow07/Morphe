use super::*;
use git2::{IndexAddOption, Signature, Time};
use std::fs;
use tempfile::TempDir;

struct Repo {
    dir: TempDir,
    repo: Repository,
    clock: std::cell::Cell<i64>,
}

impl Repo {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        repo.config().unwrap().set_bool("core.autocrlf", false).unwrap();
        Repo { dir, repo, clock: std::cell::Cell::new(1_700_000_000) }
    }

    fn write(&self, path: &str, content: &str) {
        let p = self.dir.path().join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, content).unwrap();
    }

    /// Commit everything in the working tree with a strictly increasing timestamp.
    fn commit(&self, msg: &str) -> Oid {
        let mut index = self.repo.index().unwrap();
        index.add_all(["*"], IndexAddOption::DEFAULT, None).unwrap();
        index.update_all(["*"], None).unwrap();
        index.write().unwrap();
        let tree = self.repo.find_tree(index.write_tree().unwrap()).unwrap();
        self.clock.set(self.clock.get() + 60);
        let sig = Signature::new("Ada", "ada@example.com", &Time::new(self.clock.get(), 0)).unwrap();
        let parent = self.repo.head().ok().and_then(|h| h.peel_to_commit().ok());
        let parents: Vec<&Commit> = parent.iter().collect();
        self.repo.commit(Some("HEAD"), &sig, &sig, msg, &tree, &parents).unwrap()
    }
}

#[test]
fn pages_continue_newest_first_without_repeats() {
    let r = Repo::new();
    for i in 0..25 {
        r.write("a.txt", &format!("{i}\n"));
        r.commit(&format!("commit {i}"));
    }
    let tip = tip(&r.repo, None).unwrap().unwrap();
    let mut walk = Walk::new(&r.repo, tip);
    let mut all = Vec::new();
    for _ in 0..3 {
        all.extend(walk.next_page(&r.repo, 10).unwrap());
    }
    assert_eq!(all.len(), 25);
    assert_eq!(all[0].summary, "commit 24");
    assert_eq!(all[24].summary, "commit 0");
    assert_eq!(all[24].parents, 0);
    assert_eq!(all.iter().map(|c| &c.id).collect::<HashSet<_>>().len(), 25);
    assert!(walk.next_page(&r.repo, 10).unwrap().is_empty());
}

#[test]
fn merge_history_lists_each_commit_once() {
    let r = Repo::new();
    r.write("a.txt", "base\n");
    let base = r.commit("base");
    r.write("a.txt", "main\n");
    let main = r.commit("on main");
    // A side branch from base, then a merge commit with both parents.
    let base_commit = r.repo.find_commit(base).unwrap();
    r.repo.branch("side", &base_commit, false).unwrap();
    r.repo.set_head("refs/heads/side").unwrap();
    r.repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
    r.write("b.txt", "side\n");
    let side = r.commit("on side");
    let sig = Signature::new("Ada", "ada@example.com", &Time::new(1_800_000_000, 0)).unwrap();
    let tree = r.repo.find_commit(side).unwrap().tree().unwrap();
    let parents = [&r.repo.find_commit(main).unwrap(), &r.repo.find_commit(side).unwrap()];
    let merge = r.repo.commit(None, &sig, &sig, "merge", &tree, &parents).unwrap();
    r.repo.reference("refs/heads/main-merged", merge, true, "test").unwrap();

    let tip = tip(&r.repo, Some("main-merged")).unwrap().unwrap();
    let log = Walk::new(&r.repo, tip).next_page(&r.repo, 100).unwrap();
    let names: Vec<&str> = log.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(names, ["merge", "on side", "on main", "base"]);
    assert_eq!(log[0].parents, 2);
}

#[test]
fn branches_put_the_current_one_first() {
    let r = Repo::new();
    r.write("a.txt", "a\n");
    let id = r.commit("one");
    let c = r.repo.find_commit(id).unwrap();
    r.repo.branch("zeta", &c, false).unwrap();
    r.repo.branch("alpha", &c, false).unwrap();
    r.repo.set_head("refs/heads/zeta").unwrap();
    let names: Vec<(String, bool)> = branches(&r.repo).unwrap().into_iter().map(|b| (b.name, b.current)).collect();
    assert_eq!(names[0], ("zeta".to_string(), true));
    assert!(names.contains(&("alpha".to_string(), false)));

    r.repo.set_head_detached(id).unwrap();
    let b = branches(&r.repo).unwrap();
    assert_eq!((b[0].name.as_str(), b[0].current), ("HEAD", true));
    assert!(b.iter().filter(|b| b.current).count() == 1);
}

#[test]
fn root_commit_shows_everything_added() {
    let r = Repo::new();
    r.write("a.txt", "one\ntwo\n");
    r.write("docs/b.md", "# b\n");
    let id = r.commit("root");
    let c = CommitData::load(&r.repo, id).unwrap();
    let files: Vec<(&str, &str, u32)> = c.changes.files.iter().map(|f| (f.path.as_str(), f.status, f.additions)).collect();
    assert_eq!(files, [("a.txt", "A", 2), ("docs/b.md", "A", 1)]);
    assert_eq!(c.changes.commit.summary, "root");
}

#[test]
fn commit_diff_is_against_first_parent_with_renames() {
    let r = Repo::new();
    let body: String = (0..30).map(|i| format!("line {i}\n")).collect();
    r.write("old name.txt", &body);
    r.write("m.txt", "a\nb\nc\n");
    r.write("gone.txt", "bye\n");
    r.commit("first");
    fs::rename(r.dir.path().join("old name.txt"), r.dir.path().join("new name.txt")).unwrap();
    r.write("m.txt", "a\nB\nc\n");
    fs::remove_file(r.dir.path().join("gone.txt")).unwrap();
    let id = r.commit("second\n\nWith a body.\n");

    let mut c = CommitData::load(&r.repo, id).unwrap();
    assert_eq!(c.changes.body, "With a body.");
    let by_path = |p: &str| c.changes.files.iter().find(|f| f.path == p).cloned().unwrap();
    let renamed = by_path("new name.txt");
    assert_eq!((renamed.status, renamed.old_path.as_deref()), ("R", Some("old name.txt")));
    let m = by_path("m.txt");
    assert_eq!((m.status, m.additions, m.deletions), ("M", 1, 1));
    assert_eq!(by_path("gone.txt").status, "D");

    let d = c.diff(&r.repo, "m.txt").unwrap().unwrap();
    assert_eq!(d.new_total, 3);
    let lines: Vec<(char, &str)> = d.hunks[0].lines.iter().map(|l| (l.k, l.t.as_str())).collect();
    assert_eq!(lines, [(' ', "a"), ('-', "b"), ('+', "B"), (' ', "c")]);
    // Cached: the same Arc comes back.
    assert!(Arc::ptr_eq(&d, &c.diff(&r.repo, "m.txt").unwrap().unwrap()));

    assert_eq!(c.lines(&r.repo, "m.txt", 2, 3).unwrap(), ["B", "c"]);
    assert_eq!(c.text(&r.repo, "gone.txt").unwrap().as_deref(), Some("bye\n"));
    assert!(c.diff(&r.repo, "not-in-commit.txt").unwrap().is_none());
}

#[test]
fn session_pages_resume_and_restart_consistently() {
    let r = Repo::new();
    for i in 0..12 {
        r.write("a.txt", &format!("{i}\n"));
        r.commit(&format!("c{i}"));
    }
    let mut s = crate::session::Session::open(r.dir.path()).unwrap();
    let first = s.commits(None, 0, 5).unwrap();
    let second = s.commits(None, 5, 5).unwrap(); // resumes
    let again = s.commits(None, 5, 5).unwrap(); // restarts and skips
    assert_eq!(first[0].summary, "c11");
    assert_eq!(second[0].summary, "c6");
    assert_eq!(second.iter().map(|c| &c.id).collect::<Vec<_>>(), again.iter().map(|c| &c.id).collect::<Vec<_>>());
    assert_eq!(s.commits(None, 10, 5).unwrap().len(), 2);
}

#[test]
fn trailers_are_dropped_from_the_body() {
    assert_eq!(strip_trailers("Why it changed.\n\nCo-Authored-By: A <a@b>\nSigned-off-by: B <b@c>\n"), "Why it changed.");
    assert_eq!(strip_trailers("Co-Authored-By: A <a@b>"), "");
    assert_eq!(strip_trailers("Note: this is prose, not a trailer list"), "Note: this is prose, not a trailer list");
    assert_eq!(strip_trailers("Plain body."), "Plain body.");
}
