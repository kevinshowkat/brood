#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use std::collections::HashMap;
#[cfg(target_family = "unix")]
use std::io::{BufRead, BufReader};
use std::io::{Read, Seek, SeekFrom, Write};
use std::process;
#[cfg(target_family = "unix")]
use std::os::unix::fs::PermissionsExt;
#[cfg(target_family = "unix")]
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
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
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
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
    run_dir: Option<String>,
    events_path: Option<String>,
    automation_frontend_ready: bool,
    automation_request_seq: u64,
    automation_waiters: HashMap<String, mpsc::Sender<serde_json::Value>>,
}

impl PtyState {
    fn new() -> Self {
        Self {
            writer: None,
            child: None,
            master: None,
            run_dir: None,
            events_path: None,
            automation_frontend_ready: false,
            automation_request_seq: 0,
            automation_waiters: HashMap::new(),
        }
    }
}

type SharedPtyState = Arc<Mutex<PtyState>>;

fn extract_arg_value(args: &[String], key: &str) -> Option<String> {
    let mut idx = 0usize;
    while idx < args.len() {
        if args[idx] == key {
            if idx + 1 < args.len() {
                return Some(args[idx + 1].clone());
            }
            return None;
        }
        idx += 1;
    }
    None
}

fn write_to_pty(state: &mut PtyState, data: &str) -> Result<(), String> {
    let Some(writer) = state.writer.as_mut() else {
        return Err("PTY not running".to_string());
    };
    writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

fn pty_status_value(state: &mut PtyState) -> serde_json::Value {
    let has_writer = state.writer.is_some();
    let mut has_child = state.child.is_some();
    let mut pid: Option<u32> = None;
    let mut child_running = false;

    if let Some(child) = state.child.as_mut() {
        pid = child.process_id();
        match child.try_wait() {
            Ok(Some(_)) => {
                has_child = false;
                state.child = None;
                state.writer = None;
                state.master = None;
                state.run_dir = None;
                state.events_path = None;
            }
            Ok(None) => {
                child_running = true;
            }
            Err(_) => {
                child_running = true;
            }
        }
    }

    serde_json::json!({
        "running": child_running && has_writer,
        "has_child": has_child,
        "has_writer": has_writer,
        "pid": pid,
        "automation_frontend_ready": state.automation_frontend_ready,
        "run_dir": state.run_dir.clone(),
        "events_path": state.events_path.clone(),
    })
}

#[tauri::command]
fn spawn_pty(
    state: State<'_, SharedPtyState>,
    app: tauri::AppHandle,
    command: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    let mut state = state.inner().lock().map_err(|_| "Lock poisoned")?;
    if let Some(mut child) = state.child.take() {
        let _ = child.kill();
    }
    state.run_dir = None;
    state.events_path = None;

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
    for arg in &args {
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

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let run_dir = extract_arg_value(&args, "--out");
    let events_path = extract_arg_value(&args, "--events");

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
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
    state.run_dir = run_dir;
    state.events_path = events_path;
    Ok(())
}

#[tauri::command]
fn write_pty(state: State<'_, SharedPtyState>, data: String) -> Result<(), String> {
    let mut state = state.inner().lock().map_err(|_| "Lock poisoned")?;
    write_to_pty(&mut state, &data)
}

#[tauri::command]
fn resize_pty(state: State<'_, SharedPtyState>, cols: u16, rows: u16) -> Result<(), String> {
    let mut state = state.inner().lock().map_err(|_| "Lock poisoned")?;
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

fn run_export_attempt(
    program: &str,
    args: &[String],
    cwd: Option<&Path>,
    env: &HashMap<String, String>,
) -> Result<(), String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    for (key, value) in env {
        cmd.env(key, value);
    }

    let output = cmd.output().map_err(|e| format!("{program}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else if let Some(code) = output.status.code() {
        format!("exit code {code}")
    } else {
        "terminated by signal".to_string()
    };
    Err(format!("{program}: {detail}"))
}

#[tauri::command]
fn export_run(run_dir: String, out_path: String) -> Result<(), String> {
    let run_dir_path = PathBuf::from(&run_dir);
    if !run_dir_path.exists() {
        return Err(format!("run dir not found: {run_dir}"));
    }

    let out_path_buf = PathBuf::from(&out_path);
    if let Some(parent) = out_path_buf.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let env = collect_brood_env_snapshot();
    let py_args = vec![
        "-m".to_string(),
        "brood_engine.cli".to_string(),
        "export".to_string(),
        "--run".to_string(),
        run_dir.clone(),
        "--out".to_string(),
        out_path.clone(),
    ];
    let brood_args = vec![
        "export".to_string(),
        "--run".to_string(),
        run_dir.clone(),
        "--out".to_string(),
        out_path.clone(),
    ];

    let mut errors: Vec<String> = Vec::new();

    if let Some(repo_root) = find_repo_root_best_effort() {
        for py in ["python", "python3"] {
            match run_export_attempt(py, &py_args, Some(&repo_root), &env) {
                Ok(()) => return Ok(()),
                Err(err) => errors.push(err),
            }
        }
    }

    match run_export_attempt("brood", &brood_args, Some(&run_dir_path), &env) {
        Ok(()) => Ok(()),
        Err(err) => {
            errors.push(err);
            Err(format!("export failed: {}", errors.join(" | ")))
        }
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
fn get_pty_status(state: State<'_, SharedPtyState>) -> Result<serde_json::Value, String> {
    let mut state = state.inner().lock().map_err(|_| "Lock poisoned")?;
    Ok(pty_status_value(&mut state))
}

#[tauri::command]
fn read_file_since(
    path: String,
    offset: u64,
    max_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    let limit = max_bytes.unwrap_or(1024 * 1024); // 1MB safety cap per poll
    let mut file = std::fs::File::open(&path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    let file_len = metadata.len();
    let safe_offset = offset.min(file_len);
    file.seek(SeekFrom::Start(safe_offset))
        .map_err(|e| e.to_string())?;

    let mut buffer = Vec::new();
    // Read up to `limit` bytes to avoid giant allocations if the offset gets reset incorrectly.
    file.take(limit)
        .read_to_end(&mut buffer)
        .map_err(|e| e.to_string())?;
    let new_offset = safe_offset + buffer.len() as u64;
    Ok(serde_json::json!({
        "chunk": buffer,
        "new_offset": new_offset,
        "file_len": file_len,
        "clamped_offset": safe_offset,
    }))
}

#[derive(serde::Deserialize)]
struct BridgeRequest {
    op: String,
    data: Option<String>,
    action: Option<String>,
    payload: Option<serde_json::Value>,
    timeout_ms: Option<u64>,
}

#[derive(serde::Deserialize)]
struct BridgeAutomationResult {
    request_id: String,
    ok: Option<bool>,
    detail: Option<String>,
    state: Option<serde_json::Value>,
    events: Option<Vec<serde_json::Value>>,
    markers: Option<Vec<String>>,
}

#[cfg(target_family = "unix")]
fn write_bridge_response(stream: &mut UnixStream, payload: serde_json::Value) {
    if let Ok(encoded) = serde_json::to_string(&payload) {
        let _ = stream.write_all(encoded.as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
    }
}

#[cfg(target_family = "unix")]
fn handle_bridge_client(mut stream: UnixStream, state: SharedPtyState, app_handle: tauri::AppHandle) {
    let reader_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut reader = BufReader::new(reader_stream);
    let mut line = String::new();
    loop {
        line.clear();
        let n = match reader.read_line(&mut line) {
            Ok(value) => value,
            Err(_) => break,
        };
        if n == 0 {
            break;
        }
        let req: BridgeRequest = match serde_json::from_str(line.trim()) {
            Ok(value) => value,
            Err(err) => {
                write_bridge_response(
                    &mut stream,
                    serde_json::json!({
                        "ok": false,
                        "error": format!("invalid_json: {err}"),
                    }),
                );
                continue;
            }
        };

        match req.op.as_str() {
            "ping" => {
                write_bridge_response(&mut stream, serde_json::json!({"ok": true}));
            }
            "status" => {
                let mut guard = match state.lock() {
                    Ok(value) => value,
                    Err(_) => {
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({"ok": false, "error": "lock_poisoned"}),
                        );
                        continue;
                    }
                };
                let status = pty_status_value(&mut guard);
                write_bridge_response(
                    &mut stream,
                    serde_json::json!({
                        "ok": true,
                        "status": status,
                    }),
                );
            }
            "write" => {
                let payload = req.data.unwrap_or_default();
                let mut guard = match state.lock() {
                    Ok(value) => value,
                    Err(_) => {
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({"ok": false, "error": "lock_poisoned"}),
                        );
                        continue;
                    }
                };
                match write_to_pty(&mut guard, &payload) {
                    Ok(()) => {
                        let status = pty_status_value(&mut guard);
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({
                                "ok": true,
                                "status": status,
                            }),
                        );
                    }
                    Err(err) => {
                        let status = pty_status_value(&mut guard);
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({
                                "ok": false,
                                "error": err,
                                "status": status,
                            }),
                        );
                    }
                }
            }
            "automation" => {
                let action = req.action.unwrap_or_default();
                let action_payload = req.payload.unwrap_or_else(|| serde_json::json!({}));
                let wait_ms = req.timeout_ms.unwrap_or(10_000);
                let (request_id, rx) = {
                    let mut guard = match state.lock() {
                        Ok(value) => value,
                        Err(_) => {
                            write_bridge_response(
                                &mut stream,
                                serde_json::json!({"ok": false, "error": "lock_poisoned"}),
                            );
                            continue;
                        }
                    };

                    if action.trim().is_empty() {
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({"ok": false, "error": "missing_automation_action"}),
                        );
                        continue;
                    }
                    if !guard.automation_frontend_ready {
                        write_bridge_response(
                            &mut stream,
                            serde_json::json!({
                                "ok": false,
                                "error": "automation_frontend_not_ready",
                                "detail": "Desktop UI automation handler is not yet registered. Wait for app UI bootstrap.",
                                "state": pty_status_value(&mut guard),
                                "markers": ["automation_frontend_not_ready"],
                            }),
                        );
                        continue;
                    }

                    let id = format!("{}-{}", process::id(), guard.automation_request_seq);
                    guard.automation_request_seq = guard.automation_request_seq.saturating_add(1);
                    let (sender, receiver) = mpsc::channel();
                    let _ = guard.automation_waiters.insert(id.clone(), sender);
                    (id, receiver)
                };

                let emit_payload = serde_json::json!({
                    "request_id": request_id,
                    "action": action,
                    "payload": action_payload,
                    "timeout_ms": wait_ms,
                });

                eprintln!(
                    "brood desktop bridge automation request {} dispatched (action={})",
                    request_id,
                    action
                );
                let _ = app_handle.emit_all("desktop-automation", emit_payload);
                eprintln!("brood desktop bridge automation event emitted request_id={request_id}");

                let timeout_ms = wait_ms.max(250);
                let timeout = Duration::from_millis(timeout_ms);
                let mut result_payload = match rx.recv_timeout(timeout) {
                    Ok(payload) => payload,
                    Err(_) => {
                        let _ = {
                            if let Ok(mut guard) = state.lock() {
                                guard.automation_waiters.remove(&request_id)
                            } else {
                                None
                            }
                        };
                        serde_json::json!({
                            "ok": false,
                            "error": "automation_timeout",
                            "request_id": request_id,
                            "detail": "Automation operation timed out waiting for app-side result.",
                            "state": serde_json::json!({}),
                            "markers": ["automation_timeout"],
                        })
                    }
                };

                if let Some(map) = result_payload.as_object_mut() {
                    if map.get("request_id").is_none() {
                        map.insert("request_id".to_string(), serde_json::json!(request_id.clone()));
                    }
                    if map.get("ok").is_none() {
                        map.insert("ok".to_string(), serde_json::json!(true));
                    }
                } else {
                    result_payload = serde_json::json!({
                        "ok": false,
                        "request_id": request_id,
                        "error": "automation_result_type_invalid",
                    });
                }

                write_bridge_response(&mut stream, result_payload);
            }
            _ => {
                write_bridge_response(
                    &mut stream,
                    serde_json::json!({
                        "ok": false,
                        "error": format!("unsupported_op: {}", req.op),
                    }),
                );
            }
        }
    }
}

#[tauri::command]
fn report_automation_result(
    state: State<'_, SharedPtyState>,
    result: BridgeAutomationResult,
) -> Result<(), String> {
    let request_id = result.request_id.trim().to_string();
    if request_id.is_empty() {
        eprintln!("brood desktop bridge report_automation_result missing request_id");
        return Err("missing request_id".to_string());
    }
    eprintln!("brood desktop bridge received automation result for request_id={request_id}");
    let sender = {
        let mut guard = state.lock().map_err(|_| "lock_poisoned")?;
        guard
            .automation_waiters
            .remove(&request_id)
            .ok_or_else(|| {
                eprintln!(
                    "brood desktop bridge unknown_request_id={request_id}; waiter missing or already timed out"
                );
                "unknown_request_id".to_string()
            })
    }?;

    let mut payload = serde_json::json!({"ok": true, "request_id": request_id});
    if let Some(ok) = result.ok {
        payload["ok"] = serde_json::json!(ok);
    }
    if let Some(detail) = result.detail {
        payload["detail"] = serde_json::json!(detail);
    }
    if let Some(state_payload) = result.state {
        payload["state"] = state_payload;
    }
    if let Some(events) = result.events {
        payload["events"] = serde_json::json!(events);
    }
    if let Some(markers) = result.markers {
        payload["markers"] = serde_json::json!(markers);
    }

    eprintln!("brood desktop bridge automation result accepted request_id={request_id}");
    sender
        .send(payload)
        .map_err(|_| {
            eprintln!(
                "brood desktop bridge automation result send failed request_id={request_id}; receiver dropped"
            );
            "automation_receiver_dropped".to_string()
        })
}

#[tauri::command]
fn report_automation_frontend_ready(
    state: State<'_, SharedPtyState>,
    ready: bool,
) -> Result<(), String> {
    let mut guard = state.lock().map_err(|_| "lock_poisoned")?;
    guard.automation_frontend_ready = ready;
    Ok(())
}

fn start_external_bridge(state: SharedPtyState, app_handle: tauri::AppHandle) {
    #[cfg(target_family = "unix")]
    {
        let socket = std::env::var("BROOD_DESKTOP_BRIDGE_SOCKET")
            .unwrap_or_else(|_| "/tmp/brood_desktop_bridge.sock".to_string());
        let socket_path = PathBuf::from(socket);
        if let Some(parent) = socket_path.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                return;
            }
        }
        let _ = std::fs::remove_file(&socket_path);
        let listener = match UnixListener::bind(&socket_path) {
            Ok(value) => value,
            Err(err) => {
                eprintln!("brood desktop bridge bind failed: {err}");
                return;
            }
        };
        let _ = std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600));
        std::thread::spawn(move || {
            for incoming in listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        let clone = state.clone();
                        let bridge_handle = app_handle.clone();
                        std::thread::spawn(move || handle_bridge_client(stream, clone, bridge_handle));
                    }
                    Err(err) => {
                        eprintln!("brood desktop bridge accept failed: {err}");
                        break;
                    }
                }
            }
        });
    }
    #[cfg(not(target_family = "unix"))]
    {
        let _ = state;
    }
}

fn main() {
    let pty_state: SharedPtyState = Arc::new(Mutex::new(PtyState::new()));
    tauri::Builder::default()
        .manage(pty_state)
        .invoke_handler(tauri::generate_handler![
            report_automation_result,
            report_automation_frontend_ready,
            spawn_pty,
            write_pty,
            resize_pty,
            create_run_dir,
            get_repo_root,
            export_run,
            get_key_status,
            get_pty_status,
            read_file_since,
        ])
        .setup(|app| {
            let handle = app.handle();
            start_external_bridge(app.state::<SharedPtyState>().inner().clone(), handle.clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
