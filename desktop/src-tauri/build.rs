use std::env;
use std::fs;
use std::path::PathBuf;

#[cfg(target_family = "unix")]
use std::os::unix::fs::PermissionsExt;

fn ensure_native_engine_resource_placeholder() {
    let manifest_dir = env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let resource_path = PathBuf::from(manifest_dir)
        .join("resources")
        .join("brood-rs");
    if resource_path.exists() {
        return;
    }
    if let Some(parent) = resource_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // This placeholder keeps `cargo check` and `tauri dev` workflows working.
    // Real packaging overwrites it via `scripts/stage_rust_engine_binary.sh`.
    let stub = "#!/usr/bin/env bash\n# BROOD_RS_PLACEHOLDER_STUB\necho \"brood-rs resource not staged\" >&2\nexit 1\n";
    let _ = fs::write(&resource_path, stub);

    #[cfg(target_family = "unix")]
    {
        let _ = fs::set_permissions(&resource_path, fs::Permissions::from_mode(0o755));
    }
}

fn main() {
    ensure_native_engine_resource_placeholder();
    tauri_build::build()
}
