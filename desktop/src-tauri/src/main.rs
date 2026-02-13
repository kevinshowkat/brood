#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{Manager, State};

fn find_repo_root(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        if dir.join("brood_engine").is_dir() || dir.join("pyproject.toml").exists() {
            return Some(dir.to_path_buf());
        }
        current = dir.parent();
    }
    None
}

fn find_repo_root_best_effort() -> Option<PathBuf> {
    // Explicit override wins (useful for packaged apps).
    if let Ok(root) = std::env::var("BROOD_REPO_ROOT") {
        let path = PathBuf::from(root);
        if let Some(repo_root) = find_repo_root(&path) {
            return Some(repo_root);
        }
    }

    // Usual dev path: run from somewhere under the repo.
    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(repo_root) = find_repo_root(&current_dir) {
            return Some(repo_root);
        }
    }

    // When launched from Finder, current_dir may be `/`; fall back to the executable's location.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            if let Some(repo_root) = find_repo_root(parent) {
                return Some(repo_root);
            }
        }
    }

    // Some shells provide PWD even when current_dir is surprising.
    if let Ok(pwd) = std::env::var("PWD") {
        let path = PathBuf::from(pwd);
        if let Some(repo_root) = find_repo_root(&path) {
            return Some(repo_root);
        }
    }

    // Cargo sets this in dev; harmless elsewhere.
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let path = PathBuf::from(manifest_dir);
        if let Some(repo_root) = find_repo_root(&path) {
            return Some(repo_root);
        }
    }

    None
}

fn parse_dotenv(path: &Path) -> HashMap<String, String> {
    let content = std::fs::read_to_string(path).unwrap_or_default();
    let mut vars = HashMap::new();
    for raw_line in content.lines() {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(stripped) = line.strip_prefix("export ") {
            line = stripped.trim();
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let mut value = value.trim().to_string();
        if value.len() >= 2 {
            let bytes = value.as_bytes();
            if (bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"')
                || (bytes[0] == b'\'' && bytes[bytes.len() - 1] == b'\'')
            {
                value = value[1..value.len() - 1].to_string();
            }
        }
        vars.insert(key.to_string(), value);
    }
    vars
}

fn merge_dotenv_vars(target: &mut HashMap<String, String>, path: &Path) {
    if !path.exists() {
        return;
    }
    let vars = parse_dotenv(path);
    for (key, value) in vars {
        // Preserve existing explicit env vars, but do not let empty placeholders
        // (e.g. `OPENAI_API_KEY=`) block a non-empty value from a later `.env`.
        match target.get(&key) {
            None => {
                target.insert(key, value);
            }
            Some(existing) => {
                if existing.trim().is_empty() && !value.trim().is_empty() {
                    target.insert(key, value);
                }
            }
        }
    }
}

fn collect_brood_env_snapshot() -> HashMap<String, String> {
    let mut vars: HashMap<String, String> = std::env::vars().collect();

    // Preferred location for persisted desktop keys/config.
    if let Some(home) = tauri::api::path::home_dir() {
        merge_dotenv_vars(&mut vars, &home.join(".brood").join(".env"));
    }

    // Repo-local .env is useful in development.
    if let Some(repo_root) = find_repo_root_best_effort() {
        merge_dotenv_vars(&mut vars, &repo_root.join(".env"));
    }

    vars
}

struct PtyState {
    writer: Option<Box<dyn Write + Send>>,
    child: Option<Box<dyn portable_pty::Child + Send>>,
    master: Option<Box<dyn portable_pty::MasterPty + Send>>,
}

impl PtyState {
    fn new() -> Self {
        Self {
            writer: None,
            child: None,
            master: None,
        }
    }
}

#[tauri::command]
fn spawn_pty(
    state: State<'_, Mutex<PtyState>>,
    app: tauri::AppHandle,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "Lock poisoned")?;
    if let Some(mut child) = state.child.take() {
        let _ = child.kill();
    }

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(command);
    for arg in args {
        cmd.arg(arg);
    }
    if let Some(dir) = cwd {
        cmd.cwd(PathBuf::from(dir));
    }
    let mut merged_env = env.unwrap_or_default();
    if let Some(home) = tauri::api::path::home_dir() {
        merge_dotenv_vars(&mut merged_env, &home.join(".brood").join(".env"));
    }
    if let Some(repo_root) = find_repo_root_best_effort() {
        let env_path = repo_root.join(".env");
        if env_path.exists() {
            merge_dotenv_vars(&mut merged_env, &env_path);
        }
    }
    for (key, value) in merged_env {
        cmd.env(key, value);
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let master = pair.master;

    let app_handle = app.clone();
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = app_handle.emit_all("pty-data", data);
                }
                Err(_) => break,
            }
        }
        let _ = app_handle.emit_all("pty-exit", true);
    });

    state.writer = Some(writer);
    state.child = Some(child);
    state.master = Some(master);
    Ok(())
}

