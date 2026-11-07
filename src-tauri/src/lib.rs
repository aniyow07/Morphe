pub mod git;
pub mod session;
pub mod store;
pub mod watch;

use session::{Session, Snapshot};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use store::{Recent, Store};
use tauri::{AppHandle, Emitter, Manager, State};

struct AppState {
    session: Arc<Mutex<Option<Session>>>,
    watcher: Mutex<Option<watch::Watcher>>,
    store: Store,
    launch_path: Option<String>,
}

type CmdResult<T> = Result<T, String>;

#[tauri::command]
fn open_repo(app: AppHandle, state: State<AppState>, path: String) -> CmdResult<Snapshot> {
    // Drop the old watcher first so its thread can't emit for the previous repo.
    state.watcher.lock().unwrap().take();
    let session = Session::open(&PathBuf::from(&path))?;
    let root = session.root.to_string_lossy().into_owned();
    state.store.touch_recent(&root, &session.name);
    let mut snapshot = session.snapshot(Default::default());
    let live: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
    snapshot.viewed = state.store.prune_viewed(&root, &live);
    let (watch_root, git_dir) = (session.root.clone(), session.git_dir.clone());
    *state.session.lock().unwrap() = Some(session);

    let shared = state.session.clone();
    let watcher = watch::start(watch_root, git_dir, move |batch| on_batch(&app, &shared, batch))
        .map_err(|e| format!("Could not watch the repository: {e}"))?;
    *state.watcher.lock().unwrap() = Some(watcher);
    Ok(snapshot)
}

fn on_batch(app: &AppHandle, shared: &Mutex<Option<Session>>, batch: watch::Batch) {
    let mut guard = shared.lock().unwrap();
    let Some(session) = guard.as_mut() else { return };
    if batch.gone {
        let _ = app.emit("repo:gone", session.root.to_string_lossy());
        return;
    }
    let result = if batch.full { session.full_rescan() } else { session.rescan_paths(batch.paths) };
    match result {
        Ok(change) if !change.is_empty() => {
            let _ = app.emit("repo:changed", change);
        }
        Ok(change) => {
            // Branch switch with an identical tree still updates the chip.
            let _ = app.emit("repo:branch", change.branch);
        }
        Err(_) if !session.root.exists() => {
            let _ = app.emit("repo:gone", session.root.to_string_lossy());
        }
        Err(_) => {} // transient (lock races already retried); the next event will catch up
    }
}

#[tauri::command]
fn get_diff(state: State<AppState>, path: String) -> CmdResult<Option<git::FileDiff>> {
    let guard = state.session.lock().unwrap();
    Ok(guard.as_ref().and_then(|s| s.diff(&path)).map(|d| (*d).clone()))
}

#[tauri::command]
fn get_lines(state: State<AppState>, path: String, start: u32, end: u32) -> CmdResult<Vec<String>> {
    let root = root_of(&state)?;
    git::read_lines(&root, &path, start, end).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_file_text(state: State<AppState>, path: String) -> CmdResult<Option<String>> {
    let guard = state.session.lock().unwrap();
    let session = guard.as_ref().ok_or("No repository open")?;
    let repo = session.repo().map_err(|e| e.message().to_string())?;
    git::file_text(&repo, &path).map_err(|e| e.message().to_string())
}

#[tauri::command]
fn set_viewed(state: State<AppState>, path: String, hash: Option<String>) -> CmdResult<()> {
    let root = root_of(&state)?;
    state.store.set_viewed(&root.to_string_lossy(), &path, hash.as_deref());
    Ok(())
}

#[tauri::command]
fn recent_repos(state: State<AppState>) -> Vec<Recent> {
    state.store.recents()
}

#[tauri::command]
fn forget_recent(state: State<AppState>, path: String) {
    state.store.forget_recent(&path);
}

#[tauri::command]
fn launch_path(state: State<AppState>) -> Option<String> {
    state.launch_path.clone()
}

#[tauri::command]
fn close_repo(state: State<AppState>) {
    state.watcher.lock().unwrap().take();
    state.session.lock().unwrap().take();
}

fn root_of(state: &State<AppState>) -> CmdResult<PathBuf> {
    let guard = state.session.lock().unwrap();
    guard.as_ref().map(|s| s.root.clone()).ok_or_else(|| "No repository open".into())
}

/// `morphe <path>`: the first non-flag argument, resolved against the current directory.
fn cli_path() -> Option<String> {
    let arg = std::env::args().skip(1).find(|a| !a.starts_with('-'))?;
    let p = PathBuf::from(arg);
    let p = if p.is_absolute() { p } else { std::env::current_dir().ok()?.join(p) };
    Some(p.to_string_lossy().into_owned())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            app.manage(AppState {
                session: Arc::new(Mutex::new(None)),
                watcher: Mutex::new(None),
                store: Store::new(dir),
                launch_path: cli_path(),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_repo,
            get_diff,
            get_lines,
            get_file_text,
            set_viewed,
            recent_repos,
            forget_recent,
            launch_path,
            close_repo
        ])
        .run(tauri::generate_context!())
        .expect("error while running Morphe");
}
