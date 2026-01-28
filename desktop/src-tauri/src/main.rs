#![cfg_attr(all(not(debug_assertions), target_os = "windows"), windows_subsystem = "windows")]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
use std::io::{Read, Write};
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
    if let Ok(current_dir) = std::env::current_dir() {
        if let Some(repo_root) = find_repo_root(&current_dir) {
            let env_path = repo_root.join(".env");
            if env_path.exists() {
                let dotenv_vars = parse_dotenv(&env_path);
                for (key, value) in dotenv_vars {
                    merged_env.entry(key).or_insert(value);
                }
            }
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
    if let Some(writer) = state.writer.as_mut() {
        writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }
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

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(PtyState::new()))
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            create_run_dir,
            export_run
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
