//! Small JSON files in the app-data dir: recent repos and per-repo viewed marks.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_RECENTS: usize = 12;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    pub path: String,
    pub name: String,
    pub opened_at: u64,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(dir.join("viewed"));
        Store { dir }
    }

    pub fn recents(&self) -> Vec<Recent> {
        read_json(&self.dir.join("recents.json")).unwrap_or_default()
    }

    pub fn touch_recent(&self, path: &str, name: &str) {
        let mut list = self.recents();
        list.retain(|r| r.path != path);
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
        list.insert(0, Recent { path: path.into(), name: name.into(), opened_at: now });
        list.truncate(MAX_RECENTS);
        write_json(&self.dir.join("recents.json"), &list);
    }

    pub fn forget_recent(&self, path: &str) {
        let mut list = self.recents();
        list.retain(|r| r.path != path);
        write_json(&self.dir.join("recents.json"), &list);
    }

    /// path -> diff hash that was marked viewed
    pub fn viewed(&self, root: &str) -> HashMap<String, String> {
        read_json(&self.viewed_file(root)).unwrap_or_default()
    }

    pub fn set_viewed(&self, root: &str, path: &str, hash: Option<&str>) {
        let mut map = self.viewed(root);
        match hash {
            Some(h) => map.insert(path.into(), h.into()),
            None => map.remove(path),
        };
        write_json(&self.viewed_file(root), &map);
    }

    /// Set or clear many marks with a single write.
    pub fn set_viewed_many(&self, root: &str, marks: HashMap<String, Option<String>>) {
        let mut map = self.viewed(root);
        for (path, hash) in marks {
            match hash {
                Some(h) => map.insert(path, h),
                None => map.remove(&path),
            };
        }
        write_json(&self.viewed_file(root), &map);
    }

    /// Drop marks for files that no longer differ from HEAD.
    pub fn prune_viewed(&self, root: &str, live: &[&str]) -> HashMap<String, String> {
        let mut map = self.viewed(root);
        let before = map.len();
        map.retain(|p, _| live.contains(&p.as_str()));
        if map.len() != before {
            write_json(&self.viewed_file(root), &map);
        }
        map
    }

    fn viewed_file(&self, root: &str) -> PathBuf {
        let norm = if cfg!(windows) { root.to_lowercase() } else { root.to_string() };
        let key = crate::git::fnv(&[norm.as_bytes()]);
        self.dir.join("viewed").join(format!("{key:016x}.json"))
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(p: &PathBuf) -> Option<T> {
    serde_json::from_slice(&fs::read(p).ok()?).ok()
}

fn write_json<T: Serialize>(p: &PathBuf, v: &T) {
    // Write-then-rename so a crash never leaves a half-written file.
    let tmp = p.with_extension("tmp");
    if let Ok(bytes) = serde_json::to_vec(v) {
        if fs::write(&tmp, bytes).is_ok() {
            let _ = fs::rename(&tmp, p);
        }
    }
}
