//! Dev tool: dump a repo's scan as JSON for the browser mock (`npm run dev`, then open
//! http://localhost:1420/?mock). Usage: cargo run --example dump -- <repo> > ../.mock/fixture.json
use morphe_lib::git;
use std::collections::HashMap;

fn main() {
    let path = std::env::args().nth(1).expect("usage: dump <repo>");
    let repo = git2::Repository::discover(&path).expect("not a git repository");
    let scanned = git::scan(&repo, None, &HashMap::new()).expect("scan failed");
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
    let out = serde_json::json!({
        "snapshot": { "root": root, "name": name, "branch": git::branch_name(&repo), "files": files, "viewed": {} },
        "diffs": diffs,
        "texts": texts,
    });
    println!("{}", serde_json::to_string(&out).unwrap());
}
