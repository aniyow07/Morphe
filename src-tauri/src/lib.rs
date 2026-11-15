pub mod git;
pub mod history;
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
    let refs_moved = batch.git && session.refs_changed();
    let result = if batch.full || (batch.git && session.git_state_changed()) || (refs_moved && session.has_base()) {
        session.full_rescan()
    } else if !batch.paths.is_empty() {
        session.rescan_paths(batch.paths)
    } else {
        Ok(session.unchanged())
    };
    if refs_moved {
        let _ = app.emit("repo:refs", ());
    }
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
fn list_dir(state: State<AppState>, path: String) -> CmdResult<Vec<git::DirEntry>> {
    with_session(&state, |s| git::list_dir(&s.repo()?, &path))
}

#[tauri::command]
fn list_branches(state: State<AppState>) -> CmdResult<Vec<history::Branch>> {
    with_session(&state, |s| history::branches(&s.repo()?))
}

#[tauri::command]
fn list_commits(
    state: State<AppState>,
    branch: Option<String>,
    skip: usize,
    limit: usize,
) -> CmdResult<Vec<history::CommitInfo>> {
    with_session(&state, |s| s.commits(branch.as_deref(), skip, limit.min(500)))
}

#[tauri::command]
fn open_commit(state: State<AppState>, id: String) -> CmdResult<history::CommitChanges> {
    with_session(&state, |s| Ok(s.commit(&id)?.0.changes.clone()))
}

#[tauri::command]
fn get_commit_diff(state: State<AppState>, id: String, path: String) -> CmdResult<Option<git::FileDiff>> {
    with_session(&state, |s| {
        let (c, repo) = s.commit(&id)?;
        Ok(c.diff(&repo, &path)?.map(|d| (*d).clone()))
    })
}

#[tauri::command]
fn get_commit_lines(state: State<AppState>, id: String, path: String, start: u32, end: u32) -> CmdResult<Vec<String>> {
    with_session(&state, |s| {
        let (c, repo) = s.commit(&id)?;
        c.lines(&repo, &path, start, end)
    })
}

#[tauri::command]
fn get_commit_file_text(state: State<AppState>, id: String, path: String) -> CmdResult<Option<String>> {
    with_session(&state, |s| {
        let (c, repo) = s.commit(&id)?;
        c.text(&repo, &path)
    })
}

#[tauri::command]
fn list_commit_dir(state: State<AppState>, id: String, path: String) -> CmdResult<Vec<git::DirEntry>> {
    with_session(&state, |s| history::list_tree_dir(&s.repo()?, &id, &path))
}

#[tauri::command]
fn set_scan_options(state: State<AppState>, ignore_whitespace: bool, base: Option<String>) -> CmdResult<Snapshot> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No repository open")?;
    session.set_scan_options(ignore_whitespace, base).map_err(|e| e.message().to_string())?;
    let root = session.root.to_string_lossy().into_owned();
    let mut snapshot = session.snapshot(Default::default());
    let live: Vec<&str> = snapshot.files.iter().map(|f| f.path.as_str()).collect();
    snapshot.viewed = state.store.prune_viewed(&root, &live);
    Ok(snapshot)
}

/// Open `path` (relative to the repo) at `line` in an editor. `editor` is a command such as
/// "code"; empty means the OS default app for the file.
#[tauri::command]
fn open_in_editor(state: State<AppState>, path: String, line: Option<u32>, editor: String) -> CmdResult<()> {
    let root = root_of(&state)?;
    if path.split(['/', '\\']).any(|p| p == "..") {
        return Err("Path is outside the repository".into());
    }
    let full = root.join(&path).to_string_lossy().into_owned();
    let ed = editor.trim();
    let mut cmd = if ed.is_empty() {
        system_open(&full)
    } else {
        let mut c = shell_command(ed);
        // VS Code and its forks need -g to take file:line; Zed and Sublime take it as is.
        // Editors that take a folder open the repository as the project (reusing its window
        // when it is already open) and then go to the file inside it.
        if matches!(ed, "code" | "cursor" | "windsurf" | "codium" | "zed" | "subl") {
            c.arg(root.as_os_str());
        }
        if matches!(ed, "code" | "cursor" | "windsurf" | "codium") {
            c.arg("-g");
        }
        c.arg(match line {
            Some(l) => format!("{full}:{l}"),
            None => full.clone(),
        });
        c
    };
    let who = if ed.is_empty() { "the default app" } else { ed };
    cmd.spawn().map(|_| ()).map_err(|e| format!("Could not start {who}: {e}"))
}

/// Editors install as .cmd shims on Windows (code.cmd), which only start through cmd.
fn shell_command(program: &str) -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", program]).creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(program)
    }
}

fn system_open(path: &str) -> std::process::Command {
    let program = if cfg!(windows) {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let mut c = std::process::Command::new(program);
    c.arg(path);
    c
}

fn with_session<T>(state: &State<AppState>, f: impl FnOnce(&mut Session) -> Result<T, git2::Error>) -> CmdResult<T> {
    let mut guard = state.session.lock().unwrap();
    let session = guard.as_mut().ok_or("No repository open")?;
    f(session).map_err(|e| e.message().to_string())
}

#[tauri::command]
fn set_viewed(state: State<AppState>, path: String, hash: Option<String>) -> CmdResult<()> {
    let root = root_of(&state)?;
    state.store.set_viewed(&root.to_string_lossy(), &path, hash.as_deref());
    Ok(())
}

#[tauri::command]
fn set_viewed_many(state: State<AppState>, marks: std::collections::HashMap<String, Option<String>>) -> CmdResult<()> {
    let root = root_of(&state)?;
    state.store.set_viewed_many(&root.to_string_lossy(), marks);
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
            set_viewed_many,
            recent_repos,
            forget_recent,
            launch_path,
            close_repo,
            list_dir,
            list_branches,
            list_commits,
            open_commit,
            get_commit_diff,
            get_commit_lines,
            get_commit_file_text,
            set_scan_options,
            open_in_editor,
            list_commit_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Morphe");
}
