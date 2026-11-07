//! Dev tool: dump a repo's scan as JSON for the browser mock (`npm run dev`, then open
//! http://localhost:1420/?mock). Usage: cargo run --example dump -- <repo> > ../.mock/fixture.json
use morphe_lib::{git, history};
use std::collections::HashMap;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <repo>");
    let repo = git2::Repository::discover(&path).expect("not a git repository");
    let scanned = git::scan(&repo, None, &HashMap::new(), &git::ScanOpts::default()).expect("scan failed");
    let mut files = Vec::new();
    let mut diffs = serde_json::Map::new();
    let mut texts = serde_json::Map::new();
    for s in scanned {
        if let Ok(Some(t)) = git::file_text(&repo, &s.entry.path) {
            texts.insert(s.entry.path.clone(), t.into());
        }
        diffs.insert(s.entry.path.clone(), serde_json::to_value(&*s.diff).unwrap());
        files.push(s.entry);
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let root = repo.workdir().unwrap().to_string_lossy().trim_end_matches(['/', '\\']).to_string();
    let name = root.rsplit(['/', '\\']).next().unwrap_or("repo").to_string();
    // History: branches, the first commits, and full data for the newest few.
    let branches = history::branches(&repo).unwrap_or_default();
    let commits = match history::tip(&repo, None) {
        Ok(Some(tip)) => history::Walk::new(&repo, tip).next_page(&repo, 300).unwrap_or_default(),
        _ => vec![],
    };
    let mut opened = serde_json::Map::new();
    for c in commits.iter().take(12) {
        let mut data = history::CommitData::load(&repo, git2::Oid::from_str(&c.id).unwrap()).unwrap();
        let mut cdiffs = serde_json::Map::new();
        let mut ctexts = serde_json::Map::new();
        for f in data.changes.files.clone() {
            if let Ok(Some(d)) = data.diff(&repo, &f.path) {
                cdiffs.insert(f.path.clone(), serde_json::to_value(&*d).unwrap());
            }
            if let Ok(Some(t)) = data.text(&repo, &f.path) {
                ctexts.insert(f.path.clone(), t.into());
            }
        }
        opened.insert(c.id.clone(), serde_json::json!({ "changes": data.changes, "diffs": cdiffs, "texts": ctexts }));
    }
    // Every folder listing (and unchanged file texts) for the "All files" tree.
    let mut dirs = serde_json::Map::new();
    let mut stack = vec![String::new()];
    while let Some(d) = stack.pop() {
        let entries = git::list_dir(&repo, &d).unwrap_or_default();
        for e in &entries {
            let p = if d.is_empty() { e.name.clone() } else { format!("{d}/{}", e.name) };
            if e.dir {
                stack.push(p);
            } else if !texts.contains_key(&p) {
                if let Ok(Some(t)) = git::file_text(&repo, &p) {
                    texts.insert(p, t.into());
                }
            }
        }
        dirs.insert(d, serde_json::to_value(entries).unwrap());
    }
    let out = serde_json::json!({
        "dirs": dirs,
        "snapshot": { "root": root, "name": name, "branch": git::branch_name(&repo), "files": files, "viewed": {} },
        "diffs": diffs,
        "texts": texts,
        "branches": branches,
        "commits": commits,
        "opened": opened,
    });
    println!("{}", serde_json::to_string(&out).unwrap());
}
