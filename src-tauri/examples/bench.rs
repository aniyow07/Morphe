//! Dev tool: time scans on a repository. Usage: cargo run --release --example bench -- <repo>
use morphe_lib::session::Session;
use std::time::Instant;

fn main() {
    let path = std::env::args().nth(1).expect("usage: bench <repo>");
    let t = Instant::now();
    let mut s = Session::open(std::path::Path::new(&path)).expect("open failed");
    let files = s.snapshot(Default::default()).files;
    println!("open + first scan: {:?} ({} changed files)", t.elapsed(), files.len());

    let t = Instant::now();
    s.full_rescan().unwrap();
    println!("full rescan, nothing changed: {:?}", t.elapsed());

    let t = Instant::now();
    let changed = s.git_state_changed();
    println!("index rewritten, entries unchanged (skips the rescan: {}): {:?}", !changed, t.elapsed());

    let one = files.first().map(|f| f.path.clone()).unwrap_or_default();
    let t = Instant::now();
    s.rescan_paths(vec![one.clone()]).unwrap();
    println!("rescan of one path ({one}): {:?}", t.elapsed());
}