#[tauri::command]
fn write_pty(state: State<'_, Mutex<PtyState>>, data: String) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "Lock poisoned")?;
    let Some(writer) = state.writer.as_mut() else {
        return Err("PTY not running".to_string());
    };
    writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<'_, Mutex<PtyState>>, cols: u16, rows: u16) -> Result<(), String> {
    let mut state = state.lock().map_err(|_| "Lock poisoned")?;
    if let Some(master) = state.master.as_mut() {
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn create_run_dir() -> Result<serde_json::Value, String> {
    let home = tauri::api::path::home_dir().ok_or("No home dir")?;
    let run_root = home.join("brood_runs");
    std::fs::create_dir_all(&run_root).map_err(|e| e.to_string())?;
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S");
    let run_dir = run_root.join(format!("run-{}", stamp));
    std::fs::create_dir_all(&run_dir).map_err(|e| e.to_string())?;
    let events_path = run_dir.join("events.jsonl");
    Ok(serde_json::json!({
        "run_dir": run_dir.to_string_lossy(),
        "events_path": events_path.to_string_lossy(),
    }))
}

#[tauri::command]
fn get_repo_root() -> Result<String, String> {
    if let Some(repo_root) = find_repo_root_best_effort() {
        Ok(repo_root.to_string_lossy().to_string())
    } else {
        Err("repo root not found".to_string())
    }
}

#[tauri::command]
fn export_run(run_dir: String, out_path: String) -> Result<(), String> {
    let status = std::process::Command::new("brood")
        .arg("export")
        .arg("--run")
        .arg(run_dir)
        .arg("--out")
        .arg(out_path)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("export failed".to_string())
    }
}

#[tauri::command]
fn get_key_status() -> Result<serde_json::Value, String> {
    let vars = collect_brood_env_snapshot();
    let has = |key: &str| -> bool {
        vars.get(key)
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
    };

    let openai = has("OPENAI_API_KEY") || has("OPENAI_API_KEY_BACKUP");
    let gemini = has("GEMINI_API_KEY") || has("GOOGLE_API_KEY");
    let flux = has("BFL_API_KEY") || has("FLUX_API_KEY");
    let imagen = has("IMAGEN_API_KEY")
        || has("GOOGLE_API_KEY")
        || has("IMAGEN_VERTEX_PROJECT")
        || has("GOOGLE_APPLICATION_CREDENTIALS");
    let anthropic = has("ANTHROPIC_API_KEY");
    Ok(serde_json::json!({
        "openai": openai,
        "gemini": gemini,
        "imagen": imagen,
        "flux": flux,
        "anthropic": anthropic,
    }))
}

#[tauri::command]
fn get_pty_status(state: State<'_, Mutex<PtyState>>) -> Result<serde_json::Value, String> {
    let mut state = state.lock().map_err(|_| "Lock poisoned")?;
    let has_writer = state.writer.is_some();
    let mut has_child = state.child.is_some();
    let mut pid: Option<u32> = None;
    let mut child_running = false;

    if let Some(child) = state.child.as_mut() {
        pid = child.process_id();
        match child.try_wait() {
            Ok(Some(_)) => {
                // Child has exited. Drop handles so frontend can re-spawn cleanly.
                has_child = false;
                state.child = None;
                state.writer = None;
                state.master = None;
            }
            Ok(None) => {
                child_running = true;
            }
            Err(_) => {
                // If we can't poll, assume it's running; the PTY will error on write if not.
                child_running = true;
            }
        }
    }

    Ok(serde_json::json!({
        "running": child_running && has_writer,
        "has_child": has_child,
        "has_writer": has_writer,
        "pid": pid,
    }))
}

#[tauri::command]
fn read_file_since(path: String, offset: u64, max_bytes: Option<u64>) -> Result<serde_json::Value, String> {
    let limit = max_bytes.unwrap_or(1024 * 1024); // 1MB safety cap per poll
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let file_len = metadata.len();
    let safe_offset = offset.min(file_len);
    file.seek(SeekFrom::Start(safe_offset))
        .map_err(|e| e.to_string())?;

    let mut buffer = Vec::new();
    // Read up to `limit` bytes to avoid giant allocations if the offset gets reset incorrectly.
    file.take(limit).read_to_end(&mut buffer).map_err(|e| e.to_string())?;
    let new_offset = safe_offset + buffer.len() as u64;
    Ok(serde_json::json!({
        "chunk": buffer,
        "new_offset": new_offset,
        "file_len": file_len,
        "clamped_offset": safe_offset,
    }))
}

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(PtyState::new()))
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            create_run_dir,
            get_repo_root,
            export_run,
            get_key_status,
            get_pty_status,
            read_file_since
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
