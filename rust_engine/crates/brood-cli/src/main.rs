use std::collections::{HashMap, HashSet};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, ErrorKind, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use brood_contracts::chat::{parse_intent, CHAT_HELP_COMMANDS};
use brood_contracts::events::EventWriter;
use brood_engine::NativeEngine;
use clap::{Parser, Subcommand};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, Rgba, RgbaImage};
use reqwest::blocking::Client as HttpClient;
use reqwest::header::CONTENT_TYPE;
use serde_json::{json, Map, Value};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::{HeaderValue, Request};
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{connect as websocket_connect, Message as WsMessage, WebSocket};

#[derive(Debug, Parser)]
#[command(name = "brood-rs", version, about = "Brood Rust CLI scaffold")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Chat(ChatArgs),
    Run(RunArgs),
    Recreate(RecreateArgs),
    Export(ExportArgs),
}

#[derive(Debug, Parser)]
struct ChatArgs {
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    events: Option<PathBuf>,
    #[arg(long, default_value = "gpt-5.2")]
    text_model: String,
    #[arg(long)]
    image_model: Option<String>,
}

#[derive(Debug, Parser)]
struct RunArgs {
    #[arg(long)]
    prompt: String,
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    events: Option<PathBuf>,
    #[arg(long, default_value = "gpt-5.2")]
    text_model: String,
    #[arg(long)]
    image_model: Option<String>,
}

#[derive(Debug, Parser)]
struct RecreateArgs {
    #[arg(long)]
    reference: PathBuf,
    #[arg(long)]
    out: PathBuf,
    #[arg(long)]
    events: Option<PathBuf>,
    #[arg(long, default_value = "gpt-5.2")]
    text_model: String,
    #[arg(long)]
    image_model: Option<String>,
}

#[derive(Debug, Parser)]
struct ExportArgs {
    #[arg(long)]
    run: PathBuf,
    #[arg(long)]
    out: PathBuf,
}

const REALTIME_DESCRIPTION_MAX_CHARS: usize = 40;

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(err) => {
            eprintln!("brood-rs error: {err:#}");
            std::process::exit(1);
        }
    }
}

fn run() -> Result<i32> {
    let cli = Cli::parse();
    match cli.command {
        Command::Chat(args) => {
            run_chat_native(args)?;
            Ok(0)
        }
        Command::Run(args) => run_run_native(args),
        Command::Recreate(args) => run_recreate_native(args),
        Command::Export(args) => run_export_native(args),
    }
}

fn run_chat_native(args: ChatArgs) -> Result<()> {
    let run_out_dir = args.out.clone();
    let events_path = args
        .events
        .clone()
        .unwrap_or_else(|| args.out.join("events.jsonl"));
    let mut engine = NativeEngine::new(
        &args.out,
        &events_path,
        Some(args.text_model.clone()),
        args.image_model.clone(),
    )?;

    let stdin = io::stdin();
    let mut line = String::new();
    let mut profile = "default".to_string();
    let mut quality_preset = "quality".to_string();
    let mut last_prompt: Option<String> = None;
    let mut last_artifact_path: Option<String> = None;
    let shared_events = engine.event_writer();
    let mut canvas_context_rt: Option<CanvasContextRealtimeSession> = None;
    let mut intent_rt: Option<IntentIconsRealtimeSession> = None;
    let mut mother_intent_rt: Option<IntentIconsRealtimeSession> = None;

    println!("Brood chat started. Type /help for commands.");

    loop {
        print!("> ");
        io::stdout().flush()?;

        line.clear();
        let read = match stdin.read_line(&mut line) {
            Ok(read) => read,
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => return Err(err.into()),
        };
        if read == 0 {
            break;
        }

        let input = line.trim_end_matches(['\n', '\r']);
        let intent = parse_intent(input);
        if intent.action == "noop" {
            continue;
        }

        match intent.action.as_str() {
            "help" => {
                println!("Commands: {}", CHAT_HELP_COMMANDS.join(" "));
            }
            "set_profile" => {
                profile = value_as_non_empty_string(intent.command_args.get("profile"))
                    .unwrap_or_else(|| "default".to_string());
                println!("Profile set to {profile}");
            }
            "set_text_model" => {
                let current = engine.text_model().unwrap_or("gpt-5.2").to_string();
                let model =
                    value_as_non_empty_string(intent.command_args.get("model")).unwrap_or(current);
                engine.set_text_model(Some(model.clone()));
                println!("Text model set to {model}");
            }
            "set_image_model" => {
                let current = engine.image_model().unwrap_or("dryrun-image-1").to_string();
                let model =
                    value_as_non_empty_string(intent.command_args.get("model")).unwrap_or(current);
                engine.set_image_model(Some(model.clone()));
                println!("Image model set to {model}");
            }
            "set_active_image" => {
                if let Some(path) = value_as_non_empty_string(intent.command_args.get("path")) {
                    last_artifact_path = Some(path.clone());
                    println!("Active image set to {path}");
                } else {
                    println!("/use requires a path");
                }
            }
            "set_quality" => {
                if let Some(preset) =
                    value_as_non_empty_string(intent.settings_update.get("quality_preset"))
                {
                    quality_preset = preset;
                }
                println!("Quality preset: {quality_preset}");
            }
            "describe" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    println!("/describe requires a path (or set an active image with /use)");
                    continue;
                };

                let path = PathBuf::from(path_text);
                if !path.exists() {
                    println!("Describe failed: file not found ({})", path.display());
                    continue;
                }

                let max_chars = REALTIME_DESCRIPTION_MAX_CHARS;
                if let Some(inference) = vision_infer_description(&path, max_chars) {
                    engine.emit_event(
                        "image_description",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "description": inference.description,
                            "source": inference.source,
                            "model": inference.model,
                            "max_chars": max_chars,
                            "input_tokens": inference
                                .input_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                            "output_tokens": inference
                                .output_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        })),
                    )?;
                    let mut suffix = Vec::new();
                    if !inference.source.trim().is_empty() {
                        suffix.push(inference.source.trim().to_string());
                    }
                    if let Some(model) = inference.model.as_deref() {
                        if !model.trim().is_empty() {
                            suffix.push(model.trim().to_string());
                        }
                    }
                    if suffix.is_empty() {
                        println!("Description: {}", inference.description);
                    } else {
                        println!(
                            "Description ({}): {}",
                            suffix.join(", "),
                            inference.description
                        );
                    }
                } else {
                    let description = describe_local_image(&path, max_chars);
                    engine.emit_event(
                        "image_description",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "description": description,
                            "source": "native_fallback",
                            "model": "local",
                            "max_chars": max_chars,
                            "input_tokens": Value::Null,
                            "output_tokens": Value::Null,
                        })),
                    )?;
                    println!("Description (native_fallback, local): {description}");
                }
            }
            "canvas_context" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    println!("/canvas_context requires a path (or set an active image with /use)");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    println!("Canvas context failed: file not found ({})", path.display());
                    continue;
                }
                if let Some(inference) = vision_infer_canvas_context(&path, None) {
                    engine.emit_event(
                        "canvas_context",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "text": inference.text,
                            "source": inference.source,
                            "model": inference.model,
                            "input_tokens": inference
                                .input_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                            "output_tokens": inference
                                .output_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        })),
                    )?;
                    println!("{}", inference.text);
                } else {
                    let text = infer_canvas_context_text(&path);
                    engine.emit_event(
                        "canvas_context",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "text": text,
                            "source": "native_heuristic",
                            "model": "local",
                            "input_tokens": Value::Null,
                            "output_tokens": Value::Null,
                        })),
                    )?;
                    println!("{text}");
                }
            }
            "intent_infer" => {
                let raw_path = value_as_non_empty_string(intent.command_args.get("path"));
                let Some(path_text) = raw_path else {
                    let msg = "/intent_infer requires a JSON payload path";
                    engine.emit_event(
                        "mother_intent_infer_failed",
                        json_object(json!({
                            "error": msg,
                            "payload_path": Value::Null,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };

                let payload_path = PathBuf::from(path_text);
                if !payload_path.exists() {
                    let msg = format!(
                        "Intent infer failed: file not found ({})",
                        payload_path.display()
                    );
                    engine.emit_event(
                        "mother_intent_infer_failed",
                        json_object(json!({
                            "error": msg,
                            "payload_path": payload_path.to_string_lossy().to_string(),
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }

                let payload = match read_json_object(&payload_path) {
                    Some(payload) => payload,
                    None => {
                        let msg = format!(
                            "Intent infer failed: invalid JSON ({})",
                            payload_path.display()
                        );
                        engine.emit_event(
                            "mother_intent_infer_failed",
                            json_object(json!({
                                "error": msg,
                                "payload_path": payload_path.to_string_lossy().to_string(),
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                };

                let (intent_payload, source, model) =
                    infer_structured_intent_payload_provider_first(
                        &payload,
                        engine.text_model(),
                        "brood_intent_infer",
                    );
                let action_version = payload
                    .get("action_version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                engine.emit_event(
                    "mother_intent_inferred",
                    json_object(json!({
                        "payload_path": payload_path.to_string_lossy().to_string(),
                        "action_version": action_version,
                        "intent": intent_payload,
                        "source": source,
                        "model": model,
                    })),
                )?;
                println!("{}", serde_json::to_string(&intent_payload)?);
            }
            "prompt_compile" => {
                let raw_path = value_as_non_empty_string(intent.command_args.get("path"));
                let Some(path_text) = raw_path else {
                    let msg = "/prompt_compile requires a JSON payload path";
                    engine.emit_event(
                        "mother_prompt_compile_failed",
                        json_object(json!({
                            "error": msg,
                            "payload_path": Value::Null,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };

                let payload_path = PathBuf::from(path_text);
                if !payload_path.exists() {
                    let msg = format!(
                        "Prompt compile failed: file not found ({})",
                        payload_path.display()
                    );
                    engine.emit_event(
                        "mother_prompt_compile_failed",
                        json_object(json!({
                            "error": msg,
                            "payload_path": payload_path.to_string_lossy().to_string(),
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }

                let payload = match read_json_object(&payload_path) {
                    Some(payload) => payload,
                    None => {
                        let msg = format!(
                            "Prompt compile failed: invalid JSON ({})",
                            payload_path.display()
                        );
                        engine.emit_event(
                            "mother_prompt_compile_failed",
                            json_object(json!({
                                "error": msg,
                                "payload_path": payload_path.to_string_lossy().to_string(),
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                };

                let (compiled, source, model) = compile_mother_prompt_payload_provider_first(
                    &payload,
                    engine.text_model(),
                    "brood_prompt_compile",
                );
                let action_version = payload
                    .get("action_version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                engine.emit_event(
                    "mother_prompt_compiled",
                    json_object(json!({
                        "payload_path": payload_path.to_string_lossy().to_string(),
                        "action_version": action_version,
                        "compiled": compiled,
                        "source": source,
                        "model": model,
                    })),
                )?;
                if let Some(positive) = compiled
                    .get("positive_prompt")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    println!("{positive}");
                }
            }
            "mother_generate" => {
                let raw_path = value_as_non_empty_string(intent.command_args.get("path"));
                let image_model = engine.image_model().unwrap_or("auto").to_string();
                let Some(path_text) = raw_path else {
                    let msg = "/mother_generate requires a JSON payload path";
                    engine.emit_event(
                        "generation_failed",
                        json_object(json!({
                            "version_id": Value::Null,
                            "provider": "mother",
                            "model": image_model,
                            "error": msg,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };

                let payload_path = PathBuf::from(path_text);
                if !payload_path.exists() {
                    let msg = format!(
                        "Mother generate failed: file not found ({})",
                        payload_path.display()
                    );
                    engine.emit_event(
                        "generation_failed",
                        json_object(json!({
                            "version_id": Value::Null,
                            "provider": "mother",
                            "model": image_model,
                            "error": msg,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }

                let payload = match read_json_object(&payload_path) {
                    Some(payload) => payload,
                    None => {
                        let msg = format!(
                            "Mother generate failed: invalid JSON ({})",
                            payload_path.display()
                        );
                        engine.emit_event(
                            "generation_failed",
                            json_object(json!({
                                "version_id": Value::Null,
                                "provider": "mother",
                                "model": image_model,
                                "error": msg,
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                };

                let provider_hint =
                    provider_from_model_name(engine.image_model().unwrap_or("dryrun-image-1"));
                let request = match mother_generate_request_from_payload(
                    &payload,
                    &quality_preset,
                    provider_hint.as_deref(),
                ) {
                    Ok(request) => request,
                    Err(err) => {
                        let msg = format!("Mother generate failed: {err}");
                        engine.emit_event(
                            "generation_failed",
                            json_object(json!({
                                "version_id": Value::Null,
                                "provider": "mother",
                                "model": image_model,
                                "error": msg,
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                };

                let plan =
                    engine.preview_plan(&request.prompt, &request.settings, &request.intent)?;
                println!(
                    "Mother plan: {} image via {}:{} size={} cached={} refs={}",
                    plan.images,
                    plan.provider,
                    plan.model,
                    plan.size,
                    plan.cached,
                    request.source_images.len()
                );

                let (artifacts, error_message) =
                    match engine.generate(&request.prompt, request.settings, request.intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Mother generate failed: {error}");
                } else {
                    println!("Mother generate complete.");
                }
            }
            "canvas_context_rt_start" => {
                if canvas_context_rt.is_none() {
                    canvas_context_rt =
                        Some(CanvasContextRealtimeSession::new(shared_events.clone()));
                }
                let Some(session) = canvas_context_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.start();
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime start failed.".to_string());
                    engine.emit_event(
                        "canvas_context_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": error,
                            "source": "openai_realtime",
                            "model": session.model(),
                            "fatal": true,
                        })),
                    )?;
                    println!("Canvas context realtime start failed: {error}");
                    canvas_context_rt = None;
                    continue;
                }
                println!("Canvas context realtime started.");
            }
            "canvas_context_rt_stop" => {
                if let Some(session) = canvas_context_rt.as_mut() {
                    session.stop();
                }
                canvas_context_rt = None;
                println!("Canvas context realtime stopped.");
            }
            "canvas_context_rt" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    let model = canvas_context_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(canvas_context_realtime_model);
                    let msg =
                        "/canvas_context_rt requires a path (or set an active image with /use)";
                    engine.emit_event(
                        "canvas_context_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    let model = canvas_context_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(canvas_context_realtime_model);
                    let msg = format!(
                        "Canvas context realtime failed: file not found ({})",
                        path.display()
                    );
                    engine.emit_event(
                        "canvas_context_failed",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }
                if canvas_context_rt.is_none() {
                    canvas_context_rt =
                        Some(CanvasContextRealtimeSession::new(shared_events.clone()));
                }
                let Some(session) = canvas_context_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.submit_snapshot(&path);
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime submit failed.".to_string());
                    engine.emit_event(
                        "canvas_context_failed",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "error": error,
                            "source": "openai_realtime",
                            "model": session.model(),
                            "fatal": true,
                        })),
                    )?;
                    println!("Canvas context realtime submit failed: {error}");
                    session.stop();
                    canvas_context_rt = None;
                }
            }
            "intent_rt_start" => {
                if intent_rt.is_none() {
                    intent_rt = Some(IntentIconsRealtimeSession::new(
                        shared_events.clone(),
                        false,
                    ));
                }
                let Some(session) = intent_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.start();
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime start failed.".to_string());
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": error,
                            "source": "openai_realtime",
                            "model": session.model(),
                            "fatal": true,
                        })),
                    )?;
                    println!("Intent realtime start failed: {error}");
                    intent_rt = None;
                    continue;
                }
                println!("Intent realtime started.");
            }
            "intent_rt_stop" => {
                if let Some(session) = intent_rt.as_mut() {
                    session.stop();
                }
                intent_rt = None;
                println!("Intent realtime stopped.");
            }
            "intent_rt" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    let model = intent_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(|| intent_realtime_model(false));
                    let msg = "/intent_rt requires a path (or set an active image with /use)";
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    let model = intent_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(|| intent_realtime_model(false));
                    let msg = format!(
                        "Intent realtime failed: file not found ({})",
                        path.display()
                    );
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }
                if intent_rt.is_none() {
                    intent_rt = Some(IntentIconsRealtimeSession::new(
                        shared_events.clone(),
                        false,
                    ));
                }
                let Some(session) = intent_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.submit_snapshot(&path);
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime submit failed.".to_string());
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "error": error,
                            "source": "openai_realtime",
                            "model": session.model(),
                            "fatal": true,
                        })),
                    )?;
                    println!("Intent realtime submit failed: {error}");
                    session.stop();
                    intent_rt = None;
                }
            }
            "intent_rt_mother_start" => {
                if mother_intent_rt.is_none() {
                    mother_intent_rt =
                        Some(IntentIconsRealtimeSession::new(shared_events.clone(), true));
                }
                let Some(session) = mother_intent_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.start();
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime start failed.".to_string());
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": error,
                            "source": "openai_realtime",
                            "model": session.model(),
                            "fatal": true,
                        })),
                    )?;
                    println!("Mother intent realtime start failed: {error}");
                    mother_intent_rt = None;
                    continue;
                }
                println!("Mother intent realtime started.");
            }
            "intent_rt_mother_stop" => {
                if let Some(session) = mother_intent_rt.as_mut() {
                    session.stop();
                }
                mother_intent_rt = None;
                println!("Mother intent realtime stopped.");
            }
            "intent_rt_mother" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    let model = mother_intent_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(|| intent_realtime_model(true));
                    let msg =
                        "/intent_rt_mother requires a path (or set an active image with /use)";
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": Value::Null,
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    let model = mother_intent_rt
                        .as_ref()
                        .map(|session| session.model().to_string())
                        .unwrap_or_else(|| intent_realtime_model(true));
                    let msg = format!(
                        "Mother intent realtime failed: file not found ({})",
                        path.display()
                    );
                    engine.emit_event(
                        "intent_icons_failed",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "error": msg,
                            "source": "openai_realtime",
                            "model": model,
                            "fatal": true,
                        })),
                    )?;
                    println!("{msg}");
                    continue;
                }
                if mother_intent_rt.is_none() {
                    mother_intent_rt =
                        Some(IntentIconsRealtimeSession::new(shared_events.clone(), true));
                }
                let Some(session) = mother_intent_rt.as_mut() else {
                    continue;
                };
                let (ok, err) = session.submit_snapshot(&path);
                if !ok {
                    let error = err.unwrap_or_else(|| "Realtime submit failed.".to_string());
                    let mut payload = json_object(json!({
                        "image_path": path.to_string_lossy().to_string(),
                        "error": error,
                        "source": "openai_realtime",
                        "model": session.model(),
                        "fatal": true,
                    }));
                    if let Some(action_version) = extract_action_version_from_path(&path) {
                        payload.insert(
                            "action_version".to_string(),
                            Value::Number(action_version.into()),
                        );
                    }
                    engine.emit_event("intent_icons_failed", payload)?;
                    println!("Mother intent realtime submit failed: {error}");
                    session.stop();
                    mother_intent_rt = None;
                }
            }
            "diagnose" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    println!("/diagnose requires a path (or set an active image with /use)");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    println!("Diagnose failed: file not found ({})", path.display());
                    continue;
                }
                if let Some(inference) = vision_infer_diagnosis(&path) {
                    engine.emit_event(
                        "image_diagnosis",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "text": inference.text,
                            "source": inference.source,
                            "model": inference.model,
                            "input_tokens": inference
                                .input_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                            "output_tokens": inference
                                .output_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        })),
                    )?;
                    println!("{}", inference.text);
                } else {
                    let text = infer_diagnosis_text(&path);
                    engine.emit_event(
                        "image_diagnosis",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "text": text,
                            "source": "native_heuristic",
                            "model": "local",
                            "input_tokens": Value::Null,
                            "output_tokens": Value::Null,
                        })),
                    )?;
                    println!("{text}");
                }
            }
            "recast" => {
                let requested_path = value_as_non_empty_string(intent.command_args.get("path"));
                let path_text = requested_path.or_else(|| last_artifact_path.clone());
                let Some(path_text) = path_text else {
                    println!("/recast requires a path (or set an active image with /use)");
                    continue;
                };
                let path = PathBuf::from(path_text);
                if !path.exists() {
                    println!("Recast failed: file not found ({})", path.display());
                    continue;
                }
                let prompt = "Recast the provided image into a completely different medium and context. This is a lateral creative leap (not a minor style tweak). Preserve the core idea/subject identity, but change the form factor, materials, and world. Output ONE coherent image. No split-screen or collage. No text overlays.";
                let mut settings = chat_settings(&quality_preset);
                settings.insert(
                    "init_image".to_string(),
                    Value::String(path.to_string_lossy().to_string()),
                );
                let mut generation_intent = Map::new();
                generation_intent.insert("action".to_string(), Value::String("recast".to_string()));
                generation_intent.insert(
                    "source_images".to_string(),
                    Value::Array(vec![Value::String(path.to_string_lossy().to_string())]),
                );
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                let plan = engine.preview_plan(prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );
                let (artifacts, error_message) =
                    match engine.generate(prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Recast failed: {error}");
                } else {
                    println!("Recast complete.");
                }
            }
            "blend" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 2 {
                    println!("Usage: /blend <image_a> <image_b>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                if !path_a.exists() {
                    println!("Blend failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Blend failed: file not found ({})", path_b.display());
                    continue;
                }
                let prompt = "Combine the two provided photos into a single coherent blended photo. Do not make a split-screen or side-by-side collage; integrate them into one scene. Keep it photorealistic and preserve key details from both images.";
                let mut settings = chat_settings(&quality_preset);
                settings.insert(
                    "init_image".to_string(),
                    Value::String(path_a.to_string_lossy().to_string()),
                );
                settings.insert(
                    "reference_images".to_string(),
                    Value::Array(vec![Value::String(path_b.to_string_lossy().to_string())]),
                );
                let mut generation_intent = Map::new();
                generation_intent.insert("action".to_string(), Value::String("blend".to_string()));
                generation_intent.insert(
                    "source_images".to_string(),
                    Value::Array(vec![
                        Value::String(path_a.to_string_lossy().to_string()),
                        Value::String(path_b.to_string_lossy().to_string()),
                    ]),
                );
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                let plan = engine.preview_plan(prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );
                let (artifacts, error_message) =
                    match engine.generate(prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Blend failed: {error}");
                } else {
                    println!("Blend complete.");
                }
            }
            "argue" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 2 {
                    println!("Usage: /argue <image_a> <image_b>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                if !path_a.exists() {
                    println!("Argue failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Argue failed: file not found ({})", path_b.display());
                    continue;
                }
                if let Some(inference) = vision_infer_argument(&path_a, &path_b) {
                    engine.emit_event(
                        "image_argument",
                        json_object(json!({
                            "image_paths": [
                                path_a.to_string_lossy().to_string(),
                                path_b.to_string_lossy().to_string(),
                            ],
                            "text": inference.text,
                            "source": inference.source,
                            "model": inference.model,
                            "input_tokens": inference
                                .input_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                            "output_tokens": inference
                                .output_tokens
                                .map(|value| Value::Number(value.into()))
                                .unwrap_or(Value::Null),
                        })),
                    )?;
                    println!("{}", inference.text);
                } else {
                    let text = infer_argument_text(&path_a, &path_b);
                    engine.emit_event(
                        "image_argument",
                        json_object(json!({
                            "image_paths": [
                                path_a.to_string_lossy().to_string(),
                                path_b.to_string_lossy().to_string(),
                            ],
                            "text": text,
                            "source": "native_heuristic",
                            "model": "local",
                            "input_tokens": Value::Null,
                            "output_tokens": Value::Null,
                        })),
                    )?;
                    println!("{text}");
                }
            }
            "bridge" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 2 {
                    println!("Usage: /bridge <image_a> <image_b>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                if !path_a.exists() {
                    println!("Bridge failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Bridge failed: file not found ({})", path_b.display());
                    continue;
                }
                let prompt = "Bridge the two provided images by generating a single new image that lives in the aesthetic midpoint. This is NOT a collage and NOT a literal mash-up. Find the shared design language: composition, lighting logic, color story, material palette, and mood. Output one coherent image that could plausibly sit between both references.";
                let mut settings = chat_settings(&quality_preset);
                settings.insert(
                    "init_image".to_string(),
                    Value::String(path_a.to_string_lossy().to_string()),
                );
                settings.insert(
                    "reference_images".to_string(),
                    Value::Array(vec![Value::String(path_b.to_string_lossy().to_string())]),
                );
                let mut generation_intent = Map::new();
                generation_intent.insert("action".to_string(), Value::String("bridge".to_string()));
                generation_intent.insert(
                    "source_images".to_string(),
                    Value::Array(vec![
                        Value::String(path_a.to_string_lossy().to_string()),
                        Value::String(path_b.to_string_lossy().to_string()),
                    ]),
                );
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                let plan = engine.preview_plan(prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );
                let (artifacts, error_message) =
                    match engine.generate(prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Bridge failed: {error}");
                } else {
                    println!("Bridge complete.");
                }
            }
            "swap_dna" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 2 {
                    println!("Usage: /swap_dna <image_a> <image_b>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                if !path_a.exists() {
                    println!("Swap DNA failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Swap DNA failed: file not found ({})", path_b.display());
                    continue;
                }
                let prompt = "Swap DNA between the two provided photos. Image A is the STRUCTURE source: framing/crop, geometry, pose, perspective, composition, object count, and spatial layout. Image B is the SURFACE source: color palette, materials/textures, lighting, mood, and finish. Preserve Image A structure decisions exactly while transferring Image B surface treatment. Resolve conflicts by prioritizing A for structure and B for surface. Output one coherent image only. Never output split-screen, collage, side-by-side, or double-exposure blends.";
                let mut settings = chat_settings(&quality_preset);
                settings.insert(
                    "init_image".to_string(),
                    Value::String(path_a.to_string_lossy().to_string()),
                );
                settings.insert(
                    "reference_images".to_string(),
                    Value::Array(vec![Value::String(path_b.to_string_lossy().to_string())]),
                );
                let mut generation_intent = Map::new();
                generation_intent
                    .insert("action".to_string(), Value::String("swap_dna".to_string()));
                generation_intent.insert(
                    "source_images".to_string(),
                    Value::Array(vec![
                        Value::String(path_a.to_string_lossy().to_string()),
                        Value::String(path_b.to_string_lossy().to_string()),
                    ]),
                );
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                let plan = engine.preview_plan(prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );
                let (artifacts, error_message) =
                    match engine.generate(prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Swap DNA failed: {error}");
                } else {
                    println!("Swap DNA complete.");
                }
            }
            "triforce" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 3 {
                    println!("Usage: /triforce <image_a> <image_b> <image_c>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                let path_c = PathBuf::from(paths[2].clone());
                if !path_a.exists() {
                    println!("Triforce failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Triforce failed: file not found ({})", path_b.display());
                    continue;
                }
                if !path_c.exists() {
                    println!("Triforce failed: file not found ({})", path_c.display());
                    continue;
                }
                let prompt = "Take the three provided images as vertices of a creative space and generate the centroid: ONE new image that sits equidistant from all three references. This is mood board distillation, not a collage. Find the shared design language (composition, lighting logic, color story, material palette, and mood), then output one coherent image that could plausibly sit between all three.";
                let mut settings = chat_settings(&quality_preset);
                settings.insert("n".to_string(), json!(1));
                settings.insert(
                    "init_image".to_string(),
                    Value::String(path_a.to_string_lossy().to_string()),
                );
                settings.insert(
                    "reference_images".to_string(),
                    Value::Array(vec![
                        Value::String(path_b.to_string_lossy().to_string()),
                        Value::String(path_c.to_string_lossy().to_string()),
                    ]),
                );
                let mut generation_intent = Map::new();
                generation_intent
                    .insert("action".to_string(), Value::String("triforce".to_string()));
                generation_intent.insert(
                    "source_images".to_string(),
                    Value::Array(vec![
                        Value::String(path_a.to_string_lossy().to_string()),
                        Value::String(path_b.to_string_lossy().to_string()),
                        Value::String(path_c.to_string_lossy().to_string()),
                    ]),
                );
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                let plan = engine.preview_plan(prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );
                let (artifacts, error_message) =
                    match engine.generate(prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);
                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);
                if let Some(error) = error_message {
                    println!("Triforce failed: {error}");
                } else {
                    println!("Triforce complete.");
                }
            }
            "extract_dna" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.is_empty() {
                    println!("Usage: /extract_dna <image_a> [image_b ...]");
                    continue;
                }
                for path_text in paths {
                    let path = PathBuf::from(path_text);
                    if !path.exists() {
                        let msg =
                            format!("Extract DNA failed: file not found ({})", path.display());
                        engine.emit_event(
                            "image_dna_extracted_failed",
                            json_object(json!({
                                "image_path": path.to_string_lossy().to_string(),
                                "error": msg,
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                    let inference = vision_infer_dna_signature(&path);
                    let dna = inference
                        .as_ref()
                        .map(|value| DnaSignature {
                            palette: value.palette.clone(),
                            colors: value.colors.clone(),
                            materials: value.materials.clone(),
                            summary: value.summary.clone(),
                        })
                        .unwrap_or_else(|| extract_dna_signature(&path));
                    let source = inference
                        .as_ref()
                        .map(|value| value.source.clone())
                        .unwrap_or_else(|| "native_heuristic".to_string());
                    let model_name = inference
                        .as_ref()
                        .and_then(|value| value.model.clone())
                        .unwrap_or_else(|| "local".to_string());
                    let input_tokens = inference
                        .as_ref()
                        .and_then(|value| value.input_tokens)
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null);
                    let output_tokens = inference
                        .as_ref()
                        .and_then(|value| value.output_tokens)
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null);
                    engine.emit_event(
                        "image_dna_extracted",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "palette": dna.palette,
                            "colors": dna.colors,
                            "materials": dna.materials,
                            "summary": dna.summary,
                            "source": source,
                            "model": model_name,
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                        })),
                    )?;
                    println!(
                        "DNA extracted ({})",
                        path.file_name().and_then(|v| v.to_str()).unwrap_or("image")
                    );
                    if !dna.summary.trim().is_empty() {
                        println!("- {}", dna.summary.trim());
                    }
                }
            }
            "soul_leech" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.is_empty() {
                    println!("Usage: /soul_leech <image_a> [image_b ...]");
                    continue;
                }
                for path_text in paths {
                    let path = PathBuf::from(path_text);
                    if !path.exists() {
                        let msg = format!("Soul Leech failed: file not found ({})", path.display());
                        engine.emit_event(
                            "image_soul_extracted_failed",
                            json_object(json!({
                                "image_path": path.to_string_lossy().to_string(),
                                "error": msg,
                            })),
                        )?;
                        println!("{msg}");
                        continue;
                    }
                    let inference = vision_infer_soul_signature(&path);
                    let soul = inference
                        .as_ref()
                        .map(|value| SoulSignature {
                            emotion: value.emotion.clone(),
                            summary: value.summary.clone(),
                        })
                        .unwrap_or_else(|| extract_soul_signature(&path));
                    let source = inference
                        .as_ref()
                        .map(|value| value.source.clone())
                        .unwrap_or_else(|| "native_heuristic".to_string());
                    let model_name = inference
                        .as_ref()
                        .and_then(|value| value.model.clone())
                        .unwrap_or_else(|| "local".to_string());
                    let input_tokens = inference
                        .as_ref()
                        .and_then(|value| value.input_tokens)
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null);
                    let output_tokens = inference
                        .as_ref()
                        .and_then(|value| value.output_tokens)
                        .map(|value| Value::Number(value.into()))
                        .unwrap_or(Value::Null);
                    engine.emit_event(
                        "image_soul_extracted",
                        json_object(json!({
                            "image_path": path.to_string_lossy().to_string(),
                            "emotion": soul.emotion,
                            "summary": soul.summary,
                            "source": source,
                            "model": model_name,
                            "input_tokens": input_tokens,
                            "output_tokens": output_tokens,
                        })),
                    )?;
                    println!(
                        "Soul extracted ({})",
                        path.file_name().and_then(|v| v.to_str()).unwrap_or("image")
                    );
                    if !soul.summary.trim().is_empty() {
                        println!("- {}", soul.summary.trim());
                    }
                }
            }
            "extract_rule" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 3 {
                    println!("Usage: /extract_rule <image_a> <image_b> <image_c>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                let path_c = PathBuf::from(paths[2].clone());
                if !path_a.exists() {
                    println!(
                        "Extract the Rule failed: file not found ({})",
                        path_a.display()
                    );
                    continue;
                }
                if !path_b.exists() {
                    println!(
                        "Extract the Rule failed: file not found ({})",
                        path_b.display()
                    );
                    continue;
                }
                if !path_c.exists() {
                    println!(
                        "Extract the Rule failed: file not found ({})",
                        path_c.display()
                    );
                    continue;
                }
                let inference = vision_infer_triplet_rule(&path_a, &path_b, &path_c);
                let rule = inference
                    .as_ref()
                    .map(|value| TripletRuleOutput {
                        principle: value.principle.clone(),
                        evidence: value.evidence.clone(),
                        annotations: value.annotations.clone(),
                        confidence: value.confidence,
                    })
                    .unwrap_or_else(|| infer_triplet_rule(&path_a, &path_b, &path_c));
                let source = inference
                    .as_ref()
                    .map(|value| value.source.clone())
                    .unwrap_or_else(|| "native_heuristic".to_string());
                let model_name = inference
                    .as_ref()
                    .and_then(|value| value.model.clone())
                    .unwrap_or_else(|| "local".to_string());
                let input_tokens = inference
                    .as_ref()
                    .and_then(|value| value.input_tokens)
                    .map(|value| Value::Number(value.into()))
                    .unwrap_or(Value::Null);
                let output_tokens = inference
                    .as_ref()
                    .and_then(|value| value.output_tokens)
                    .map(|value| Value::Number(value.into()))
                    .unwrap_or(Value::Null);
                engine.emit_event(
                    "triplet_rule",
                    json_object(json!({
                        "image_paths": [
                            path_a.to_string_lossy().to_string(),
                            path_b.to_string_lossy().to_string(),
                            path_c.to_string_lossy().to_string(),
                        ],
                        "principle": rule.principle,
                        "evidence": rule.evidence,
                        "annotations": rule.annotations,
                        "source": source,
                        "model": model_name,
                        "confidence": rule.confidence,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    })),
                )?;
                println!("RULE:\n{}", rule.principle);
                if !rule.evidence.is_empty() {
                    println!("\nEVIDENCE:");
                    for row in &rule.evidence {
                        let image = row
                            .get("image")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let note = row
                            .get("note")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        println!("- {}: {}", image, note);
                    }
                }
            }
            "odd_one_out" => {
                let paths = value_as_string_list(intent.command_args.get("paths"));
                if paths.len() < 3 {
                    println!("Usage: /odd_one_out <image_a> <image_b> <image_c>");
                    continue;
                }
                let path_a = PathBuf::from(paths[0].clone());
                let path_b = PathBuf::from(paths[1].clone());
                let path_c = PathBuf::from(paths[2].clone());
                if !path_a.exists() {
                    println!("Odd One Out failed: file not found ({})", path_a.display());
                    continue;
                }
                if !path_b.exists() {
                    println!("Odd One Out failed: file not found ({})", path_b.display());
                    continue;
                }
                if !path_c.exists() {
                    println!("Odd One Out failed: file not found ({})", path_c.display());
                    continue;
                }
                let inference = vision_infer_triplet_odd_one_out(&path_a, &path_b, &path_c);
                let odd = inference
                    .as_ref()
                    .map(|value| TripletOddOneOutOutput {
                        odd_image: value.odd_image.clone(),
                        odd_index: value.odd_index,
                        pattern: value.pattern.clone(),
                        explanation: value.explanation.clone(),
                        confidence: value.confidence,
                    })
                    .unwrap_or_else(|| infer_triplet_odd_one_out(&path_a, &path_b, &path_c));
                let source = inference
                    .as_ref()
                    .map(|value| value.source.clone())
                    .unwrap_or_else(|| "native_heuristic".to_string());
                let model_name = inference
                    .as_ref()
                    .and_then(|value| value.model.clone())
                    .unwrap_or_else(|| "local".to_string());
                let input_tokens = inference
                    .as_ref()
                    .and_then(|value| value.input_tokens)
                    .map(|value| Value::Number(value.into()))
                    .unwrap_or(Value::Null);
                let output_tokens = inference
                    .as_ref()
                    .and_then(|value| value.output_tokens)
                    .map(|value| Value::Number(value.into()))
                    .unwrap_or(Value::Null);
                engine.emit_event(
                    "triplet_odd_one_out",
                    json_object(json!({
                        "image_paths": [
                            path_a.to_string_lossy().to_string(),
                            path_b.to_string_lossy().to_string(),
                            path_c.to_string_lossy().to_string(),
                        ],
                        "odd_image": odd.odd_image,
                        "odd_index": odd.odd_index,
                        "pattern": odd.pattern,
                        "explanation": odd.explanation,
                        "source": source,
                        "model": model_name,
                        "confidence": odd.confidence,
                        "input_tokens": input_tokens,
                        "output_tokens": output_tokens,
                    })),
                )?;
                println!("ODD ONE OUT: {}", odd.odd_image);
                if !odd.pattern.trim().is_empty() {
                    println!("\nPATTERN:\n{}", odd.pattern.trim());
                }
                if !odd.explanation.trim().is_empty() {
                    println!("\nWHY:\n{}", odd.explanation.trim());
                }
            }
            "recreate" => {
                let path = value_as_non_empty_string(intent.command_args.get("path"));
                let Some(path_text) = path else {
                    println!("/recreate requires a path");
                    continue;
                };
                let reference = PathBuf::from(path_text);
                if !reference.exists() {
                    println!("Recreate failed: file not found ({})", reference.display());
                    continue;
                }
                let result = run_native_recreate_loop(&mut engine, &reference, &quality_preset, 1);
                match result {
                    Ok(result) => {
                        if let Some(inferred) =
                            result.get("inferred_prompt").and_then(Value::as_str)
                        {
                            if !inferred.trim().is_empty() {
                                let mut suffix: Vec<String> = Vec::new();
                                if let Some(source) =
                                    result.get("prompt_source").and_then(Value::as_str)
                                {
                                    if !source.trim().is_empty() {
                                        suffix.push(source.to_string());
                                    }
                                }
                                if let Some(model) =
                                    result.get("caption_model").and_then(Value::as_str)
                                {
                                    if !model.trim().is_empty() {
                                        suffix.push(model.to_string());
                                    }
                                }
                                if suffix.is_empty() {
                                    println!("Inferred prompt: {}", inferred.trim());
                                } else {
                                    println!(
                                        "Inferred prompt ({}): {}",
                                        suffix.join(", "),
                                        inferred.trim()
                                    );
                                }
                            }
                        }
                        println!("Recreate loop completed.");
                    }
                    Err(err) => {
                        println!("Recreate failed: {err}");
                    }
                }
            }
            "export" => {
                let format = value_as_non_empty_string(intent.command_args.get("format"))
                    .unwrap_or_else(|| "html".to_string());
                if format.to_ascii_lowercase() != "html" {
                    println!("Export format '{format}' is not supported in native mode.");
                    continue;
                }
                let out_path = run_out_dir.join(format!("export-{}.html", compact_timestamp()));
                export_html_native(&run_out_dir, &out_path)?;
                println!("Exported report to {}", out_path.display());
            }
            "optimize" => {
                let goals = value_as_string_list(intent.command_args.get("goals"));
                let mut mode = value_as_non_empty_string(intent.command_args.get("mode"))
                    .unwrap_or_else(|| "auto".to_string())
                    .to_ascii_lowercase();
                if mode != "auto" && mode != "review" {
                    mode = "auto".to_string();
                }
                if goals.is_empty() {
                    println!(
                        "No goals provided. Use /optimize [review] quality,cost,time,retrieval"
                    );
                    continue;
                }

                println!("Optimizing for: {} ({mode})", goals.join(", "));
                let max_rounds = 3u64;

                if mode == "review" {
                    let Some(receipt_path) = latest_receipt_path(&run_out_dir) else {
                        println!("No receipt available to analyze.");
                        continue;
                    };
                    let analysis_started = Instant::now();
                    let (analysis_excerpt, recommendations) =
                        build_optimize_analysis(&receipt_path, &goals, None);
                    let analysis_elapsed_s = analysis_started.elapsed().as_secs_f64();

                    engine.emit_event(
                        "analysis_ready",
                        json_object(json!({
                            "analysis_excerpt": analysis_excerpt,
                            "recommendations": recommendations
                                .iter()
                                .cloned()
                                .map(Value::Object)
                                .collect::<Vec<Value>>(),
                            "analysis_elapsed_s": analysis_elapsed_s,
                            "goals": goals.iter().cloned().map(Value::String).collect::<Vec<Value>>(),
                            "mode": mode,
                        })),
                    )?;

                    if !analysis_excerpt.trim().is_empty() {
                        println!("Analysis: {analysis_excerpt}");
                    }
                    if !recommendations.is_empty() {
                        println!("Recommendations:");
                        for rec in &recommendations {
                            println!("- {}", format_optimize_recommendation(rec));
                        }
                    }
                    println!("Optimize analysis in {:.1}s", analysis_elapsed_s);
                    println!("Review mode: no changes applied.");
                    continue;
                }

                for round in 2..=max_rounds {
                    let Some(receipt_path) = latest_receipt_path(&run_out_dir) else {
                        println!("No receipt available to analyze.");
                        break;
                    };
                    let analysis_started = Instant::now();
                    let (analysis_excerpt, recommendations) =
                        build_optimize_analysis(&receipt_path, &goals, Some((round, max_rounds)));
                    let analysis_elapsed_s = analysis_started.elapsed().as_secs_f64();

                    engine.emit_event(
                        "analysis_ready",
                        json_object(json!({
                            "analysis_excerpt": analysis_excerpt,
                            "recommendations": recommendations
                                .iter()
                                .cloned()
                                .map(Value::Object)
                                .collect::<Vec<Value>>(),
                            "analysis_elapsed_s": analysis_elapsed_s,
                            "goals": goals.iter().cloned().map(Value::String).collect::<Vec<Value>>(),
                            "round": round,
                            "round_total": max_rounds,
                            "mode": mode,
                        })),
                    )?;

                    if !analysis_excerpt.trim().is_empty() {
                        println!("Analysis: {analysis_excerpt}");
                    }
                    if recommendations.is_empty() {
                        println!("No recommendations; stopping optimize loop.");
                        break;
                    }
                    println!("Recommendations:");
                    for rec in &recommendations {
                        println!("- {}", format_optimize_recommendation(rec));
                    }

                    let mut settings = latest_thread_settings(&run_out_dir)
                        .unwrap_or_else(|| chat_settings(&quality_preset));
                    let (applied, skipped) =
                        apply_optimize_recommendations(&mut settings, &recommendations);
                    if !applied.is_empty() {
                        println!("Applying: {}", applied.join(", "));
                    }
                    if !skipped.is_empty() {
                        println!("Skipped: {}", skipped.join(", "));
                    }
                    if applied.is_empty() {
                        println!("No parameter changes to apply; stopping optimize loop.");
                        break;
                    }

                    println!("Optimize analysis in {:.1}s", analysis_elapsed_s);
                    let Some(prompt) = last_prompt
                        .clone()
                        .or_else(|| latest_thread_prompt(&run_out_dir))
                    else {
                        println!("No receipt available to analyze.");
                        break;
                    };

                    let mut generation_intent = Map::new();
                    generation_intent
                        .insert("action".to_string(), Value::String("optimize".to_string()));
                    if let Some(parent_version_id) = latest_thread_version_id(&run_out_dir) {
                        generation_intent.insert(
                            "parent_version_id".to_string(),
                            Value::String(parent_version_id),
                        );
                    }
                    generation_intent.insert(
                        "goals".to_string(),
                        Value::Array(goals.iter().cloned().map(Value::String).collect()),
                    );
                    generation_intent.insert("round".to_string(), Value::Number(round.into()));

                    let gen_started = Instant::now();
                    let (artifacts, error_message) =
                        match engine.generate(&prompt, settings, generation_intent) {
                            Ok(artifacts) => (artifacts, None),
                            Err(err) => (Vec::new(), Some(err.to_string())),
                        };
                    let elapsed_s = gen_started.elapsed().as_secs_f64();
                    let success = error_message.is_none();
                    let error_for_event = error_message.clone();
                    engine.emit_event(
                        "optimize_generation_done",
                        json_object(json!({
                            "round": round,
                            "round_total": max_rounds,
                            "elapsed_s": elapsed_s,
                            "goals": goals.iter().cloned().map(Value::String).collect::<Vec<Value>>(),
                            "success": success,
                            "error": error_for_event,
                        })),
                    )?;

                    if success && !artifacts.is_empty() {
                        update_last_artifact_path(&artifacts, &mut last_artifact_path);
                        last_prompt = Some(prompt);
                    }
                    if let Some(error) = error_message {
                        println!("Generation failed: {error}");
                        break;
                    }
                }

                println!("Optimize loop complete.");
            }
            "unknown" => {
                let command = value_as_non_empty_string(intent.command_args.get("command"))
                    .unwrap_or_else(|| "unknown".to_string());
                println!("Unknown command: {command}");
            }
            "generate" => {
                let mut prompt = intent.prompt.clone().unwrap_or_default();
                if prompt.trim().is_empty() {
                    if let Some(previous) = &last_prompt {
                        prompt = previous.clone();
                    }
                }
                if prompt.trim().is_empty() {
                    continue;
                }
                last_prompt = Some(prompt.clone());

                let usage = engine.track_context(&prompt, "")?;
                let pct = (usage.pct * 100.0).round() as i64;
                if usage.alert_level != "none" {
                    println!("Context usage: {pct}% (alert {})", usage.alert_level);
                } else {
                    println!("Context usage: {pct}%");
                }

                let mut settings = chat_settings(&quality_preset);
                let mut generation_intent = Map::new();
                generation_intent
                    .insert("action".to_string(), Value::String("generate".to_string()));
                generation_intent.insert("profile".to_string(), Value::String(profile.clone()));
                if let Some(init_image) =
                    active_image_for_edit_prompt(&prompt, last_artifact_path.as_deref())
                {
                    settings.insert("init_image".to_string(), Value::String(init_image.clone()));
                    generation_intent.insert(
                        "source_images".to_string(),
                        Value::Array(vec![Value::String(init_image)]),
                    );
                }

                let plan = engine.preview_plan(&prompt, &settings, &generation_intent)?;
                println!(
                    "Plan: {} images via {}:{} size={} cached={}",
                    plan.images, plan.provider, plan.model, plan.size, plan.cached
                );

                let (artifacts, error_message) =
                    match engine.generate(&prompt, settings, generation_intent) {
                        Ok(artifacts) => (artifacts, None),
                        Err(err) => (Vec::new(), Some(err.to_string())),
                    };
                update_last_artifact_path(&artifacts, &mut last_artifact_path);

                if let Some(reason) = engine.last_fallback_reason() {
                    println!("Model fallback: {reason}");
                }
                print_generation_cost_latency(&engine);

                if let Some(error) = error_message {
                    println!("Generation failed: {error}");
                } else {
                    println!("Generation complete.");
                }
            }
            _ => {
                println!(
                    "Unknown command: {}",
                    action_to_command_name(&intent.action).unwrap_or_else(|| intent.action.clone())
                );
            }
        }
    }

    if let Some(session) = intent_rt.as_mut() {
        session.stop();
    }
    if let Some(session) = mother_intent_rt.as_mut() {
        session.stop();
    }
    if let Some(session) = canvas_context_rt.as_mut() {
        session.stop();
    }
    engine.finish()?;
    Ok(())
}

fn run_run_native(args: RunArgs) -> Result<i32> {
    let events_path = args
        .events
        .clone()
        .unwrap_or_else(|| args.out.join("events.jsonl"));
    let mut engine = NativeEngine::new(
        &args.out,
        &events_path,
        Some(args.text_model.clone()),
        args.image_model.clone(),
    )?;
    let mut settings = Map::new();
    settings.insert("size".to_string(), Value::String("1024x1024".to_string()));
    settings.insert("n".to_string(), json!(1));
    settings.insert(
        "quality_preset".to_string(),
        Value::String("quality".to_string()),
    );
    let mut intent = Map::new();
    intent.insert("action".to_string(), Value::String("generate".to_string()));
    engine.generate(&args.prompt, settings, intent)?;
    engine.finish()?;
    Ok(0)
}

fn run_recreate_native(args: RecreateArgs) -> Result<i32> {
    let events_path = args
        .events
        .clone()
        .unwrap_or_else(|| args.out.join("events.jsonl"));
    let mut engine = NativeEngine::new(
        &args.out,
        &events_path,
        Some(args.text_model.clone()),
        args.image_model.clone(),
    )?;
    let result = run_native_recreate_loop(&mut engine, &args.reference, "quality", 2);
    engine.finish()?;
    result?;
    Ok(0)
}

fn run_export_native(args: ExportArgs) -> Result<i32> {
    export_html_native(&args.run, &args.out)?;
    println!("Exported to {}", args.out.display());
    Ok(0)
}

fn chat_settings(quality_preset: &str) -> Map<String, Value> {
    let mut settings = Map::new();
    settings.insert("size".to_string(), Value::String("1024x1024".to_string()));
    settings.insert("n".to_string(), json!(1));
    settings.insert(
        "output_format".to_string(),
        Value::String("png".to_string()),
    );
    settings.insert(
        "quality_preset".to_string(),
        Value::String(quality_preset.to_string()),
    );
    settings
}

fn describe_local_image(path: &Path, max_chars: usize) -> String {
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image")
        .replace('_', " ")
        .replace('-', " ");
    let base = if stem.trim().is_empty() {
        "image".to_string()
    } else {
        stem
    };
    let raw = format!("{} image", base.trim());
    truncate_for_describe(raw, max_chars)
}

fn truncate_for_describe(text: String, max_chars: usize) -> String {
    let trimmed = text.trim().to_string();
    if trimmed.chars().count() <= max_chars {
        return trimmed;
    }
    let mut out = String::new();
    for ch in trimmed.chars().take(max_chars.saturating_sub(1)) {
        out.push(ch);
    }
    out.push('…');
    out
}

fn format_cost(value: Option<f64>) -> String {
    match value {
        Some(raw) => format!("${raw:.4}"),
        None => "N/A".to_string(),
    }
}

fn format_latency(value: Option<f64>) -> String {
    match value {
        Some(raw) => format!("{raw:.2}s"),
        None => "N/A".to_string(),
    }
}

fn print_generation_cost_latency(engine: &NativeEngine) {
    let cost = engine
        .last_cost_latency()
        .map(|metrics| metrics.cost_total_usd);
    let latency = engine
        .last_cost_latency()
        .map(|metrics| metrics.latency_per_image_s);
    println!(
        "Cost of generation: {} | Latency per image: {}",
        format_cost(cost),
        format_latency(latency)
    );
}

fn update_last_artifact_path(
    artifacts: &[Map<String, Value>],
    last_artifact_path: &mut Option<String>,
) {
    if let Some(path) = artifacts
        .last()
        .and_then(|artifact| artifact.get("image_path"))
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        *last_artifact_path = Some(path);
    }
}

fn active_image_for_edit_prompt(prompt: &str, active_image_path: Option<&str>) -> Option<String> {
    if !is_edit_style_prompt(prompt) {
        return None;
    }
    let path = active_image_path
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let candidate = PathBuf::from(path);
    if candidate.exists() && candidate.is_file() {
        Some(path.to_string())
    } else {
        None
    }
}

fn is_edit_style_prompt(prompt: &str) -> bool {
    let mut tokens = prompt.split_whitespace();
    let head = tokens.next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(head.as_str(), "edit" | "replace")
}

fn value_as_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| item.as_str().map(str::trim).map(str::to_string))
        .filter(|item| !item.is_empty())
        .collect()
}

fn latest_thread_version(run_dir: &Path) -> Option<Map<String, Value>> {
    let thread_path = run_dir.join("thread.json");
    let payload = read_json_object(&thread_path)?;
    payload
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|rows| rows.last())
        .and_then(Value::as_object)
        .cloned()
}

fn latest_thread_prompt(run_dir: &Path) -> Option<String> {
    latest_thread_version(run_dir)?
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .map(str::to_string)
}

fn latest_thread_version_id(run_dir: &Path) -> Option<String> {
    latest_thread_version(run_dir)?
        .get("version_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|row| !row.is_empty())
        .map(str::to_string)
}

fn latest_thread_settings(run_dir: &Path) -> Option<Map<String, Value>> {
    latest_thread_version(run_dir)?
        .get("settings")
        .and_then(Value::as_object)
        .cloned()
}

fn latest_receipt_path(run_dir: &Path) -> Option<PathBuf> {
    if let Some(version) = latest_thread_version(run_dir) {
        if let Some(receipt) = version
            .get("artifacts")
            .and_then(Value::as_array)
            .and_then(|rows| rows.last())
            .and_then(Value::as_object)
            .and_then(|artifact| artifact.get("receipt_path"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|row| !row.is_empty())
        {
            let path = PathBuf::from(receipt);
            if path.exists() {
                return Some(path);
            }
        }
    }

    let mut newest: Option<(SystemTime, PathBuf)> = None;
    let entries = fs::read_dir(run_dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|row| row.to_str())
            .unwrap_or_default();
        if !(name.starts_with("receipt-") && name.ends_with(".json")) {
            continue;
        }
        let modified = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .unwrap_or(UNIX_EPOCH);
        match &newest {
            Some((best, _)) if modified <= *best => {}
            _ => newest = Some((modified, path)),
        }
    }
    newest.map(|(_, path)| path)
}

fn optimize_goal_present(goals: &[String], token: &str) -> bool {
    let needle = token.to_ascii_lowercase();
    goals
        .iter()
        .map(|goal| goal.to_ascii_lowercase())
        .any(|goal| goal.contains(&needle))
}

fn push_optimize_recommendation(
    recommendations: &mut Vec<Map<String, Value>>,
    seen: &mut Vec<String>,
    setting_name: &str,
    setting_value: Value,
    setting_target: &str,
    rationale: &str,
) {
    let key = format!("{setting_target}:{setting_name}");
    if seen.iter().any(|row| row == &key) {
        return;
    }
    seen.push(key);
    recommendations.push(json_object(json!({
        "setting_name": setting_name,
        "setting_value": setting_value,
        "setting_target": setting_target,
        "rationale": rationale,
    })));
}

fn build_optimize_analysis(
    receipt_path: &Path,
    goals: &[String],
    round: Option<(u64, u64)>,
) -> (String, Vec<Map<String, Value>>) {
    let receipt = read_json_object(receipt_path).unwrap_or_default();
    let resolved = receipt
        .get("resolved")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let result_metadata = receipt
        .get("result_metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let provider = resolved
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let model = resolved
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let size = resolved
        .get("size")
        .and_then(Value::as_str)
        .unwrap_or("1024x1024");
    let cost = result_metadata
        .get("cost_total_usd")
        .and_then(Value::as_f64)
        .map(|value| format!("${value:.4}"))
        .unwrap_or_else(|| "N/A".to_string());
    let latency = result_metadata
        .get("latency_per_image_s")
        .and_then(Value::as_f64)
        .map(|value| format!("{value:.2}s"))
        .unwrap_or_else(|| "N/A".to_string());

    let mut recommendations: Vec<Map<String, Value>> = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    if optimize_goal_present(goals, "quality") {
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "steps",
            json!(40),
            "provider_options",
            "Increase iterative refinement for higher detail fidelity.",
        );
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "guidance_scale",
            json!(7.5),
            "provider_options",
            "Strengthen prompt adherence for tighter composition.",
        );
    }
    if optimize_goal_present(goals, "cost") {
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "size",
            Value::String("768x768".to_string()),
            "top_level",
            "Reduce resolution to lower per-image spend.",
        );
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "n",
            json!(1),
            "top_level",
            "Keep a single sample per round to control spend.",
        );
    }
    if optimize_goal_present(goals, "time") {
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "steps",
            json!(22),
            "provider_options",
            "Cut iteration depth to improve turnaround latency.",
        );
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "size",
            Value::String("768x768".to_string()),
            "top_level",
            "Smaller dimensions reduce generation time.",
        );
    }
    if optimize_goal_present(goals, "retrieval") {
        push_optimize_recommendation(
            &mut recommendations,
            &mut seen,
            "style_strength",
            json!(0.35),
            "provider_options",
            "Bias toward structural clarity for stronger model retrieval signals.",
        );
    }

    if recommendations.is_empty() {
        recommendations.push(json_object(json!({
            "setting_name": "note",
            "setting_value": "No actionable recommendations found.",
            "setting_target": "comment",
            "rationale": "Goals did not map to mutable generation settings.",
        })));
    }

    let phase = round
        .map(|(idx, total)| format!("round {idx}/{total}"))
        .unwrap_or_else(|| "review".to_string());
    let analysis_excerpt = format!(
        "Optimize {phase}: baseline {provider}:{model} size={size} cost={cost} latency={latency}.",
    );

    (analysis_excerpt, recommendations)
}

fn format_optimize_recommendation(rec: &Map<String, Value>) -> String {
    let setting_name = rec
        .get("setting_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let setting_target = rec
        .get("setting_target")
        .and_then(Value::as_str)
        .unwrap_or("provider_options")
        .to_string();
    let setting_value = rec
        .get("setting_value")
        .map(|value| match value {
            Value::String(text) => text.clone(),
            Value::Null => "null".to_string(),
            _ => value.to_string(),
        })
        .unwrap_or_default();

    if setting_target == "comment" {
        return setting_value;
    }
    if setting_target == "request" || setting_target == "top_level" {
        return format!("{setting_name}={setting_value}");
    }
    format!("provider_options.{setting_name}={setting_value}")
}

fn apply_optimize_recommendations(
    settings: &mut Map<String, Value>,
    recommendations: &[Map<String, Value>],
) -> (Vec<String>, Vec<String>) {
    let mut applied: Vec<String> = Vec::new();
    let mut skipped: Vec<String> = Vec::new();

    for rec in recommendations {
        let Some(setting_name) = rec
            .get("setting_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|row| !row.is_empty())
            .map(str::to_string)
        else {
            skipped.push("missing setting_name".to_string());
            continue;
        };
        let setting_target = rec
            .get("setting_target")
            .and_then(Value::as_str)
            .unwrap_or("provider_options")
            .to_ascii_lowercase();
        let setting_value = rec.get("setting_value").cloned().unwrap_or(Value::Null);
        let summary = format_optimize_recommendation(rec);

        if setting_target == "comment" {
            skipped.push(summary);
            continue;
        }

        if setting_target == "request" || setting_target == "top_level" {
            if settings.get(&setting_name) == Some(&setting_value) {
                skipped.push(summary);
                continue;
            }
            settings.insert(setting_name, setting_value);
            applied.push(summary);
            continue;
        }

        let provider_options = settings
            .entry("provider_options".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if !provider_options.is_object() {
            *provider_options = Value::Object(Map::new());
        }
        let provider_options = provider_options
            .as_object_mut()
            .expect("provider options object");
        if provider_options.get(&setting_name) == Some(&setting_value) {
            skipped.push(summary);
            continue;
        }
        provider_options.insert(setting_name, setting_value);
        applied.push(summary);
    }

    (applied, skipped)
}

fn ids_list(value: Option<&Value>) -> Vec<String> {
    value_as_string_list(value)
}

fn compact_timestamp() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

fn read_json_object(path: &Path) -> Option<Map<String, Value>> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.as_object().cloned()
}

fn read_json_value(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json_value(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let encoded = serde_json::to_string_pretty(value)?;
    fs::write(path, encoded)?;
    Ok(())
}

fn snapshot_sidecar_path(snapshot_path: &Path) -> PathBuf {
    let mut out = snapshot_path.to_path_buf();
    if let Some(stem) = snapshot_path.file_stem().and_then(|value| value.to_str()) {
        out.set_file_name(format!("{stem}.ctx.json"));
    } else {
        out.set_extension("ctx.json");
    }
    out
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct SnapshotImageHint {
    id: String,
    file: String,
    vision_desc: String,
}

fn snapshot_image_hints(snapshot_path: &Path) -> Vec<SnapshotImageHint> {
    let sidecar = snapshot_sidecar_path(snapshot_path);
    let payload = match read_json_object(&sidecar) {
        Some(payload) => payload,
        None => return Vec::new(),
    };
    let images = payload
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    for row in images {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let file = obj
            .get("file")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        let vision_desc = obj
            .get("vision_desc")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() && file.is_empty() && vision_desc.is_empty() {
            continue;
        }
        out.push(SnapshotImageHint {
            id,
            file,
            vision_desc,
        });
    }
    out
}

fn infer_canvas_context_text(path: &Path) -> String {
    let hints = snapshot_image_hints(path);
    let image_count = hints.len().max(1);
    let mut phrases: Vec<String> = hints
        .iter()
        .map(|hint| {
            if !hint.vision_desc.trim().is_empty() {
                hint.vision_desc.clone()
            } else {
                humanize_file_name(&hint.file)
            }
        })
        .filter(|item| !item.trim().is_empty())
        .collect();
    if phrases.is_empty() {
        phrases.push(describe_local_image(path, 48));
    }

    let haystack = phrases.join(" ").to_ascii_lowercase();
    let use_case = if contains_any(
        &haystack,
        &[
            "product",
            "listing",
            "marketplace",
            "catalog",
            "merch",
            "ecommerce",
        ],
    ) {
        "product listing / ecommerce"
    } else if contains_any(
        &haystack,
        &["ui", "ux", "dashboard", "wireframe", "prototype", "screen"],
    ) {
        "ui/ux prototyping"
    } else if contains_any(
        &haystack,
        &[
            "stream",
            "thumbnail",
            "social",
            "poster",
            "hero",
            "campaign",
        ],
    ) {
        "social/marketing creative"
    } else {
        "visual concept iteration"
    };

    let actions: Vec<(&str, &str)> = if image_count >= 3 {
        vec![
            (
                "Triforce",
                "distill three references into one centroid composition",
            ),
            (
                "Extract the Rule",
                "surface a shared principle across the triplet",
            ),
            ("Odd One Out", "identify which reference breaks the pattern"),
            ("Argue", "compare the strongest pairwise direction"),
            ("Variations", "branch quickly from current composition"),
        ]
    } else if image_count == 2 {
        vec![
            (
                "Bridge",
                "generate an aesthetic midpoint between both images",
            ),
            (
                "Swap DNA",
                "transfer style surface while preserving structure",
            ),
            ("Combine", "fuse both photos into one coherent scene"),
            ("Argue", "decide which direction should lead"),
            ("Variations", "expand the stronger direction"),
        ]
    } else {
        vec![
            ("Variations", "explore quick zero-prompt branches"),
            ("Recast", "take a lateral leap while keeping core identity"),
            ("Diagnose", "pinpoint the highest-impact correction"),
            ("Background: White", "prepare clean product-style output"),
            ("Annotate", "mark one targeted local edit"),
        ]
    };

    let subject_lines: Vec<String> = phrases
        .iter()
        .take(6)
        .map(|line| format!("- {}", clamp_text(line, 80)))
        .collect();
    let style_tags = infer_style_tags(&haystack, image_count);
    let style_lines: Vec<String> = style_tags
        .iter()
        .map(|tag| format!("- {}", clamp_text(tag, 40)))
        .collect();
    let action_lines: Vec<String> = actions
        .into_iter()
        .take(5)
        .map(|(action, why)| format!("- {action}: {why}"))
        .collect();

    let summary = if image_count == 1 {
        format!(
            "Single-image workspace focused on {}.",
            clamp_text(&phrases[0], 72)
        )
    } else {
        format!(
            "{image_count} images staged for synthesis and comparison across a shared visual language."
        )
    };

    [
        "CANVAS:".to_string(),
        summary,
        "".to_string(),
        "USE CASE (guess):".to_string(),
        use_case.to_string(),
        "".to_string(),
        "SUBJECTS:".to_string(),
        subject_lines.join("\n"),
        "".to_string(),
        "STYLE:".to_string(),
        style_lines.join("\n"),
        "".to_string(),
        "NEXT ACTIONS:".to_string(),
        action_lines.join("\n"),
    ]
    .join("\n")
}

fn infer_style_tags(haystack: &str, image_count: usize) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    if contains_any(haystack, &["portrait", "face", "person", "human"]) {
        tags.push("subject-centric".to_string());
    }
    if contains_any(haystack, &["interior", "room", "architecture", "space"]) {
        tags.push("spatial composition".to_string());
    }
    if contains_any(haystack, &["product", "object", "device", "packaging"]) {
        tags.push("product-forward".to_string());
    }
    if contains_any(haystack, &["dramatic", "cinematic", "noir"]) {
        tags.push("cinematic lighting".to_string());
    }
    if contains_any(haystack, &["minimal", "clean", "white", "neutral"]) {
        tags.push("minimal palette".to_string());
    }
    if image_count >= 2 {
        tags.push("multi-reference fusion".to_string());
    }
    if tags.is_empty() {
        tags.extend([
            "cohesive composition".to_string(),
            "readable focal hierarchy".to_string(),
            "production-ready polish".to_string(),
        ]);
    }
    tags.truncate(7);
    tags
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles
        .iter()
        .any(|needle| !needle.is_empty() && haystack.contains(needle))
}

fn clamp_text(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_string();
    }
    trimmed
        .chars()
        .take(max_chars.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn humanize_file_name(file: &str) -> String {
    let stem = Path::new(file)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file)
        .replace('_', " ")
        .replace('-', " ");
    let cleaned = stem
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "image".to_string()
    } else {
        cleaned
    }
}

fn normalize_realtime_model_name(raw: &str, default: &str) -> String {
    let model = raw.trim();
    if model.is_empty() {
        return default.to_string();
    }
    if model == "realtime-gpt" {
        "gpt-realtime".to_string()
    } else {
        model.to_string()
    }
}

fn canvas_context_realtime_model() -> String {
    let value = env::var("BROOD_CANVAS_CONTEXT_REALTIME_MODEL")
        .ok()
        .or_else(|| env::var("OPENAI_CANVAS_CONTEXT_REALTIME_MODEL").ok())
        .unwrap_or_else(|| "gpt-realtime-mini".to_string());
    normalize_realtime_model_name(&value, "gpt-realtime-mini")
}

fn intent_realtime_model(mother: bool) -> String {
    let keys: Vec<&str> = if mother {
        vec![
            "BROOD_MOTHER_INTENT_REALTIME_MODEL",
            "BROOD_INTENT_REALTIME_MODEL",
            "OPENAI_INTENT_REALTIME_MODEL",
        ]
    } else {
        vec![
            "BROOD_INTENT_REALTIME_MODEL",
            "OPENAI_INTENT_REALTIME_MODEL",
        ]
    };
    for key in keys {
        if let Ok(value) = env::var(key) {
            let normalized = normalize_realtime_model_name(
                &value,
                if mother {
                    "gpt-realtime"
                } else {
                    "gpt-realtime-mini"
                },
            );
            if !normalized.trim().is_empty() {
                return normalized;
            }
        }
    }
    if mother {
        "gpt-realtime".to_string()
    } else {
        "gpt-realtime-mini".to_string()
    }
}

fn extract_action_version_from_path(path: &Path) -> Option<i64> {
    let name = path.file_name()?.to_string_lossy().to_string();
    extract_action_version_from_text(&name)
}

fn extract_action_version_from_text(raw: &str) -> Option<i64> {
    for token in raw.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        if token.len() < 2 {
            continue;
        }
        let lowered = token.to_ascii_lowercase();
        if let Some(rest) = lowered.strip_prefix('a') {
            if !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit()) {
                if let Ok(value) = rest.parse::<i64>() {
                    return Some(value);
                }
            }
        }
    }
    None
}

const REALTIME_SOURCE: &str = "openai_realtime";
const REALTIME_BETA_HEADER_VALUE: &str = "realtime=v1";
const REALTIME_TIMEOUT_SECONDS: f64 = 42.0;
const REALTIME_MAX_PARTIAL_HZ_MS: u64 = 250;
const REALTIME_TRANSPORT_RETRY_MAX_DEFAULT: usize = 2;
const REALTIME_TRANSPORT_RETRY_BACKOFF_MS_DEFAULT: u64 = 350;
const REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_DEFAULT: usize = 4;
const REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_MAX: usize = 8;

fn unix_epoch_millis() -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    i64::try_from(now.as_millis()).unwrap_or(i64::MAX)
}

#[derive(Clone, Copy, Debug)]
enum RealtimeSessionKind {
    CanvasContext,
    IntentIcons { mother: bool },
}

impl RealtimeSessionKind {
    fn event_type(self) -> &'static str {
        match self {
            Self::CanvasContext => "canvas_context",
            Self::IntentIcons { .. } => "intent_icons",
        }
    }

    fn failed_event_type(self) -> &'static str {
        match self {
            Self::CanvasContext => "canvas_context_failed",
            Self::IntentIcons { .. } => "intent_icons_failed",
        }
    }

    fn instruction(self) -> String {
        match self {
            Self::CanvasContext => canvas_context_realtime_instruction().to_string(),
            Self::IntentIcons { mother } => intent_icons_instruction(mother),
        }
    }

    fn per_request_input_text(self) -> Option<&'static str> {
        match self {
            Self::CanvasContext => None,
            Self::IntentIcons { .. } => Some(
                "For image_descriptions labels, use concise computer-vision caption style and keep each label <= 40 characters. Prefer the most specific identifiable subject. If a person/character is confidently recognizable, use the proper name. Avoid generic role labels like 'basketball player' when identity is recognizable. If SOURCE_IMAGE_REFERENCE inputs are present, prioritize them for identity/detail over low-res canvas cues. Do not infer sports team/franchise from jersey colors alone; only mention a team when text/logo is clearly readable. Do not mirror generic vision_desc hints from CONTEXT_ENVELOPE_JSON. Return strict JSON only.",
            ),
        }
    }

    fn temperature(self) -> f64 {
        match self {
            Self::CanvasContext => 0.6,
            Self::IntentIcons { .. } => 0.6,
        }
    }

    fn max_output_tokens(self) -> u64 {
        match self {
            Self::CanvasContext => 520,
            Self::IntentIcons { .. } => 2200,
        }
    }

    fn timeout_message(self) -> &'static str {
        match self {
            Self::CanvasContext => "Realtime canvas context timed out.",
            Self::IntentIcons { .. } => "Realtime intent inference timed out.",
        }
    }

    fn empty_response_message(self, response: &Value) -> String {
        let suffix = summarize_realtime_response(response);
        match self {
            Self::CanvasContext => format!("Empty realtime canvas context response.{suffix}"),
            Self::IntentIcons { .. } => {
                format!("Empty realtime intent inference response.{suffix}")
            }
        }
    }

    fn disabled_message(self) -> &'static str {
        match self {
            Self::CanvasContext => {
                "Realtime canvas context is disabled (BROOD_CANVAS_CONTEXT_REALTIME_DISABLED=1)."
            }
            Self::IntentIcons { .. } => {
                "Realtime intent inference is disabled (BROOD_INTENT_REALTIME_DISABLED=1)."
            }
        }
    }

    fn thread_name(self) -> &'static str {
        match self {
            Self::CanvasContext => "brood-aov-realtime",
            Self::IntentIcons { mother: true } => "brood-intent-realtime-mother",
            Self::IntentIcons { mother: false } => "brood-intent-realtime",
        }
    }

    fn select_job(self, jobs: &[RealtimeSnapshotJob]) -> Option<RealtimeSnapshotJob> {
        if jobs.is_empty() {
            return None;
        }
        match self {
            Self::IntentIcons { .. } => jobs
                .iter()
                .rfind(|job| is_mother_intent_snapshot_path(&job.image_path))
                .cloned()
                .or_else(|| jobs.last().cloned()),
            Self::CanvasContext => jobs.last().cloned(),
        }
    }
}

#[derive(Debug, Clone)]
struct RealtimeSnapshotJob {
    image_path: String,
    submitted_at_ms: i64,
}

enum RealtimeCommand {
    Snapshot(RealtimeSnapshotJob),
    Stop,
}

struct RealtimeSnapshotSession {
    events: EventWriter,
    model: String,
    disabled: bool,
    kind: RealtimeSessionKind,
    sender: Option<mpsc::Sender<RealtimeCommand>>,
    handle: Option<thread::JoinHandle<()>>,
    fatal_error: Arc<Mutex<Option<String>>>,
    stop_flag: Option<Arc<AtomicBool>>,
}

impl RealtimeSnapshotSession {
    fn new(events: EventWriter, model: String, kind: RealtimeSessionKind, disabled: bool) -> Self {
        Self {
            events,
            model,
            disabled,
            kind,
            sender: None,
            handle: None,
            fatal_error: Arc::new(Mutex::new(None)),
            stop_flag: None,
        }
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn start(&mut self) -> (bool, Option<String>) {
        if self.disabled {
            return (false, Some(self.kind.disabled_message().to_string()));
        }
        let Some(api_key) = openai_api_key() else {
            return (
                false,
                Some("Missing OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP).".to_string()),
            );
        };

        self.cleanup_finished_worker();
        if self.worker_alive() {
            return (true, None);
        }

        if let Ok(mut fatal) = self.fatal_error.lock() {
            *fatal = None;
        }

        let (tx, rx) = mpsc::channel();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker = RealtimeWorker {
            events: self.events.clone(),
            model: self.model.clone(),
            kind: self.kind,
            api_key,
            fatal_error: Arc::clone(&self.fatal_error),
            stop_flag: Arc::clone(&stop_flag),
        };
        let handle = match thread::Builder::new()
            .name(self.kind.thread_name().to_string())
            .spawn(move || worker.run(rx))
        {
            Ok(handle) => handle,
            Err(err) => return (false, Some(format!("Realtime thread spawn failed: {err}"))),
        };

        self.sender = Some(tx);
        self.handle = Some(handle);
        self.stop_flag = Some(stop_flag);
        (true, None)
    }

    fn stop(&mut self) {
        if let Some(flag) = self.stop_flag.as_ref() {
            flag.store(true, Ordering::SeqCst);
        }
        if let Some(tx) = self.sender.take() {
            let _ = tx.send(RealtimeCommand::Stop);
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.stop_flag = None;
    }

    fn submit_snapshot(&mut self, snapshot_path: &Path) -> (bool, Option<String>) {
        if self.disabled {
            return (false, Some(self.kind.disabled_message().to_string()));
        }
        if !snapshot_path.exists() {
            return (
                false,
                Some(format!("Snapshot not found: {}", snapshot_path.display())),
            );
        }
        if let Ok(fatal) = self.fatal_error.lock() {
            if let Some(message) = fatal.clone() {
                return (false, Some(message));
            }
        }

        self.cleanup_finished_worker();
        if !self.worker_alive() {
            let (ok, err) = self.start();
            if !ok {
                return (ok, err);
            }
            if let Ok(fatal) = self.fatal_error.lock() {
                if let Some(message) = fatal.clone() {
                    return (false, Some(message));
                }
            }
        }

        let Some(tx) = self.sender.as_ref() else {
            return (
                false,
                Some("Realtime session channel unavailable.".to_string()),
            );
        };
        let job = RealtimeSnapshotJob {
            image_path: snapshot_path.to_string_lossy().to_string(),
            submitted_at_ms: unix_epoch_millis(),
        };
        if tx.send(RealtimeCommand::Snapshot(job)).is_err() {
            return (false, Some("Realtime session is not running.".to_string()));
        }
        (true, None)
    }

    fn worker_alive(&self) -> bool {
        self.handle
            .as_ref()
            .map(|handle| !handle.is_finished())
            .unwrap_or(false)
    }

    fn cleanup_finished_worker(&mut self) {
        let finished = self
            .handle
            .as_ref()
            .map(|handle| handle.is_finished())
            .unwrap_or(false);
        if !finished {
            return;
        }
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        self.sender = None;
        self.stop_flag = None;
    }
}

struct CanvasContextRealtimeSession {
    inner: RealtimeSnapshotSession,
}

impl CanvasContextRealtimeSession {
    fn new(events: EventWriter) -> Self {
        Self {
            inner: RealtimeSnapshotSession::new(
                events,
                canvas_context_realtime_model(),
                RealtimeSessionKind::CanvasContext,
                env::var("BROOD_CANVAS_CONTEXT_REALTIME_DISABLED")
                    .map(|value| value.trim() == "1")
                    .unwrap_or(false),
            ),
        }
    }

    fn model(&self) -> &str {
        self.inner.model()
    }

    fn start(&mut self) -> (bool, Option<String>) {
        self.inner.start()
    }

    fn stop(&mut self) {
        self.inner.stop();
    }

    fn submit_snapshot(&mut self, snapshot_path: &Path) -> (bool, Option<String>) {
        self.inner.submit_snapshot(snapshot_path)
    }
}

struct IntentIconsRealtimeSession {
    inner: RealtimeSnapshotSession,
}

impl IntentIconsRealtimeSession {
    fn new(events: EventWriter, mother: bool) -> Self {
        Self {
            inner: RealtimeSnapshotSession::new(
                events,
                intent_realtime_model(mother),
                RealtimeSessionKind::IntentIcons { mother },
                env::var("BROOD_INTENT_REALTIME_DISABLED")
                    .map(|value| value.trim() == "1")
                    .unwrap_or(false),
            ),
        }
    }

    fn model(&self) -> &str {
        self.inner.model()
    }

    fn start(&mut self) -> (bool, Option<String>) {
        self.inner.start()
    }

    fn stop(&mut self) {
        self.inner.stop();
    }

    fn submit_snapshot(&mut self, snapshot_path: &Path) -> (bool, Option<String>) {
        self.inner.submit_snapshot(snapshot_path)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RealtimeJobErrorKind {
    Transport,
    Terminal,
}

#[derive(Debug)]
struct RealtimeJobError {
    kind: RealtimeJobErrorKind,
    message: String,
}

impl RealtimeJobError {
    fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: RealtimeJobErrorKind::Transport,
            message: message.into(),
        }
    }

    fn terminal(message: impl Into<String>) -> Self {
        Self {
            kind: RealtimeJobErrorKind::Terminal,
            message: message.into(),
        }
    }

    fn from_anyhow(err: anyhow::Error) -> Self {
        let message = error_chain_message(&err);
        if is_anyhow_realtime_transport_error(&err) {
            Self::transport(message)
        } else {
            Self::terminal(message)
        }
    }

    fn from_tungstenite(prefix: &str, err: tungstenite::Error) -> Self {
        let message = format!("{prefix}: {err}");
        if is_tungstenite_transport_error(&err) {
            Self::transport(message)
        } else {
            Self::terminal(message)
        }
    }

    fn is_transport(&self) -> bool {
        self.kind == RealtimeJobErrorKind::Transport
    }
}

impl std::fmt::Display for RealtimeJobError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

struct RealtimeWorker {
    events: EventWriter,
    model: String,
    kind: RealtimeSessionKind,
    api_key: String,
    fatal_error: Arc<Mutex<Option<String>>>,
    stop_flag: Arc<AtomicBool>,
}

impl RealtimeWorker {
    fn run(self, rx: mpsc::Receiver<RealtimeCommand>) {
        if let Err(err) = self.run_inner(rx) {
            self.fail_fatal(None, format!("Realtime connection failed: {err}"));
        }
    }

    fn open_session(&self) -> Result<WebSocket<MaybeTlsStream<TcpStream>>> {
        let mut ws = open_realtime_websocket(&self.model, &self.api_key)?;
        let session_update = json!({
            "type": "session.update",
            "session": {
                "instructions": self.kind.instruction(),
                "modalities": ["text"],
                "temperature": self.kind.temperature(),
                "max_response_output_tokens": self.kind.max_output_tokens(),
            },
        });
        websocket_send_json(&mut ws, &session_update)?;
        Ok(ws)
    }

    fn run_inner(&self, rx: mpsc::Receiver<RealtimeCommand>) -> Result<()> {
        let max_retries = realtime_transport_retry_limit();
        let mut ws = self.open_session()?;

        while !self.stop_flag.load(Ordering::SeqCst) {
            let command = match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(command) => command,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };

            let mut jobs: Vec<RealtimeSnapshotJob> = Vec::new();
            match command {
                RealtimeCommand::Snapshot(job) => jobs.push(job),
                RealtimeCommand::Stop => break,
            }

            while let Ok(next) = rx.try_recv() {
                match next {
                    RealtimeCommand::Snapshot(job) => jobs.push(job),
                    RealtimeCommand::Stop => {
                        self.stop_flag.store(true, Ordering::SeqCst);
                        break;
                    }
                }
            }
            if self.stop_flag.load(Ordering::SeqCst) {
                break;
            }

            let Some(job) = self.kind.select_job(&jobs) else {
                continue;
            };
            let mut attempt: usize = 0;
            loop {
                match self.run_job(&mut ws, &job) {
                    Ok(()) => break,
                    Err(err) => {
                        if !err.is_transport()
                            || attempt >= max_retries
                            || self.stop_flag.load(Ordering::SeqCst)
                        {
                            self.fail_fatal(Some(&job.image_path), err.to_string());
                            return Ok(());
                        }
                        attempt += 1;
                        let _ = ws.close(None);
                        let backoff = realtime_transport_retry_backoff(attempt);
                        if !backoff.is_zero() {
                            thread::sleep(backoff);
                        }
                        let reconnect = self.open_session().with_context(|| {
                            format!(
                                "failed to reconnect realtime session after transient transport error (attempt {attempt}/{max_retries})"
                            )
                        });
                        match reconnect {
                            Ok(new_ws) => ws = new_ws,
                            Err(reconnect_err) => {
                                if attempt < max_retries
                                    && is_anyhow_realtime_transport_error(&reconnect_err)
                                {
                                    continue;
                                }
                                self.fail_fatal(Some(&job.image_path), reconnect_err.to_string());
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }

        let _ = ws.close(None);
        Ok(())
    }

    fn run_job(
        &self,
        ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
        job: &RealtimeSnapshotJob,
    ) -> std::result::Result<(), RealtimeJobError> {
        let _submitted_at_ms = job.submitted_at_ms;
        let image_path = PathBuf::from(&job.image_path);
        let data_url = read_image_as_data_url(&image_path).ok_or_else(|| {
            RealtimeJobError::terminal("failed to read image for realtime request")
        })?;
        let mut content: Vec<Value> = Vec::new();
        if let Some(inline_instruction) = self.kind.per_request_input_text() {
            content.push(json!({"type": "input_text", "text": inline_instruction}));
        }
        if let Some(context_text) = read_canvas_context_envelope(&image_path) {
            content.push(json!({"type": "input_text", "text": context_text}));
        }
        let context_refs = read_canvas_context_image_references(&image_path, 12);
        if !context_refs.is_empty() {
            let image_id_order = context_refs
                .iter()
                .map(|row| row.id.clone())
                .collect::<Vec<String>>()
                .join(", ");
            content.push(json!({
                "type": "input_text",
                "text": format!("IMAGE_ID_ORDER: {image_id_order}"),
            }));
            content.push(json!({
                "type": "input_text",
                "text": "For image_descriptions, emit exactly one row per IMAGE_ID_ORDER id, preserve that order, and never swap labels across ids.",
            }));
        }
        let reference_limit = match self.kind {
            RealtimeSessionKind::IntentIcons { .. } => intent_realtime_reference_image_limit(),
            RealtimeSessionKind::CanvasContext => 2,
        };
        for image_ref in context_refs.iter().take(reference_limit) {
            if let Some(reference_data_url) = prepare_vision_image_data_url(&image_ref.path, 1024) {
                content.push(json!({
                    "type": "input_text",
                    "text": format!("SOURCE_IMAGE_REFERENCE {} (high-res):", image_ref.id),
                }));
                content.push(json!({
                    "type": "input_image",
                    "image_url": reference_data_url,
                }));
            }
        }
        content.push(json!({"type": "input_image", "image_url": data_url}));
        let request = json!({
            "type": "response.create",
            "response": {
                "conversation": "none",
                "modalities": ["text"],
                "input": [{
                    "type": "message",
                    "role": "user",
                    "content": content,
                }],
                "max_output_tokens": self.kind.max_output_tokens(),
            },
        });
        websocket_send_json(ws, &request).map_err(RealtimeJobError::from_anyhow)?;

        let mut buffer = String::new();
        let mut response_id: Option<String> = None;
        let mut last_emit = Instant::now();
        let started = Instant::now();

        while !self.stop_flag.load(Ordering::SeqCst) {
            if started.elapsed().as_secs_f64() > REALTIME_TIMEOUT_SECONDS {
                return Err(RealtimeJobError::terminal(self.kind.timeout_message()));
            }

            let message = match ws.read() {
                Ok(message) => message,
                Err(tungstenite::Error::Io(err))
                    if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
                {
                    continue;
                }
                Err(err) => {
                    return Err(RealtimeJobError::from_tungstenite(
                        "realtime read failed",
                        err,
                    ))
                }
            };

            let raw = match message {
                WsMessage::Text(text) => text.to_string(),
                WsMessage::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
                WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
                WsMessage::Close(_) => {
                    return Err(RealtimeJobError::transport("realtime socket closed"))
                }
                _ => continue,
            };

            let parsed: Value = match serde_json::from_str(&raw) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let event_type = parsed
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            if event_type == "error" {
                return Err(RealtimeJobError::terminal(format_realtime_error(&parsed)));
            }

            if event_type == "response.created" {
                if let Some(id) = parsed
                    .get("response")
                    .and_then(Value::as_object)
                    .and_then(|row| row.get("id"))
                    .and_then(Value::as_str)
                {
                    response_id = Some(id.to_string());
                }
                continue;
            }

            if event_type == "response.output_text.delta" {
                let delta = parsed
                    .get("delta")
                    .and_then(Value::as_str)
                    .or_else(|| parsed.get("text").and_then(Value::as_str))
                    .unwrap_or_default();
                if !delta.is_empty() {
                    buffer = append_stream_delta(&buffer, delta);
                }
                if !buffer.trim().is_empty()
                    && last_emit.elapsed() >= Duration::from_millis(REALTIME_MAX_PARTIAL_HZ_MS)
                {
                    last_emit = Instant::now();
                    self.emit_stream_payload(&job.image_path, &buffer, true, None);
                }
                continue;
            }

            if event_type == "response.output_text.done" {
                if let Some(text) = parsed
                    .get("text")
                    .and_then(Value::as_str)
                    .or_else(|| parsed.get("output_text").and_then(Value::as_str))
                {
                    if !text.is_empty() {
                        buffer = merge_stream_text(&buffer, text);
                    }
                }
                continue;
            }

            if event_type == "response.done" {
                let response = parsed.get("response").cloned().unwrap_or(Value::Null);
                if let Some(expected) = response_id.as_ref() {
                    let actual = response
                        .as_object()
                        .and_then(|row| row.get("id"))
                        .and_then(Value::as_str);
                    if actual.is_some() && actual != Some(expected.as_str()) {
                        continue;
                    }
                }
                let (cleaned, response_meta) = resolve_streamed_response_text(&buffer, &response);
                if cleaned.trim().is_empty() {
                    return Err(RealtimeJobError::terminal(
                        self.kind.empty_response_message(&response),
                    ));
                }
                self.emit_stream_payload(&job.image_path, &cleaned, false, Some(response_meta));
                return Ok(());
            }
        }

        Ok(())
    }

    fn fail_fatal(&self, image_path: Option<&str>, message: String) {
        if let Ok(mut fatal) = self.fatal_error.lock() {
            *fatal = Some(if message.trim().is_empty() {
                "Unknown realtime error.".to_string()
            } else {
                message.clone()
            });
        }
        self.emit_failed_payload(image_path, &message, true, None);
    }

    fn emit_stream_payload(
        &self,
        image_path: &str,
        text: &str,
        partial: bool,
        response_meta: Option<Map<String, Value>>,
    ) {
        let mut payload = Map::new();
        payload.insert(
            "image_path".to_string(),
            Value::String(image_path.to_string()),
        );
        payload.insert("text".to_string(), Value::String(text.to_string()));
        payload.insert(
            "source".to_string(),
            Value::String(REALTIME_SOURCE.to_string()),
        );
        payload.insert("model".to_string(), Value::String(self.model.clone()));
        if partial {
            payload.insert("partial".to_string(), Value::Bool(true));
        }
        if let RealtimeSessionKind::IntentIcons { .. } = self.kind {
            for (key, value) in intent_snapshot_metadata(image_path) {
                payload.insert(key, value);
            }
        }
        if let Some(meta) = response_meta {
            for (key, value) in meta {
                payload.insert(key, value);
            }
        }
        let _ = self.events.emit(self.kind.event_type(), payload);
    }

    fn emit_failed_payload(
        &self,
        image_path: Option<&str>,
        error: &str,
        fatal: bool,
        extra: Option<Map<String, Value>>,
    ) {
        let mut payload = Map::new();
        payload.insert(
            "image_path".to_string(),
            image_path
                .map(|value| Value::String(value.to_string()))
                .unwrap_or(Value::Null),
        );
        payload.insert("error".to_string(), Value::String(error.to_string()));
        payload.insert(
            "source".to_string(),
            Value::String(REALTIME_SOURCE.to_string()),
        );
        payload.insert("model".to_string(), Value::String(self.model.clone()));
        if let RealtimeSessionKind::IntentIcons { .. } = self.kind {
            if let Some(path) = image_path {
                for (key, value) in intent_snapshot_metadata(path) {
                    payload.insert(key, value);
                }
            }
        }
        if fatal {
            payload.insert("fatal".to_string(), Value::Bool(true));
        }
        if let Some(extra_meta) = extra {
            for (key, value) in extra_meta {
                payload.insert(key, value);
            }
        }
        let _ = self.events.emit(self.kind.failed_event_type(), payload);
    }
}

fn open_realtime_websocket(
    model: &str,
    api_key: &str,
) -> Result<WebSocket<MaybeTlsStream<TcpStream>>> {
    let request = build_realtime_websocket_request(model, api_key)?;
    let (mut ws, _) = websocket_connect(request).context("failed to connect realtime websocket")?;
    set_realtime_socket_read_timeout(&mut ws, Some(Duration::from_millis(500)));
    Ok(ws)
}

fn realtime_transport_retry_limit() -> usize {
    env::var("BROOD_REALTIME_TRANSPORT_RETRIES")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .map(|value| value.min(6))
        .unwrap_or(REALTIME_TRANSPORT_RETRY_MAX_DEFAULT)
}

fn realtime_transport_retry_backoff(attempt: usize) -> Duration {
    let base_ms = env::var("BROOD_REALTIME_TRANSPORT_RETRY_BACKOFF_MS")
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .map(|value| value.clamp(50, 5000))
        .unwrap_or(REALTIME_TRANSPORT_RETRY_BACKOFF_MS_DEFAULT);
    let multiplier = u64::try_from(attempt.max(1)).unwrap_or(u64::MAX);
    Duration::from_millis(base_ms.saturating_mul(multiplier))
}

fn intent_realtime_reference_image_limit() -> usize {
    env::var("BROOD_INTENT_REALTIME_REFERENCE_LIMIT")
        .ok()
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .map(|value| value.clamp(1, REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_MAX))
        .unwrap_or(REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_DEFAULT)
}

fn is_anyhow_realtime_transport_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<tungstenite::Error>()
            .map(is_tungstenite_transport_error)
            .unwrap_or(false)
            || cause
                .downcast_ref::<io::Error>()
                .map(|io_err| is_transport_io_error_kind(io_err.kind()))
                .unwrap_or(false)
    })
}

fn is_tungstenite_transport_error(err: &tungstenite::Error) -> bool {
    match err {
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => true,
        tungstenite::Error::Io(io_err) => is_transport_io_error_kind(io_err.kind()),
        tungstenite::Error::Tls(_) => true,
        _ => false,
    }
}

fn is_transport_io_error_kind(kind: io::ErrorKind) -> bool {
    matches!(
        kind,
        io::ErrorKind::WouldBlock
            | io::ErrorKind::TimedOut
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::ConnectionAborted
            | io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::NotConnected
    )
}

fn error_chain_message(err: &anyhow::Error) -> String {
    err.chain()
        .map(|entry| entry.to_string())
        .filter(|entry| !entry.trim().is_empty())
        .collect::<Vec<String>>()
        .join(": ")
}

fn build_realtime_websocket_request(model: &str, api_key: &str) -> Result<Request<()>> {
    let ws_url = openai_realtime_ws_url(model);
    let auth_header = format!("Bearer {api_key}");
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .context("invalid realtime websocket request")?;
    request.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&auth_header).context("invalid realtime auth header")?,
    );
    request.headers_mut().insert(
        "OpenAI-Beta",
        HeaderValue::from_static(REALTIME_BETA_HEADER_VALUE),
    );
    Ok(request)
}

fn websocket_send_json(ws: &mut WebSocket<MaybeTlsStream<TcpStream>>, value: &Value) -> Result<()> {
    let raw = serde_json::to_string(value).context("failed to serialize realtime payload")?;
    ws.send(WsMessage::Text(raw.into()))
        .context("failed to send realtime payload")
}

fn set_realtime_socket_read_timeout(
    ws: &mut WebSocket<MaybeTlsStream<TcpStream>>,
    timeout: Option<Duration>,
) {
    match ws.get_mut() {
        MaybeTlsStream::Plain(stream) => {
            let _ = stream.set_read_timeout(timeout);
        }
        MaybeTlsStream::Rustls(stream) => {
            let _ = stream.get_mut().set_read_timeout(timeout);
        }
        _ => {}
    }
}

fn openai_realtime_ws_url(model: &str) -> String {
    let base = openai_api_base();
    if let Ok(mut url) = reqwest::Url::parse(&base) {
        let scheme = if url.scheme() == "https" {
            "wss".to_string()
        } else if url.scheme() == "http" {
            "ws".to_string()
        } else {
            url.scheme().to_string()
        };
        let _ = url.set_scheme(&scheme);
        let mut path = url.path().trim_end_matches('/').to_string();
        if path.is_empty() {
            path = "/v1".to_string();
        }
        url.set_path(&format!("{path}/realtime"));
        url.query_pairs_mut()
            .clear()
            .append_pair("model", model.trim());
        return url.to_string();
    }
    format!("wss://api.openai.com/v1/realtime?model={}", model.trim())
}

fn read_image_as_data_url(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let encoded = BASE64.encode(bytes);
    Some(format!(
        "data:{};base64,{}",
        guess_image_mime(path),
        encoded
    ))
}

fn read_canvas_context_envelope(image_path: &Path) -> Option<String> {
    let sidecar = image_path.with_extension("ctx.json");
    if !sidecar.exists() {
        return None;
    }
    let raw = fs::read_to_string(sidecar).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let truncated = truncate_chars(trimmed, 12_000, 11_800);
    Some(format!("CONTEXT_ENVELOPE_JSON:\n{truncated}"))
}

#[derive(Debug, Clone)]
struct ContextImageReference {
    id: String,
    path: PathBuf,
}

fn read_canvas_context_image_references(
    snapshot_path: &Path,
    limit: usize,
) -> Vec<ContextImageReference> {
    let max_refs = limit.max(1);
    let sidecar = snapshot_path.with_extension("ctx.json");
    if !sidecar.exists() {
        return Vec::new();
    }

    let raw = match fs::read_to_string(&sidecar) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let parsed = match serde_json::from_str::<Value>(&raw) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };
    let rows = parsed
        .as_object()
        .and_then(|obj| obj.get("images"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let snapshot_abs =
        fs::canonicalize(snapshot_path).unwrap_or_else(|_| snapshot_path.to_path_buf());
    let mut out: Vec<ContextImageReference> = Vec::new();
    let mut seen: HashSet<PathBuf> = HashSet::new();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .or_else(|| {
                obj.get("file")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "image".to_string());
        let path_text = obj
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_default();
        if path_text.is_empty() {
            continue;
        }

        let mut path = PathBuf::from(path_text);
        if path.is_relative() {
            if let Some(parent) = sidecar.parent() {
                path = parent.join(path);
            }
        }
        if !path.exists() {
            continue;
        }
        let path_abs = fs::canonicalize(&path).unwrap_or(path.clone());
        if path_abs == snapshot_abs {
            continue;
        }
        if !seen.insert(path_abs.clone()) {
            continue;
        }
        out.push(ContextImageReference { id, path: path_abs });
    }
    if out.len() > max_refs {
        out.truncate(max_refs);
    }
    out
}

fn truncate_chars(text: &str, max_len: usize, keep_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let head = text.chars().take(keep_len).collect::<String>();
    format!("{}...", head.trim_end())
}

fn is_mother_intent_snapshot_path(image_path: &str) -> bool {
    Path::new(image_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase().starts_with("mother-intent-"))
        .unwrap_or(false)
}

fn intent_snapshot_metadata(image_path: &str) -> Map<String, Value> {
    let mut out = Map::new();
    let path_text = image_path.trim();
    if path_text.is_empty() {
        return out;
    }
    let path = PathBuf::from(path_text);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if name.starts_with("mother-intent-") {
        out.insert(
            "intent_scope".to_string(),
            Value::String("mother".to_string()),
        );
    } else if name.starts_with("intent-ambient-") {
        out.insert(
            "intent_scope".to_string(),
            Value::String("ambient".to_string()),
        );
    }

    let mut action_version = extract_action_version_from_path(&path);
    let mut frame_id: Option<String> = None;

    let sidecar = path.with_extension("ctx.json");
    if sidecar.exists() {
        if let Ok(raw) = fs::read_to_string(sidecar) {
            if let Ok(parsed) = serde_json::from_str::<Value>(&raw) {
                if let Some(value) = parsed
                    .as_object()
                    .and_then(|row| row.get("frame_id"))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    frame_id = Some(value.to_string());
                    action_version = extract_action_version_from_text(value).or(action_version);
                }
            }
        }
    }

    if let Some(frame) = frame_id {
        out.insert("frame_id".to_string(), Value::String(frame));
    }
    if let Some(version) = action_version {
        out.insert("action_version".to_string(), Value::Number(version.into()));
    }
    out
}

fn format_realtime_error(event: &Value) -> String {
    let Some(error) = event.get("error").and_then(Value::as_object) else {
        return "Realtime API error.".to_string();
    };
    let message = error
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("Realtime API error.");
    let kind = error
        .get("type")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let code = error
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default();
    let prefix = [kind, code]
        .iter()
        .filter(|value| !value.is_empty())
        .cloned()
        .collect::<Vec<&str>>()
        .join(" ");
    if prefix.is_empty() {
        message.to_string()
    } else {
        format!("{prefix}: {message}")
    }
}

fn merge_stream_text(left: &str, right: &str) -> String {
    if right.is_empty() {
        return left.to_string();
    }
    if left.is_empty() {
        return right.to_string();
    }
    if right.starts_with(left) {
        return right.to_string();
    }
    let left_chars: Vec<char> = left.chars().collect();
    let right_chars: Vec<char> = right.chars().collect();
    let max_overlap = left_chars.len().min(right_chars.len());
    for size in (1..=max_overlap).rev() {
        if left_chars[left_chars.len() - size..] == right_chars[..size] {
            if size == right_chars.len() {
                break;
            }
            let suffix = right_chars[size..].iter().collect::<String>();
            return format!("{left}{suffix}");
        }
    }
    format!("{left}{right}")
}

fn append_stream_delta(left: &str, right: &str) -> String {
    if right.is_empty() {
        left.to_string()
    } else {
        format!("{left}{right}")
    }
}

fn response_status_reason(response: &Map<String, Value>) -> Option<String> {
    let details = response.get("status_details")?;
    if let Some(object) = details.as_object() {
        for key in ["reason", "type", "code", "message"] {
            if let Some(value) = object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Some(value.to_string());
            }
        }
        return serde_json::to_string(details).ok();
    }
    details
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn response_looks_truncated(status: Option<&str>, reason: Option<&str>, text: &str) -> bool {
    let status = status.unwrap_or_default().trim().to_ascii_lowercase();
    let reason = reason.unwrap_or_default().trim().to_ascii_lowercase();
    if status == "incomplete" || status == "truncated" {
        return true;
    }
    if reason.contains("max_output_tokens") || reason.contains("max_output") {
        return true;
    }
    let body = text.trim();
    if body.is_empty() {
        return false;
    }
    (body.starts_with('{') && !body.ends_with('}'))
        || (body.starts_with('[') && !body.ends_with(']'))
}

fn resolve_streamed_response_text(buffer: &str, response: &Value) -> (String, Map<String, Value>) {
    let buffered = buffer.trim().to_string();
    let extracted = extract_realtime_output_text(response).trim().to_string();
    let cleaned = if !buffered.is_empty() && !extracted.is_empty() {
        merge_stream_text(&buffered, &extracted).trim().to_string()
    } else if !extracted.is_empty() {
        extracted
    } else {
        buffered
    };

    let mut meta = Map::new();
    if let Some(object) = response.as_object() {
        if let Some(value) = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            meta.insert("response_id".to_string(), Value::String(value.to_string()));
        }
        let status = object
            .get("status")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(value) = status.as_ref() {
            meta.insert("response_status".to_string(), Value::String(value.clone()));
        }
        let reason = response_status_reason(object);
        if let Some(value) = reason.as_ref() {
            meta.insert(
                "response_status_reason".to_string(),
                Value::String(value.clone()),
            );
        }
        if response_looks_truncated(status.as_deref(), reason.as_deref(), &cleaned) {
            meta.insert("response_truncated".to_string(), Value::Bool(true));
        }
    }
    (cleaned, meta)
}

fn extract_realtime_output_text(response: &Value) -> String {
    if let Some(text) = response
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return text.to_string();
    }

    let mut parts: Vec<String> = Vec::new();
    let rows = response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        if let Some(text) = obj
            .get("text")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            let kind = obj.get("type").and_then(Value::as_str).unwrap_or_default();
            if kind == "output_text" || kind == "text" {
                parts.push(text.to_string());
            }
        }
        if let Some(refusal) = obj
            .get("refusal")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            parts.push(refusal.to_string());
        }
        let content = obj
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for chunk in content {
            let Some(chunk_obj) = chunk.as_object() else {
                continue;
            };
            let kind = chunk_obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if matches!(kind, "output_text" | "text") {
                if let Some(text) = chunk_obj
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                {
                    parts.push(text.to_string());
                }
            }
            if let Some(refusal) = chunk_obj
                .get("refusal")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                parts.push(refusal.to_string());
            }
        }
    }

    let joined = parts.join("\n").trim().to_string();
    if !joined.is_empty() {
        joined
    } else {
        extract_openai_output_text(response)
    }
}

fn summarize_realtime_response(response: &Value) -> String {
    let Some(object) = response.as_object() else {
        return String::new();
    };
    let status = object
        .get("status")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let response_id = object
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let details = object.get("status_details").cloned();
    let out_count = object
        .get("output")
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);

    let mut bits: Vec<String> = Vec::new();
    if let Some(value) = status {
        bits.push(format!("status={value}"));
    }
    if let Some(value) = response_id {
        bits.push(format!("id={value}"));
    }
    if let Some(value) = details {
        bits.push(format!("details={value}"));
    }
    bits.push(format!("output_items={out_count}"));
    if bits.is_empty() {
        String::new()
    } else {
        format!(" ({})", bits.join(", "))
    }
}

fn canvas_context_realtime_instruction() -> &'static str {
    "You are Brood's always-on background vision.\nAnalyze the attached CANVAS SNAPSHOT (it may contain multiple photos arranged in a grid).\nYou may also receive a CONTEXT ENVELOPE (JSON) describing the current UI state, available actions,\nand recent timeline. Use it to ground NEXT ACTIONS and avoid recommending unavailable abilities.\nOutput compact, machine-readable notes we can use for future action recommendations.\n\nFormat (keep under ~210 words):\nCANVAS:\n<one sentence summary>\n\nUSE CASE (guess):\n<one short line: what the user is likely trying to do (e.g., product listing, ad creative, editorial still, UI screenshot, moodboard)>\n\nSUBJECTS:\n- <2-6 bullets>\n\nSTYLE:\n- <3-7 short tags>\n\nNEXT ACTIONS:\n- <Action>: <why>  (max 5)\n\nActions must be chosen from CONTEXT_ENVELOPE_JSON.abilities[].label (prefer enabled=true).\nIf CONTEXT_ENVELOPE_JSON is missing, choose from: Multi view, Single view, Combine, Bridge, Swap DNA, Argue, Extract the Rule, Odd One Out, Triforce, Diagnose, Recast, Variations, Background: White, Background: Sweep, Crop: Square, Annotate.\nRules: infer the use case from both the image and CONTEXT_ENVELOPE_JSON.timeline_recent (edits). No fluff, no marketing language. Be specific about composition, lighting, color, materials. NEXT ACTIONS should serve the hypothesized use case."
}

#[allow(dead_code)]
fn infer_branch_from_text(haystack: &str) -> String {
    if contains_any(haystack, &["game", "sprite", "texture", "character"]) {
        "game_dev_assets".to_string()
    } else if contains_any(haystack, &["ui", "ux", "wireframe", "prototype", "screen"]) {
        "uiux_prototyping".to_string()
    } else if contains_any(
        haystack,
        &["product", "listing", "marketplace", "merch", "shop"],
    ) {
        "ecommerce_pod".to_string()
    } else if contains_any(haystack, &["pipeline", "system", "workflow", "automation"]) {
        "content_engine".to_string()
    } else {
        "streaming_content".to_string()
    }
}

#[allow(dead_code)]
fn infer_transformation_mode_from_text(haystack: &str) -> String {
    if contains_any(haystack, &["dramatic", "cinematic", "hero", "bold"]) {
        "amplify".to_string()
    } else if contains_any(haystack, &["clean", "minimal", "pure", "simple"]) {
        "purify".to_string()
    } else if contains_any(haystack, &["surreal", "fracture", "chaos", "glitch"]) {
        "fracture".to_string()
    } else if contains_any(haystack, &["romantic", "warm", "intimate"]) {
        "romanticize".to_string()
    } else {
        "hybridize".to_string()
    }
}

#[allow(dead_code)]
fn fallback_intent_branches(preferred_branch: &str, evidence_ids: &[String]) -> Vec<Value> {
    let templates: Vec<(&str, Vec<&str>)> = vec![
        (
            "game_dev_assets",
            vec![
                "GAME_DEV_ASSETS",
                "CONCEPT_ART",
                "SPRITES",
                "TEXTURES",
                "CHARACTER_SHEETS",
                "ITERATION",
            ],
        ),
        (
            "streaming_content",
            vec![
                "STREAMING_CONTENT",
                "THUMBNAILS",
                "OVERLAYS",
                "EMOTES",
                "SOCIAL_GRAPHICS",
                "OUTPUTS",
            ],
        ),
        (
            "uiux_prototyping",
            vec![
                "UI_UX_PROTOTYPING",
                "SCREENS",
                "WIREFRAMES",
                "MOCKUPS",
                "USER_FLOWS",
                "PIPELINE",
            ],
        ),
        (
            "ecommerce_pod",
            vec![
                "ECOMMERCE_POD",
                "MERCH_DESIGN",
                "PRODUCT_PHOTOS",
                "MARKETPLACE_LISTINGS",
                "OUTPUTS",
            ],
        ),
        (
            "content_engine",
            vec![
                "CONTENT_ENGINE",
                "BRAND_SYSTEM",
                "MULTI_CHANNEL",
                "PROCESS",
                "AUTOMATION",
                "PIPELINE",
            ],
        ),
    ];
    let mut ordered: Vec<(&str, Vec<&str>)> = Vec::new();
    if let Some(idx) = templates
        .iter()
        .position(|(branch_id, _)| *branch_id == preferred_branch)
    {
        ordered.push(templates[idx].clone());
    }
    for row in templates {
        if ordered.iter().any(|(branch_id, _)| *branch_id == row.0) {
            continue;
        }
        ordered.push(row);
    }

    ordered
        .into_iter()
        .enumerate()
        .map(|(idx, (branch_id, icons))| {
            let confidence = (0.84 - (idx as f64 * 0.06)).max(0.52);
            json!({
                "branch_id": branch_id,
                "confidence": confidence,
                "evidence_image_ids": evidence_ids,
                "icons": icons,
                "lane_position": if idx % 2 == 0 { "left" } else { "right" },
            })
        })
        .collect()
}

#[allow(dead_code)]
fn build_intent_icons_payload(snapshot_path: &Path, mother: bool) -> Value {
    let sidecar_path = snapshot_sidecar_path(snapshot_path);
    let sidecar = read_json_object(&sidecar_path).unwrap_or_default();
    let frame_id = sidecar
        .get("frame_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            snapshot_path
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or("frame")
                .to_string()
        });

    let hints = snapshot_image_hints(snapshot_path);
    let mut image_descriptions: Vec<Value> = Vec::new();
    for hint in &hints {
        let image_id = if !hint.id.trim().is_empty() {
            hint.id.trim().to_string()
        } else {
            humanize_file_name(&hint.file)
                .replace(' ', "_")
                .to_ascii_lowercase()
        };
        let label = if !hint.vision_desc.trim().is_empty() {
            clamp_text(hint.vision_desc.trim(), REALTIME_DESCRIPTION_MAX_CHARS)
        } else {
            clamp_text(
                &humanize_file_name(&hint.file),
                REALTIME_DESCRIPTION_MAX_CHARS,
            )
        };
        if image_id.is_empty() || label.is_empty() {
            continue;
        }
        image_descriptions.push(json!({
            "image_id": image_id,
            "label": label,
            "confidence": 0.62,
        }));
    }

    let evidence_ids: Vec<String> = image_descriptions
        .iter()
        .filter_map(|row| {
            row.get("image_id")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .take(3)
        .collect();
    let haystack = image_descriptions
        .iter()
        .filter_map(|row| row.get("label").and_then(Value::as_str).map(str::to_string))
        .collect::<Vec<String>>()
        .join(" ")
        .to_ascii_lowercase();
    let preferred_branch = infer_branch_from_text(&haystack);
    let transformation_mode = infer_transformation_mode_from_text(&haystack);
    let branches = fallback_intent_branches(&preferred_branch, &evidence_ids);
    let checkpoint_branch = branches
        .first()
        .and_then(|row| row.get("branch_id"))
        .and_then(Value::as_str)
        .unwrap_or("streaming_content")
        .to_string();

    json!({
        "frame_id": frame_id,
        "schema": "brood.intent_icons",
        "schema_version": 1,
        "intent_icons": [
            { "icon_id": "IMAGE_GENERATION", "confidence": if mother { 0.84 } else { 0.74 }, "position_hint": "primary" },
            { "icon_id": "ITERATION", "confidence": 0.66, "position_hint": "primary" },
            { "icon_id": "OUTPUTS", "confidence": 0.52, "position_hint": "secondary" },
            { "icon_id": "PIPELINE", "confidence": 0.46, "position_hint": "emerging" },
        ],
        "relations": [
            { "from_icon": "ITERATION", "to_icon": "IMAGE_GENERATION", "relation_type": "DEPENDENCY" },
            { "from_icon": "IMAGE_GENERATION", "to_icon": "OUTPUTS", "relation_type": "FLOW" },
        ],
        "branches": branches,
        "checkpoint": {
            "icons": ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"],
            "applies_to": checkpoint_branch,
        },
        "transformation_mode": transformation_mode,
        "transformation_mode_candidates": [
            { "mode": transformation_mode, "confidence": 0.74 },
            { "mode": "hybridize", "confidence": 0.62 },
            { "mode": "amplify", "confidence": 0.55 },
        ],
        "image_descriptions": image_descriptions,
    })
}

fn normalize_transformation_mode(value: Option<&Value>) -> String {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match raw.as_str() {
        "amplify" | "transcend" | "destabilize" | "purify" | "hybridize" | "mythologize"
        | "monumentalize" | "fracture" | "romanticize" | "alienate" => raw,
        _ => "hybridize".to_string(),
    }
}

fn intent_summary_for_mode(mode: &str, hints: &[String]) -> String {
    let primary_hint = hints
        .iter()
        .find(|value| !value.trim().is_empty())
        .map(|value| clamp_text(value, 64))
        .unwrap_or_default();
    let suffix = if primary_hint.is_empty() {
        String::new()
    } else {
        format!(" from {primary_hint}")
    };
    match mode {
        "amplify" => format!("Push the composition into a cinematic crescendo{suffix}."),
        "transcend" => format!("Lift the scene into a transcendent visual world{suffix}."),
        "destabilize" => {
            format!("Shift the composition toward controlled visual instability{suffix}.")
        }
        "purify" => format!("Simplify geometry and light into a calm sculptural image{suffix}."),
        "mythologize" => format!("Recast the scene as mythic visual storytelling{suffix}."),
        "monumentalize" => {
            format!("Turn the scene into a monumental hero composition{suffix}.")
        }
        "fracture" => format!("Introduce deliberate fracture while preserving coherence{suffix}."),
        "romanticize" => format!("Infuse the scene with intimate emotional warmth{suffix}."),
        "alienate" => format!("Reframe the scene with uncanny distance{suffix}."),
        _ => format!("Fuse current references into one coherent composition{suffix}."),
    }
}

fn mother_payload_image_ids(payload: &Map<String, Value>) -> Vec<String> {
    let mut ids: Vec<String> = payload
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .map(str::to_string)
        })
        .filter(|id| !id.is_empty())
        .collect();
    ids.dedup();
    ids
}

fn normalize_id_list_from_value(
    value: Option<&Value>,
    allowed_ids: &[String],
    max_items: usize,
) -> Vec<String> {
    if max_items == 0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut raw_items: Vec<String> = Vec::new();
    match value {
        Some(Value::Array(rows)) => {
            for row in rows {
                if let Some(text) = row.as_str() {
                    raw_items.push(text.to_string());
                }
            }
        }
        Some(Value::String(text)) => {
            raw_items.extend(
                text.split(',')
                    .map(str::trim)
                    .map(str::to_string)
                    .filter(|item| !item.is_empty()),
            );
        }
        _ => {}
    }

    for id in raw_items {
        let key = id.trim();
        if key.is_empty() {
            continue;
        }
        if !allowed_ids.is_empty() && !allowed_ids.iter().any(|known| known == key) {
            continue;
        }
        let normalized = key.to_string();
        if out.iter().any(|existing| existing == &normalized) {
            continue;
        }
        out.push(normalized);
        if out.len() >= max_items {
            break;
        }
    }
    out
}

fn normalize_mother_placement_policy(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    match raw.as_str() {
        "adjacent" | "grid" | "replace" => Some(raw),
        _ => None,
    }
}

fn normalize_mother_confidence(value: Option<&Value>) -> Option<f64> {
    let parsed = match value {
        Some(Value::Number(number)) => number.as_f64(),
        Some(Value::String(text)) => text.trim().parse::<f64>().ok(),
        _ => None,
    }?;
    if !parsed.is_finite() {
        return None;
    }
    Some(parsed.clamp(0.2, 0.99))
}

fn normalize_intent_roles(
    candidate_roles: Option<&Map<String, Value>>,
    fallback_roles: &Map<String, Value>,
    allowed_ids: &[String],
) -> Map<String, Value> {
    let mut out = Map::new();
    for key in ["subject", "model", "mediator", "object"] {
        let fallback = normalize_id_list_from_value(fallback_roles.get(key), allowed_ids, 2);
        let provider = candidate_roles
            .and_then(|roles| roles.get(key))
            .map(|value| normalize_id_list_from_value(Some(value), allowed_ids, 2))
            .unwrap_or_default();
        let resolved = if provider.is_empty() {
            fallback
        } else {
            provider
        };
        out.insert(
            key.to_string(),
            Value::Array(resolved.into_iter().map(Value::String).collect()),
        );
    }
    out
}

fn openai_json_object_inference(
    model_hint: Option<&str>,
    instruction: String,
    max_output_tokens: u64,
    timeout: Duration,
) -> Option<(Map<String, Value>, String)> {
    let requested =
        sanitize_openai_responses_model(model_hint.unwrap_or("gpt-4o-mini"), "gpt-4o-mini");
    let mut models = vec![requested.clone()];
    if requested != "gpt-4o-mini" {
        models.push("gpt-4o-mini".to_string());
    }

    for model in models {
        let content = vec![json!({
            "type": "input_text",
            "text": instruction,
        })];
        let Some((text, _, _, model_name)) =
            openai_vision_request(&model, content, max_output_tokens, timeout)
        else {
            continue;
        };
        let Some(object) = extract_json_object_from_text(&text) else {
            continue;
        };
        return Some((object, model_name));
    }
    None
}

fn infer_structured_intent_payload_via_provider(
    payload: &Map<String, Value>,
    model_hint: Option<&str>,
) -> Option<(Map<String, Value>, String)> {
    let image_ids = mother_payload_image_ids(payload);
    let payload_json = serde_json::to_string(payload).ok()?;
    let instruction = format!(
        "You are Brood's Mother intent inference engine.\nReturn JSON only (no markdown).\n\
Given PAYLOAD_JSON, infer one intent object with this exact schema:\n\
{{\n  \"intent_id\": \"string\",\n  \"summary\": \"string\",\n  \"creative_directive\": \"stunningly awe-inspiring and joyous\",\n  \"transformation_mode\": \"amplify|transcend|destabilize|purify|hybridize|mythologize|monumentalize|fracture|romanticize|alienate\",\n  \"target_ids\": [\"id\"],\n  \"reference_ids\": [\"id\"],\n  \"placement_policy\": \"adjacent|grid|replace\",\n  \"confidence\": 0.0,\n  \"roles\": {{ \"subject\": [\"id\"], \"model\": [\"id\"], \"mediator\": [\"id\"], \"object\": [\"id\"] }},\n  \"alternatives\": [{{\"placement_policy\":\"adjacent\"}}, {{\"placement_policy\":\"grid\"}}]\n}}\n\
Rules:\n- Use only image IDs from this allowlist: [{}].\n\
- Keep confidence between 0.2 and 0.99.\n\
- Prefer concise summary language.\n\
PAYLOAD_JSON:\n{}",
        image_ids.join(", "),
        payload_json
    );
    openai_json_object_inference(model_hint, instruction, 1000, Duration::from_secs_f64(32.0))
}

fn normalize_provider_intent_payload(
    candidate: &Map<String, Value>,
    fallback: &Value,
    payload: &Map<String, Value>,
) -> Value {
    let fallback_obj = fallback.as_object().cloned().unwrap_or_default();
    let allowed_ids = mother_payload_image_ids(payload);
    let fallback_roles = fallback_obj
        .get("roles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let summary = value_as_non_empty_string(candidate.get("summary"))
        .map(|value| clamp_text(&value, 360))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("summary")))
        .unwrap_or_else(|| "Fuse references into one coherent composition.".to_string());
    let creative_directive = value_as_non_empty_string(candidate.get("creative_directive"))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("creative_directive")))
        .unwrap_or_else(|| "stunningly awe-inspiring and joyous".to_string());
    let transformation_mode = normalize_transformation_mode(
        candidate
            .get("transformation_mode")
            .or_else(|| fallback_obj.get("transformation_mode")),
    );
    let target_ids = {
        let provider = normalize_id_list_from_value(candidate.get("target_ids"), &allowed_ids, 3);
        if provider.is_empty() {
            normalize_id_list_from_value(fallback_obj.get("target_ids"), &allowed_ids, 3)
        } else {
            provider
        }
    };
    let reference_ids = {
        let provider =
            normalize_id_list_from_value(candidate.get("reference_ids"), &allowed_ids, 3);
        if provider.is_empty() {
            normalize_id_list_from_value(fallback_obj.get("reference_ids"), &allowed_ids, 3)
        } else {
            provider
        }
    };
    let placement_policy = normalize_mother_placement_policy(candidate.get("placement_policy"))
        .or_else(|| normalize_mother_placement_policy(fallback_obj.get("placement_policy")))
        .unwrap_or_else(|| "adjacent".to_string());
    let confidence = normalize_mother_confidence(candidate.get("confidence"))
        .or_else(|| normalize_mother_confidence(fallback_obj.get("confidence")))
        .unwrap_or(0.64);
    let intent_id = value_as_non_empty_string(candidate.get("intent_id"))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("intent_id")))
        .unwrap_or_else(|| {
            format!(
                "intent-{}",
                payload
                    .get("action_version")
                    .and_then(Value::as_i64)
                    .unwrap_or(0)
            )
        });

    let candidate_roles = candidate.get("roles").and_then(Value::as_object);
    let roles = normalize_intent_roles(candidate_roles, &fallback_roles, &allowed_ids);
    let alternatives = candidate
        .get("alternatives")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_object().cloned())
        .filter_map(|row| {
            normalize_mother_placement_policy(row.get("placement_policy")).map(|placement| {
                json!({
                    "placement_policy": placement,
                })
            })
        })
        .take(3)
        .collect::<Vec<Value>>();
    let alternatives = if alternatives.is_empty() {
        fallback_obj
            .get("alternatives")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_else(|| {
                vec![
                    json!({"placement_policy": "adjacent"}),
                    json!({"placement_policy": "grid"}),
                ]
            })
    } else {
        alternatives
    };

    json!({
        "intent_id": intent_id,
        "summary": summary,
        "creative_directive": creative_directive,
        "transformation_mode": transformation_mode,
        "target_ids": target_ids,
        "reference_ids": reference_ids,
        "placement_policy": placement_policy,
        "confidence": confidence,
        "roles": roles,
        "alternatives": alternatives,
    })
}

fn infer_structured_intent_payload_provider_first(
    payload: &Map<String, Value>,
    model_hint: Option<&str>,
    source_label: &str,
) -> (Value, String, String) {
    let fallback = infer_structured_intent_payload(payload);
    if let Some((candidate, model_name)) =
        infer_structured_intent_payload_via_provider(payload, model_hint)
    {
        let normalized = normalize_provider_intent_payload(&candidate, &fallback, payload);
        return (normalized, source_label.to_string(), model_name);
    }
    (
        fallback,
        source_label.to_string(),
        "heuristic-v1".to_string(),
    )
}

fn infer_structured_intent_payload(payload: &Map<String, Value>) -> Value {
    let action_version = payload
        .get("action_version")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let mut image_ids: Vec<String> = payload
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_string))
        .filter(|id| !id.trim().is_empty())
        .collect();
    image_ids.dedup();
    let image_set: HashMap<String, ()> = image_ids.iter().cloned().map(|key| (key, ())).collect();

    let mut selected_ids: Vec<String> = ids_list(payload.get("selected_ids"));
    selected_ids.retain(|id| image_set.contains_key(id));
    let active_id = payload
        .get("active_id")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string();

    let ranked_ids = rank_payload_image_ids(payload.get("images").and_then(Value::as_array));
    let mut target_ids = if !selected_ids.is_empty() {
        selected_ids.clone()
    } else if !active_id.is_empty() && image_set.contains_key(&active_id) {
        vec![active_id.clone()]
    } else if !ranked_ids.is_empty() {
        vec![ranked_ids[0].clone()]
    } else if !image_ids.is_empty() {
        vec![image_ids[0].clone()]
    } else {
        Vec::new()
    };
    target_ids.truncate(3);

    let mut reference_ids: Vec<String> = ranked_ids
        .into_iter()
        .filter(|id| !target_ids.contains(id))
        .take(3)
        .collect();
    if reference_ids.is_empty() {
        reference_ids = image_ids
            .iter()
            .filter(|id| !target_ids.contains(id))
            .take(3)
            .cloned()
            .collect();
    }

    let hints: Vec<String> = payload
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_object().cloned())
        .flat_map(|row| {
            let mut values = Vec::new();
            if let Some(desc) = row.get("vision_desc").and_then(Value::as_str) {
                values.push(desc.trim().to_string());
            }
            if let Some(file) = row.get("file").and_then(Value::as_str) {
                values.push(humanize_file_name(file));
            }
            values
        })
        .filter(|value| !value.trim().is_empty())
        .collect();

    let transformation_mode =
        normalize_transformation_mode(payload.get("preferred_transformation_mode"));
    let summary = intent_summary_for_mode(&transformation_mode, &hints);
    let placement_policy = if image_ids.len() >= 4 {
        "grid"
    } else if !target_ids.is_empty() && !reference_ids.is_empty() {
        "adjacent"
    } else if !target_ids.is_empty() {
        "replace"
    } else {
        "adjacent"
    };

    let subject = if !target_ids.is_empty() {
        vec![target_ids[0].clone()]
    } else {
        Vec::new()
    };
    let model = if !reference_ids.is_empty() {
        vec![reference_ids[0].clone()]
    } else {
        subject.clone()
    };
    let mediator = if reference_ids.len() > 1 {
        vec![reference_ids[1].clone()]
    } else {
        model.clone()
    };
    let object_role = subject.clone();

    let mut confidence = 0.64f64;
    if !selected_ids.is_empty() {
        confidence += 0.08;
    }
    if image_ids.len() >= 3 {
        confidence += 0.04;
    }
    confidence = confidence.clamp(0.2, 0.99);

    json!({
        "intent_id": format!("intent-{action_version}"),
        "summary": summary,
        "creative_directive": "stunningly awe-inspiring and joyous",
        "transformation_mode": transformation_mode,
        "target_ids": target_ids,
        "reference_ids": reference_ids,
        "placement_policy": placement_policy,
        "confidence": (confidence * 100.0).round() / 100.0,
        "roles": {
            "subject": subject,
            "model": model,
            "mediator": mediator,
            "object": object_role,
        },
        "alternatives": [
            {"placement_policy": "adjacent"},
            {"placement_policy": "grid"},
        ],
    })
}

fn rank_payload_image_ids(images: Option<&Vec<Value>>) -> Vec<String> {
    let mut ranked: Vec<(String, f64, usize)> = Vec::new();
    if let Some(images) = images {
        for (idx, row) in images.iter().enumerate() {
            let Some(obj) = row.as_object() else {
                continue;
            };
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or_default()
                .to_string();
            if id.is_empty() {
                continue;
            }
            let rect = obj
                .get("rect")
                .and_then(Value::as_object)
                .or_else(|| obj.get("rect_norm").and_then(Value::as_object));
            let area = rect
                .and_then(|shape| {
                    let w = shape.get("w").and_then(Value::as_f64)?;
                    let h = shape.get("h").and_then(Value::as_f64)?;
                    Some((w.max(0.0)) * (h.max(0.0)))
                })
                .unwrap_or(0.0);
            ranked.push((id, area, idx));
        }
    }
    if ranked.is_empty() {
        return Vec::new();
    }
    ranked.sort_by(|left, right| {
        right
            .1
            .partial_cmp(&left.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.2.cmp(&right.2))
    });
    ranked.into_iter().map(|row| row.0).collect()
}

fn compile_mother_prompt_payload(payload: &Map<String, Value>) -> Value {
    let action_version = payload
        .get("action_version")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let intent = payload
        .get("intent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let roles = intent
        .get("roles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let summary = value_as_non_empty_string(intent.get("summary"))
        .or_else(|| value_as_non_empty_string(intent.get("label")))
        .unwrap_or_else(|| "Fuse references into one coherent composition.".to_string());
    let creative_directive = value_as_non_empty_string(payload.get("creative_directive"))
        .or_else(|| value_as_non_empty_string(intent.get("creative_directive")))
        .unwrap_or_else(|| "stunningly awe-inspiring and joyous".to_string());
    let transformation_mode = normalize_transformation_mode(
        payload
            .get("transformation_mode")
            .or_else(|| intent.get("transformation_mode")),
    );
    let placement = value_as_non_empty_string(intent.get("placement_policy"))
        .unwrap_or_else(|| "adjacent".to_string());

    let subject_ids = ids_list(roles.get("subject"));
    let model_ids = ids_list(roles.get("model"));
    let mediator_ids = ids_list(roles.get("mediator"));
    let object_ids = ids_list(roles.get("object"));
    let target_ids = ids_list(intent.get("target_ids"));
    let reference_ids = ids_list(intent.get("reference_ids"));

    let mut context_ids = Vec::new();
    for id in target_ids.iter().chain(reference_ids.iter()) {
        if !context_ids.contains(id) {
            context_ids.push(id.clone());
        }
    }
    let multi_image = context_ids.len() > 1;

    let image_hints: Vec<String> = payload
        .get("images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_object().cloned())
        .flat_map(|row| {
            let mut out = Vec::new();
            if let Some(value) = row.get("vision_desc").and_then(Value::as_str) {
                out.push(value.trim().to_ascii_lowercase());
            }
            if let Some(value) = row.get("file").and_then(Value::as_str) {
                out.push(value.trim().to_ascii_lowercase());
            }
            out
        })
        .collect();
    let human_inputs = image_hints.iter().any(|value| {
        contains_any(
            value,
            &["person", "people", "human", "face", "portrait", "selfie"],
        )
    });
    let allow_double_exposure = matches!(
        transformation_mode.as_str(),
        "destabilize" | "fracture" | "alienate"
    );

    let mut constraints = vec![
        "No unintended ghosted human overlays.".to_string(),
        if allow_double_exposure {
            "Allow intentional double-exposure only when it clearly supports the chosen transformation mode."
                .to_string()
        } else {
            "No accidental double-exposure artifacts.".to_string()
        },
        "No icon-overpaint artifacts.".to_string(),
        "Preserve source-object integrity where role anchors imply continuity.".to_string(),
    ];
    if !human_inputs {
        constraints.push(
            "No extra humans or faces unless clearly present in the input references.".to_string(),
        );
    }

    let mut positive_lines = vec![
        format!("Intent summary: {summary}."),
        "Role anchors:".to_string(),
        format!(
            "- SUBJECT: {}",
            if subject_ids.is_empty() {
                "primary subject".to_string()
            } else {
                subject_ids.join(", ")
            }
        ),
        format!(
            "- MODEL: {}",
            if model_ids.is_empty() {
                "reference model".to_string()
            } else {
                model_ids.join(", ")
            }
        ),
        format!(
            "- MEDIATOR: {}",
            if mediator_ids.is_empty() {
                "layout mediator".to_string()
            } else {
                mediator_ids.join(", ")
            }
        ),
        format!(
            "- OBJECT: {}",
            if object_ids.is_empty() {
                "desired outcome".to_string()
            } else {
                object_ids.join(", ")
            }
        ),
        format!("Placement policy target: {placement}."),
    ];
    if multi_image {
        positive_lines.extend([
            "Multi-image fusion rules:".to_string(),
            "- Integrate all references into a single coherent scene (not a collage).".to_string(),
            "- Match perspective, scale, and lighting direction across fused elements.".to_string(),
            "- Keep one coherent camera framing and focal hierarchy.".to_string(),
        ]);
    }
    positive_lines.push("Anti-overlay constraints:".to_string());
    for item in &constraints {
        positive_lines.push(format!("- {item}"));
    }
    positive_lines.extend([
        "No visible text, logos-as-text, captions, or watermarks.".to_string(),
        "Create one production-ready concept image.".to_string(),
        format!("Creative directive: {creative_directive}."),
        format!("Transformation mode: {transformation_mode}."),
    ]);

    let negative_prompt = if human_inputs {
        "No collage split-screen. No text overlays. No watermark. No ghosted human overlays. No icon-overpaint artifacts. No low-detail artifacts. No unintended extra faces."
    } else {
        "No collage split-screen. No text overlays. No watermark. No ghosted human overlays. No icon-overpaint artifacts. No low-detail artifacts. No extra humans/faces unless present in inputs."
    };

    json!({
        "action_version": action_version,
        "creative_directive": creative_directive,
        "transformation_mode": transformation_mode,
        "positive_prompt": positive_lines.join("\n"),
        "negative_prompt": negative_prompt,
        "compile_constraints": constraints,
        "generation_params": {
            "guidance_scale": 7.0,
            "layout_hint": placement,
            "seed_strategy": "random",
            "transformation_mode": transformation_mode,
        },
    })
}

fn compile_mother_prompt_payload_via_provider(
    payload: &Map<String, Value>,
    model_hint: Option<&str>,
) -> Option<(Map<String, Value>, String)> {
    let payload_json = serde_json::to_string(payload).ok()?;
    let instruction = format!(
        "You are Brood's Mother prompt compiler.\nReturn JSON only (no markdown).\n\
Given PAYLOAD_JSON, produce one object with this exact schema:\n\
{{\n  \"action_version\": 0,\n  \"creative_directive\": \"string\",\n  \"transformation_mode\": \"amplify|transcend|destabilize|purify|hybridize|mythologize|monumentalize|fracture|romanticize|alienate\",\n  \"positive_prompt\": \"string\",\n  \"negative_prompt\": \"string\",\n  \"compile_constraints\": [\"string\"],\n  \"generation_params\": {{\n    \"guidance_scale\": 7.0,\n    \"layout_hint\": \"adjacent|grid|replace\",\n    \"seed_strategy\": \"random\",\n    \"transformation_mode\": \"same as top-level\"\n  }}\n}}\n\
Rules:\n- Prompts must be production-ready for image generation.\n\
- Keep anti-artifact constraints explicit.\n\
- Keep generation_params.transformation_mode aligned with top-level transformation_mode.\n\
PAYLOAD_JSON:\n{}",
        payload_json
    );
    openai_json_object_inference(model_hint, instruction, 1300, Duration::from_secs_f64(38.0))
}

fn normalize_compile_constraints(value: Option<&Value>) -> Vec<String> {
    coerce_text_list(value, 14, 220)
}

fn normalize_generation_params(
    candidate: Option<&Map<String, Value>>,
    fallback: &Map<String, Value>,
    transformation_mode: &str,
) -> Map<String, Value> {
    let mut out = fallback.clone();
    if let Some(candidate) = candidate {
        if let Some(guidance_scale) = candidate
            .get("guidance_scale")
            .and_then(|value| match value {
                Value::Number(number) => number.as_f64(),
                Value::String(text) => text.trim().parse::<f64>().ok(),
                _ => None,
            })
            .filter(|value| value.is_finite())
        {
            out.insert(
                "guidance_scale".to_string(),
                Value::Number(
                    serde_json::Number::from_f64(guidance_scale.clamp(0.1, 30.0))
                        .unwrap_or_else(|| serde_json::Number::from(7)),
                ),
            );
        }
        if let Some(layout_hint) = normalize_mother_placement_policy(candidate.get("layout_hint")) {
            out.insert("layout_hint".to_string(), Value::String(layout_hint));
        }
        if let Some(seed_strategy) = value_as_non_empty_string(candidate.get("seed_strategy")) {
            out.insert(
                "seed_strategy".to_string(),
                Value::String(clamp_text(&seed_strategy, 48)),
            );
        }
    }
    out.insert(
        "transformation_mode".to_string(),
        Value::String(transformation_mode.to_string()),
    );
    out
}

fn normalize_provider_compiled_payload(
    candidate: &Map<String, Value>,
    fallback: &Value,
    payload: &Map<String, Value>,
) -> Value {
    let fallback_obj = fallback.as_object().cloned().unwrap_or_default();
    let action_version = payload
        .get("action_version")
        .and_then(Value::as_i64)
        .or_else(|| fallback_obj.get("action_version").and_then(Value::as_i64))
        .unwrap_or(0);
    let creative_directive = value_as_non_empty_string(candidate.get("creative_directive"))
        .map(|value| clamp_text(&value, 220))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("creative_directive")))
        .unwrap_or_else(|| "stunningly awe-inspiring and joyous".to_string());
    let transformation_mode = normalize_transformation_mode(
        candidate
            .get("transformation_mode")
            .or_else(|| fallback_obj.get("transformation_mode")),
    );
    let positive_prompt = value_as_non_empty_string(candidate.get("positive_prompt"))
        .map(|value| clamp_text(&value, 12000))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("positive_prompt")))
        .unwrap_or_default();
    let negative_prompt = value_as_non_empty_string(candidate.get("negative_prompt"))
        .map(|value| clamp_text(&value, 3000))
        .or_else(|| value_as_non_empty_string(fallback_obj.get("negative_prompt")))
        .unwrap_or_default();

    let constraints = {
        let provider = normalize_compile_constraints(candidate.get("compile_constraints"));
        if provider.is_empty() {
            normalize_compile_constraints(fallback_obj.get("compile_constraints"))
        } else {
            provider
        }
    };

    let fallback_generation = fallback_obj
        .get("generation_params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(|| {
            json_object(json!({
                "guidance_scale": 7.0,
                "layout_hint": "adjacent",
                "seed_strategy": "random",
                "transformation_mode": transformation_mode,
            }))
        });
    let generation_params = normalize_generation_params(
        candidate
            .get("generation_params")
            .and_then(Value::as_object),
        &fallback_generation,
        &transformation_mode,
    );

    json!({
        "action_version": action_version,
        "creative_directive": creative_directive,
        "transformation_mode": transformation_mode,
        "positive_prompt": positive_prompt,
        "negative_prompt": negative_prompt,
        "compile_constraints": constraints,
        "generation_params": generation_params,
    })
}

fn compile_mother_prompt_payload_provider_first(
    payload: &Map<String, Value>,
    model_hint: Option<&str>,
    source_label: &str,
) -> (Value, String, String) {
    let fallback = compile_mother_prompt_payload(payload);
    if let Some((candidate, model_name)) =
        compile_mother_prompt_payload_via_provider(payload, model_hint)
    {
        let normalized = normalize_provider_compiled_payload(&candidate, &fallback, payload);
        return (normalized, source_label.to_string(), model_name);
    }
    (
        fallback,
        source_label.to_string(),
        "heuristic-v1".to_string(),
    )
}

#[derive(Debug, Clone)]
struct MotherGenerateRequest {
    prompt: String,
    settings: Map<String, Value>,
    intent: Map<String, Value>,
    source_images: Vec<String>,
}

fn provider_from_model_name(model: &str) -> Option<String> {
    let normalized = model.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    if normalized.starts_with("gemini") {
        return Some("gemini".to_string());
    }
    if normalized.starts_with("imagen") {
        return Some("imagen".to_string());
    }
    if normalized.starts_with("gpt-") {
        return Some("openai".to_string());
    }
    if normalized.starts_with("flux") {
        return Some("flux".to_string());
    }
    if normalized.starts_with("sdxl") {
        return Some("replicate".to_string());
    }
    if normalized.starts_with("dryrun") {
        return Some("dryrun".to_string());
    }
    None
}

fn mother_generate_request_from_payload(
    payload: &Map<String, Value>,
    quality_preset: &str,
    target_provider: Option<&str>,
) -> Result<MotherGenerateRequest> {
    let mut prompt = value_as_non_empty_string(payload.get("prompt"))
        .or_else(|| value_as_non_empty_string(payload.get("positive_prompt")))
        .unwrap_or_default();
    if prompt.trim().is_empty() {
        bail!("Mother generate payload missing prompt.");
    }
    if let Some(negative) = value_as_non_empty_string(payload.get("negative_prompt")) {
        if !negative.trim().is_empty() && !prompt.to_ascii_lowercase().contains("avoid:") {
            prompt = format!("{prompt}\nAvoid: {}", negative.trim());
        }
    }

    let mut settings = chat_settings(quality_preset);
    let n = payload
        .get("n")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .unwrap_or(1);
    settings.insert("n".to_string(), Value::Number(n.into()));

    let generation_params = payload
        .get("generation_params")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let seed_strategy = value_as_non_empty_string(generation_params.get("seed_strategy"))
        .unwrap_or_default()
        .to_ascii_lowercase();
    if seed_strategy == "random" {
        settings.insert(
            "seed".to_string(),
            Value::Number(serde_json::Number::from(pseudo_random_seed())),
        );
    } else if let Some(seed) = generation_params.get("seed").and_then(Value::as_i64) {
        settings.insert("seed".to_string(), Value::Number(seed.into()));
    }

    let mut provider_options = settings
        .get("provider_options")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let provider = target_provider
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if provider == "gemini" || provider == "imagen" {
        if let Some(aspect_ratio) = value_as_non_empty_string(generation_params.get("aspect_ratio"))
        {
            provider_options.insert("aspect_ratio".to_string(), Value::String(aspect_ratio));
        }
        if let Some(image_size) = value_as_non_empty_string(generation_params.get("image_size")) {
            provider_options.insert("image_size".to_string(), Value::String(image_size));
        }
    }
    if provider == "gemini" {
        if let Some(safety_settings) = generation_params
            .get("safety_settings")
            .and_then(Value::as_array)
            .cloned()
        {
            provider_options.insert("safety_settings".to_string(), Value::Array(safety_settings));
        }
    }
    if provider == "imagen" {
        if let Some(add_watermark) = generation_params
            .get("add_watermark")
            .and_then(Value::as_bool)
        {
            provider_options.insert("add_watermark".to_string(), Value::Bool(add_watermark));
        }
        if let Some(person_generation) = generation_params.get("person_generation").cloned() {
            provider_options.insert("person_generation".to_string(), person_generation);
        }
    }
    if provider_options.is_empty() {
        settings.remove("provider_options");
    } else {
        settings.insert(
            "provider_options".to_string(),
            Value::Object(provider_options),
        );
    }

    let init_image = value_as_non_empty_string(payload.get("init_image"));
    let reference_images = value_as_string_list(payload.get("reference_images"));
    if let Some(init_image) = &init_image {
        settings.insert("init_image".to_string(), Value::String(init_image.clone()));
    }
    if !reference_images.is_empty() {
        settings.insert(
            "reference_images".to_string(),
            Value::Array(
                reference_images
                    .iter()
                    .map(|value| Value::String(value.clone()))
                    .collect(),
            ),
        );
    }

    let mut source_images = value_as_string_list(payload.get("source_images"));
    if source_images.is_empty() {
        if let Some(init_image) = &init_image {
            source_images.push(init_image.clone());
        }
        for image in &reference_images {
            source_images.push(image.clone());
        }
    }
    source_images.retain(|value| !value.trim().is_empty());

    let intent_meta = payload
        .get("intent")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let schema = value_as_non_empty_string(payload.get("schema")).unwrap_or_default();
    let is_v2 = schema.trim() == "brood.mother.generate.v2";
    let intent_id = if is_v2 {
        payload.get("intent_id").cloned().unwrap_or(Value::Null)
    } else {
        payload
            .get("intent_id")
            .cloned()
            .or_else(|| intent_meta.get("intent_id").cloned())
            .unwrap_or(Value::Null)
    };
    let transformation_mode = payload
        .get("transformation_mode")
        .cloned()
        .or_else(|| intent_meta.get("transformation_mode").cloned())
        .or_else(|| generation_params.get("transformation_mode").cloned())
        .unwrap_or(Value::Null);

    let mut action_meta = Map::new();
    action_meta.insert(
        "action".to_string(),
        Value::String("mother_generate".to_string()),
    );
    action_meta.insert("intent_id".to_string(), intent_id);
    action_meta.insert(
        "mother_action_version".to_string(),
        Value::Number(
            payload
                .get("action_version")
                .and_then(Value::as_i64)
                .unwrap_or(0)
                .into(),
        ),
    );
    action_meta.insert("transformation_mode".to_string(), transformation_mode);
    action_meta.insert(
        "source_images".to_string(),
        Value::Array(
            source_images
                .iter()
                .map(|value| Value::String(value.clone()))
                .collect(),
        ),
    );

    if let Some(packet) = payload
        .get("gemini_context_packet")
        .and_then(Value::as_object)
        .cloned()
    {
        action_meta.insert("gemini_context_packet".to_string(), Value::Object(packet));
    }

    if provider != "gemini" {
        if let Some(envelopes) = payload
            .get("model_context_envelopes")
            .and_then(Value::as_object)
            .cloned()
        {
            if let Some(envelope) = envelopes.get(&provider).cloned() {
                action_meta.insert("model_context_envelope".to_string(), envelope);
            } else if let Some((_, envelope)) = envelopes.into_iter().next() {
                action_meta.insert("model_context_envelope".to_string(), envelope);
            }
        }
    }

    Ok(MotherGenerateRequest {
        prompt,
        settings,
        intent: action_meta,
        source_images,
    })
}

fn pseudo_random_seed() -> i64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let now_nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    now_nanos.hash(&mut hasher);
    let raw = hasher.finish();
    (raw as i64).unsigned_abs().min(2_147_483_647) as i64
}

#[derive(Debug, Clone)]
struct BasicImageStats {
    width: u32,
    height: u32,
    mean_r: f64,
    mean_g: f64,
    mean_b: f64,
    brightness: f64,
    saturation: f64,
    palette: Vec<String>,
}

fn read_basic_image_stats(path: &Path) -> Option<BasicImageStats> {
    let image = image::open(path).ok()?;
    let resized = image.resize_exact(96, 96, FilterType::Triangle).to_rgb8();
    let mut total_r = 0f64;
    let mut total_g = 0f64;
    let mut total_b = 0f64;
    let mut total_brightness = 0f64;
    let mut total_saturation = 0f64;
    let mut bins: HashMap<(u8, u8, u8), u64> = HashMap::new();
    let mut count = 0f64;

    for pixel in resized.pixels() {
        let r = pixel[0] as f64;
        let g = pixel[1] as f64;
        let b = pixel[2] as f64;
        total_r += r;
        total_g += g;
        total_b += b;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        total_brightness += (r + g + b) / (255.0 * 3.0);
        let sat = if max <= 0.0 { 0.0 } else { (max - min) / max };
        total_saturation += sat;
        count += 1.0;

        let qr = ((pixel[0] as u16 / 32) * 32).min(255) as u8;
        let qg = ((pixel[1] as u16 / 32) * 32).min(255) as u8;
        let qb = ((pixel[2] as u16 / 32) * 32).min(255) as u8;
        *bins.entry((qr, qg, qb)).or_insert(0) += 1;
    }

    if count <= 0.0 {
        return None;
    }

    let mut dominant: Vec<((u8, u8, u8), u64)> = bins.into_iter().collect();
    dominant.sort_by(|left, right| right.1.cmp(&left.1));
    let mut palette: Vec<String> = dominant
        .into_iter()
        .take(6)
        .map(|(rgb, _)| rgb_hex(rgb.0, rgb.1, rgb.2))
        .collect();
    if palette.is_empty() {
        palette.push(rgb_hex(
            (total_r / count) as u8,
            (total_g / count) as u8,
            (total_b / count) as u8,
        ));
    }

    Some(BasicImageStats {
        width: image.width(),
        height: image.height(),
        mean_r: total_r / count,
        mean_g: total_g / count,
        mean_b: total_b / count,
        brightness: (total_brightness / count).clamp(0.0, 1.0),
        saturation: (total_saturation / count).clamp(0.0, 1.0),
        palette,
    })
}

fn rgb_hex(r: u8, g: u8, b: u8) -> String {
    format!("#{r:02X}{g:02X}{b:02X}")
}

fn color_name(r: f64, g: f64, b: f64) -> String {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let brightness = ((r + g + b) / (255.0 * 3.0)).clamp(0.0, 1.0);
    if max - min < 18.0 {
        if brightness > 0.78 {
            return "soft neutral".to_string();
        }
        if brightness < 0.22 {
            return "deep neutral".to_string();
        }
        return "muted neutral".to_string();
    }
    if max == r && g > b {
        "warm orange".to_string()
    } else if max == r {
        "crimson red".to_string()
    } else if max == g && b > r {
        "teal green".to_string()
    } else if max == g {
        "organic green".to_string()
    } else if max == b && r > g {
        "violet blue".to_string()
    } else {
        "cool blue".to_string()
    }
}

fn infer_diagnosis_text(path: &Path) -> String {
    let stats = read_basic_image_stats(path);
    let fallback_hex = "#808080".to_string();
    let palette = stats
        .as_ref()
        .and_then(|row| row.palette.first().cloned())
        .unwrap_or(fallback_hex);
    let dimensions = stats
        .as_ref()
        .map(|row| format!("{}x{}", row.width, row.height))
        .unwrap_or_else(|| "unknown size".to_string());
    let brightness = stats.as_ref().map(|row| row.brightness).unwrap_or(0.5);
    let saturation = stats.as_ref().map(|row| row.saturation).unwrap_or(0.45);
    let top_issue = if brightness < 0.25 {
        "The frame is under-exposed; key details are getting buried."
    } else if brightness > 0.82 {
        "Highlights are overpowering the subject hierarchy."
    } else if saturation < 0.22 {
        "Color energy is low, so the focal point feels flat."
    } else if saturation > 0.78 {
        "Color intensity is competing with structural clarity."
    } else {
        "Subject hierarchy can be made clearer with stronger separation."
    };

    format!(
        "USE CASE (guess): visual concept\n\nTOP ISSUE:\n{top_issue}\n\nWHAT'S WORKING:\n- Strong base palette ({palette}).\n- Solid source resolution ({dimensions}).\n- Readable global composition.\n\nWHAT TO FIX NEXT:\n- Increase contrast around the primary subject.\n- Reduce secondary detail that competes for attention.\n- Align lighting direction across major forms.\n- Keep one dominant focal plane.\n\nNEXT TEST:\n- Generate one tighter crop centered on the hero subject.\n- Generate one variation with cleaner negative space."
    )
}

fn infer_argument_text(path_a: &Path, path_b: &Path) -> String {
    let stats_a = read_basic_image_stats(path_a);
    let stats_b = read_basic_image_stats(path_b);
    let label_a = path_a
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("A");
    let label_b = path_b
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("B");
    let sat_a = stats_a.as_ref().map(|row| row.saturation).unwrap_or(0.5);
    let sat_b = stats_b.as_ref().map(|row| row.saturation).unwrap_or(0.5);
    let bright_a = stats_a.as_ref().map(|row| row.brightness).unwrap_or(0.5);
    let bright_b = stats_b.as_ref().map(|row| row.brightness).unwrap_or(0.5);

    let pick_a = (sat_a + bright_a * 0.5) >= (sat_b + bright_b * 0.5);
    let winner = if pick_a { "A" } else { "B" };
    let winner_label = if pick_a { label_a } else { label_b };

    format!(
        "IMAGE A WINS IF:\n- You want stronger immediacy and punch.\n- You prefer bolder color separation.\n- You need faster thumbnail readability.\n\nIMAGE B WINS IF:\n- You want calmer tonal control.\n- You need a softer, more editorial mood.\n- You want more room for downstream refinements.\n\nMY PICK:\n{winner} — {winner_label}\n\nWHY:\nThe winning frame currently gives the clearest hierarchy for a single hero read. It needs fewer corrections before shipping.\n\nNEXT TEST:\n- Run one controlled variation from the winner.\n- Borrow one lighting/composition trait from the losing frame."
    )
}

#[derive(Debug, Clone)]
struct DnaSignature {
    palette: Vec<String>,
    colors: Vec<String>,
    materials: Vec<String>,
    summary: String,
}

fn extract_dna_signature(path: &Path) -> DnaSignature {
    let stats = read_basic_image_stats(path);
    let palette = stats
        .as_ref()
        .map(|row| row.palette.clone())
        .unwrap_or_else(|| vec!["#808080".to_string()]);
    let mut colors: Vec<String> = Vec::new();
    if let Some(row) = &stats {
        colors.push(color_name(row.mean_r, row.mean_g, row.mean_b));
    }
    for hex in palette.iter().take(3) {
        let label = format!("{hex} accent");
        if !colors.contains(&label) {
            colors.push(label);
        }
    }
    if colors.is_empty() {
        colors.push("balanced neutral palette".to_string());
    }
    colors.truncate(6);

    let file_hint = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mut materials = Vec::new();
    if contains_any(&file_hint, &["metal", "chrome", "steel"]) {
        materials.push("brushed metal".to_string());
    }
    if contains_any(&file_hint, &["wood", "timber"]) {
        materials.push("natural wood".to_string());
    }
    if contains_any(&file_hint, &["glass", "window"]) {
        materials.push("clean glass".to_string());
    }
    if contains_any(&file_hint, &["fabric", "cloth", "textile"]) {
        materials.push("woven textile".to_string());
    }
    if materials.is_empty() {
        materials.extend([
            "matte composite".to_string(),
            "soft diffuse surfaces".to_string(),
            "structured hard edges".to_string(),
        ]);
    }
    materials.truncate(5);

    let summary = format!(
        "Transfer {} with {} highlights.",
        colors
            .first()
            .cloned()
            .unwrap_or_else(|| "core palette".to_string()),
        materials
            .first()
            .cloned()
            .unwrap_or_else(|| "material".to_string())
    );

    DnaSignature {
        palette,
        colors,
        materials,
        summary: clamp_text(&summary, 120),
    }
}

#[derive(Debug, Clone)]
struct SoulSignature {
    emotion: String,
    summary: String,
}

fn extract_soul_signature(path: &Path) -> SoulSignature {
    let stats = read_basic_image_stats(path);
    let brightness = stats.as_ref().map(|row| row.brightness).unwrap_or(0.5);
    let saturation = stats.as_ref().map(|row| row.saturation).unwrap_or(0.45);
    let emotion = if brightness < 0.22 {
        "moody tension"
    } else if brightness > 0.8 && saturation < 0.28 {
        "quiet serenity"
    } else if saturation > 0.75 {
        "electric momentum"
    } else if saturation < 0.2 {
        "calm restraint"
    } else {
        "balanced confidence"
    };
    let summary = format!(
        "Carry forward a {} while preserving structural clarity.",
        emotion
    );
    SoulSignature {
        emotion: emotion.to_string(),
        summary: clamp_text(&summary, 120),
    }
}

#[derive(Debug, Clone)]
struct TripletRuleOutput {
    principle: String,
    evidence: Vec<Value>,
    annotations: Vec<Value>,
    confidence: f64,
}

fn infer_triplet_rule(path_a: &Path, path_b: &Path, path_c: &Path) -> TripletRuleOutput {
    let stats_a = read_basic_image_stats(path_a);
    let stats_b = read_basic_image_stats(path_b);
    let stats_c = read_basic_image_stats(path_c);
    let avg_brightness = ((stats_a.as_ref().map(|row| row.brightness).unwrap_or(0.5)
        + stats_b.as_ref().map(|row| row.brightness).unwrap_or(0.5)
        + stats_c.as_ref().map(|row| row.brightness).unwrap_or(0.5))
        / 3.0)
        .clamp(0.0, 1.0);
    let principle = if avg_brightness > 0.65 {
        "Shared rule: bright, clean compositions with forward focal hierarchy."
    } else if avg_brightness < 0.35 {
        "Shared rule: low-key lighting and moody contrast define the visual language."
    } else {
        "Shared rule: balanced mid-tone lighting with controlled subject emphasis."
    }
    .to_string();
    let evidence = vec![
        json!({"image": "A", "note": "Primary subject remains visually dominant."}),
        json!({"image": "B", "note": "Composition keeps a readable center of gravity."}),
        json!({"image": "C", "note": "Lighting and color cadence reinforce the same mood."}),
    ];
    let annotations = vec![
        json!({"image": "A", "x": 0.50, "y": 0.46, "label": "dominant focal zone"}),
        json!({"image": "B", "x": 0.52, "y": 0.48, "label": "shared lighting cue"}),
        json!({"image": "C", "x": 0.49, "y": 0.45, "label": "composition anchor"}),
    ];
    TripletRuleOutput {
        principle,
        evidence,
        annotations,
        confidence: 0.71,
    }
}

#[derive(Debug, Clone)]
struct TripletOddOneOutOutput {
    odd_image: String,
    odd_index: i64,
    pattern: String,
    explanation: String,
    confidence: f64,
}

fn infer_triplet_odd_one_out(
    path_a: &Path,
    path_b: &Path,
    path_c: &Path,
) -> TripletOddOneOutOutput {
    let stats = vec![
        read_basic_image_stats(path_a),
        read_basic_image_stats(path_b),
        read_basic_image_stats(path_c),
    ];
    let means: Vec<(f64, f64, f64)> = stats
        .iter()
        .map(|row| {
            (
                row.as_ref().map(|v| v.mean_r).unwrap_or(128.0),
                row.as_ref().map(|v| v.mean_g).unwrap_or(128.0),
                row.as_ref().map(|v| v.mean_b).unwrap_or(128.0),
            )
        })
        .collect();
    let mut distances = [0.0f64; 3];
    for i in 0..3 {
        for j in 0..3 {
            if i == j {
                continue;
            }
            distances[i] += rgb_distance(means[i], means[j]);
        }
    }
    let mut odd_index = 0usize;
    let mut odd_value = distances[0];
    for (idx, value) in distances.iter().enumerate().skip(1) {
        if *value > odd_value {
            odd_value = *value;
            odd_index = idx;
        }
    }
    let odd_image = match odd_index {
        0 => "A",
        1 => "B",
        _ => "C",
    }
    .to_string();
    TripletOddOneOutOutput {
        odd_image,
        odd_index: odd_index as i64,
        pattern: "Two images share a closer color/lighting cadence and composition rhythm."
            .to_string(),
        explanation: "The odd frame deviates most in overall tonal signature, making it the outlier for the current set."
            .to_string(),
        confidence: 0.69,
    }
}

fn rgb_distance(a: (f64, f64, f64), b: (f64, f64, f64)) -> f64 {
    let dr = a.0 - b.0;
    let dg = a.1 - b.1;
    let db = a.2 - b.2;
    (dr * dr + dg * dg + db * db).sqrt()
}

#[derive(Debug, Clone)]
struct TextVisionInference {
    text: String,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
struct DescriptionVisionInference {
    description: String,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
struct DnaVisionInference {
    palette: Vec<String>,
    colors: Vec<String>,
    materials: Vec<String>,
    summary: String,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
struct SoulVisionInference {
    emotion: String,
    summary: String,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
struct TripletRuleVisionInference {
    principle: String,
    evidence: Vec<Value>,
    annotations: Vec<Value>,
    confidence: f64,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[derive(Debug, Clone)]
struct TripletOddOneOutVisionInference {
    odd_image: String,
    odd_index: i64,
    pattern: String,
    explanation: String,
    confidence: f64,
    source: String,
    model: Option<String>,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

#[allow(dead_code)]
#[derive(Debug, Clone)]
struct IntentIconsVisionInference {
    payload: Map<String, Value>,
    model: String,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
}

fn first_non_empty_env(keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Ok(value) = env::var(key) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

fn openai_api_key() -> Option<String> {
    first_non_empty_env(&["OPENAI_API_KEY", "OPENAI_API_KEY_BACKUP"])
}

fn openai_api_base() -> String {
    let raw = first_non_empty_env(&["OPENAI_API_BASE", "OPENAI_BASE_URL"])
        .unwrap_or_else(|| "https://api.openai.com/v1".to_string());
    let mut base = raw.trim().trim_end_matches('/').to_string();
    if let Ok(parsed) = reqwest::Url::parse(&base) {
        if parsed.path().trim().is_empty() || parsed.path() == "/" {
            base = format!("{base}/v1");
        }
    }
    base.trim_end_matches('/').to_string()
}

fn sanitize_openai_responses_model(raw: &str, default_model: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return default_model.to_string();
    }
    if trimmed.to_ascii_lowercase().contains("realtime") {
        return default_model.to_string();
    }
    trimmed.to_string()
}

fn openai_vision_request(
    model: &str,
    content: Vec<Value>,
    max_output_tokens: u64,
    timeout: Duration,
) -> Option<(String, Option<i64>, Option<i64>, String)> {
    let api_key = openai_api_key()?;
    let request_model = sanitize_openai_responses_model(model, "gpt-4o-mini");
    let endpoint = format!("{}/responses", openai_api_base());
    let payload = json!({
        "model": request_model,
        "input": [{
            "role": "user",
            "content": content,
        }],
        "max_output_tokens": max_output_tokens,
    });

    let client = HttpClient::builder().timeout(timeout).build().ok()?;
    let response = client
        .post(endpoint)
        .bearer_auth(api_key)
        .header(CONTENT_TYPE, "application/json")
        .json(&payload)
        .send()
        .ok()?;
    if !response.status().is_success() {
        return None;
    }

    let parsed: Value = response.json().ok()?;
    let text = extract_openai_output_text(&parsed);
    if text.trim().is_empty() {
        return None;
    }
    let (input_tokens, output_tokens) = extract_token_usage_pair(&parsed);
    Some((text, input_tokens, output_tokens, request_model))
}

fn prepare_vision_image_data_url(path: &Path, max_dim: u32) -> Option<String> {
    let (bytes, mime) = prepare_vision_image(path, max_dim)?;
    let encoded = BASE64.encode(bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

fn prepare_vision_image(path: &Path, max_dim: u32) -> Option<(Vec<u8>, String)> {
    let dim = max_dim.max(128);
    if let Ok(image) = image::open(path) {
        let rgba = image.to_rgba8();
        let mut flattened = RgbaImage::new(rgba.width(), rgba.height());
        for (x, y, pixel) in rgba.enumerate_pixels() {
            let alpha = u16::from(pixel[3]);
            let blend = |channel: u8| -> u8 {
                (((u16::from(channel) * alpha) + (255 * (255 - alpha))) / 255) as u8
            };
            flattened.put_pixel(
                x,
                y,
                Rgba([blend(pixel[0]), blend(pixel[1]), blend(pixel[2]), 255]),
            );
        }
        let resized = DynamicImage::ImageRgba8(flattened)
            .resize(dim, dim, FilterType::Triangle)
            .to_rgb8();
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 90);
        if encoder
            .encode_image(&DynamicImage::ImageRgb8(resized))
            .is_ok()
        {
            return Some((bytes, "image/jpeg".to_string()));
        }
    }

    let bytes = fs::read(path).ok()?;
    let mime = guess_image_mime(path).to_string();
    Some((bytes, mime))
}

fn guess_image_mime(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        _ => "image/png",
    }
}

fn extract_openai_output_text(response: &Value) -> String {
    if let Some(text) = response.get("output_text").and_then(Value::as_str) {
        if !text.trim().is_empty() {
            return text.trim().to_string();
        }
    }

    let mut parts: Vec<String> = Vec::new();
    let rows = response
        .get("output")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for row in rows {
        let Some(obj) = row.as_object() else {
            continue;
        };
        if let Some(kind) = obj.get("type").and_then(Value::as_str) {
            if matches!(kind, "output_text" | "text") {
                if let Some(text) = obj.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        parts.push(text.trim().to_string());
                    }
                }
                continue;
            }
            if kind != "message" {
                continue;
            }
        }
        let content = obj
            .get("content")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for chunk in content {
            let Some(chunk_obj) = chunk.as_object() else {
                continue;
            };
            let kind = chunk_obj
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !matches!(kind, "output_text" | "text") {
                continue;
            }
            if let Some(text) = chunk_obj.get("text").and_then(Value::as_str) {
                if !text.trim().is_empty() {
                    parts.push(text.trim().to_string());
                }
            }
        }
    }

    parts.join("\n").trim().to_string()
}

fn value_to_nonnegative_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => {
            if let Some(raw) = number.as_i64() {
                return (raw >= 0).then_some(raw);
            }
            if let Some(raw) = number.as_u64() {
                return i64::try_from(raw).ok();
            }
            None
        }
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                return None;
            }
            trimmed.parse::<i64>().ok().filter(|value| *value >= 0)
        }
        _ => None,
    }
}

fn read_usage_value(object: &Map<String, Value>, keys: &[&str]) -> Option<i64> {
    for key in keys {
        if let Some(value) = object.get(*key) {
            if let Some(parsed) = value_to_nonnegative_i64(value) {
                return Some(parsed);
            }
        }
    }
    None
}

fn extract_token_usage_pair(payload: &Value) -> (Option<i64>, Option<i64>) {
    fn walk(
        value: &Value,
        input_tokens: &mut Option<i64>,
        output_tokens: &mut Option<i64>,
        depth: usize,
    ) {
        if depth > 16 || (input_tokens.is_some() && output_tokens.is_some()) {
            return;
        }
        match value {
            Value::Object(object) => {
                let maybe_input = read_usage_value(
                    object,
                    &[
                        "input_tokens",
                        "prompt_tokens",
                        "prompt_token_count",
                        "promptTokenCount",
                        "tokens_in",
                        "tokensIn",
                        "inputTokenCount",
                        "input_text_tokens",
                        "text_count_tokens",
                    ],
                );
                if input_tokens.is_none() && maybe_input.is_some() {
                    *input_tokens = maybe_input;
                }
                let maybe_output = read_usage_value(
                    object,
                    &[
                        "output_tokens",
                        "completion_tokens",
                        "completion_token_count",
                        "completionTokenCount",
                        "tokens_out",
                        "tokensOut",
                        "outputTokenCount",
                        "output_text_tokens",
                        "candidates_token_count",
                        "candidatesTokenCount",
                    ],
                );
                if output_tokens.is_none() && maybe_output.is_some() {
                    *output_tokens = maybe_output;
                }

                if output_tokens.is_none() {
                    let total_tokens = read_usage_value(
                        object,
                        &[
                            "total_token_count",
                            "totalTokenCount",
                            "total_tokens",
                            "totalTokens",
                            "token_count",
                            "tokenCount",
                        ],
                    );
                    if let (Some(total), Some(input)) = (total_tokens, *input_tokens) {
                        if total >= input {
                            *output_tokens = Some(total - input);
                        }
                    }
                }

                for nested_key in ["usage", "usage_metadata"] {
                    if let Some(nested) = object.get(nested_key) {
                        walk(nested, input_tokens, output_tokens, depth + 1);
                    }
                }
                for nested in object.values() {
                    walk(nested, input_tokens, output_tokens, depth + 1);
                }
            }
            Value::Array(items) => {
                for item in items {
                    walk(item, input_tokens, output_tokens, depth + 1);
                }
            }
            _ => {}
        }
    }

    let mut input_tokens = None;
    let mut output_tokens = None;
    walk(payload, &mut input_tokens, &mut output_tokens, 0);
    (input_tokens, output_tokens)
}

fn clean_text_inference(text: &str, max_chars: Option<usize>) -> String {
    let mut cleaned = text.trim().to_string();
    if cleaned.is_empty() {
        return String::new();
    }
    if let Some(limit) = max_chars {
        if limit > 0 && cleaned.chars().count() > limit {
            cleaned = cleaned
                .chars()
                .take(limit)
                .collect::<String>()
                .trim()
                .to_string();
        }
    }
    cleaned
}

fn is_aux_verb_token(token: &str) -> bool {
    matches!(token, "is" | "are" | "was" | "were")
}

fn is_article_token(token: &str) -> bool {
    matches!(token, "a" | "an" | "the")
}

fn token_starts_uppercase(token: &str) -> bool {
    token
        .chars()
        .next()
        .map(|ch| ch.is_uppercase())
        .unwrap_or(false)
}

fn compact_caption_phrase(text: &str) -> String {
    let mut tokens: Vec<String> = text
        .split_whitespace()
        .map(|token| token.trim().to_string())
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return String::new();
    }

    while tokens
        .first()
        .map(|token| is_article_token(token.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
        && tokens.len() > 1
    {
        tokens.remove(0);
    }

    // Prefer fragment-style labels over full sentences (e.g. "X is holding Y" -> "X holding Y").
    if tokens.len() >= 3 {
        let second = tokens[1].to_ascii_lowercase();
        if is_aux_verb_token(second.as_str()) {
            tokens.remove(1);
        } else if tokens.len() >= 4 {
            let third = tokens[2].to_ascii_lowercase();
            if is_aux_verb_token(third.as_str())
                && token_starts_uppercase(tokens[0].as_str())
                && token_starts_uppercase(tokens[1].as_str())
            {
                tokens.remove(2);
            }
        }
    }

    if tokens.len() >= 3 {
        let mut aux_idx: Option<usize> = None;
        for idx in 1..(tokens.len() - 1) {
            let current = tokens[idx].to_ascii_lowercase();
            if !is_aux_verb_token(current.as_str()) {
                continue;
            }
            let next = tokens[idx + 1].to_ascii_lowercase();
            if next.ends_with("ing")
                || matches!(
                    next.as_str(),
                    "holding"
                        | "dribbling"
                        | "wearing"
                        | "standing"
                        | "sitting"
                        | "running"
                        | "jumping"
                        | "walking"
                        | "looking"
                        | "smiling"
                )
            {
                aux_idx = Some(idx);
                break;
            }
        }
        if let Some(idx) = aux_idx {
            tokens.remove(idx);
        }
    }

    if tokens.len() > 2 {
        let last_idx = tokens.len().saturating_sub(1);
        tokens = tokens
            .into_iter()
            .enumerate()
            .filter_map(|(idx, token)| {
                let lower = token.to_ascii_lowercase();
                if idx > 0 && idx < last_idx && is_aux_verb_token(lower.as_str()) {
                    None
                } else if idx > 0 && is_article_token(lower.as_str()) {
                    None
                } else {
                    Some(token)
                }
            })
            .collect();
    }

    if let Some(last) = tokens.last() {
        let lower = last.to_ascii_lowercase();
        if matches!(lower.as_str(), "looks" | "look" | "appears" | "seems") {
            let _ = tokens.pop();
        }
    }

    tokens.join(" ").trim().to_string()
}

fn clean_description(text: &str, max_chars: usize) -> String {
    let mut cleaned = text.trim().to_string();
    if cleaned.is_empty() {
        return String::new();
    }

    let lower = cleaned.to_ascii_lowercase();
    for prefix in ["description:", "label:", "caption:"] {
        if lower.starts_with(prefix) {
            cleaned = cleaned[prefix.len()..].trim().to_string();
            break;
        }
    }

    cleaned = cleaned
        .trim_matches('"')
        .trim_matches('\'')
        .replace(['\r', '\n', '\t'], " ");
    cleaned = cleaned.split_whitespace().collect::<Vec<&str>>().join(" ");
    cleaned = cleaned
        .trim()
        .trim_matches(|ch: char| matches!(ch, '"' | '\''))
        .trim_end_matches(|ch: char| matches!(ch, '.' | ',' | ':' | ';'))
        .trim()
        .to_string();
    if cleaned.is_empty() {
        return String::new();
    }

    let lowered = cleaned.to_ascii_lowercase();
    for prefix in [
        "a photo of ",
        "photo of ",
        "an image of ",
        "image of ",
        "a picture of ",
        "picture of ",
    ] {
        if let Some(rest) = lowered.strip_prefix(prefix) {
            let split_at = cleaned.len().saturating_sub(rest.len());
            cleaned = cleaned[split_at..].trim().to_string();
            break;
        }
    }

    cleaned = compact_caption_phrase(&cleaned);
    if cleaned.is_empty() {
        return String::new();
    }

    cleaned = cleaned.split_whitespace().collect::<Vec<&str>>().join(" ");
    if cleaned.chars().count() > max_chars {
        cleaned = cleaned.chars().take(max_chars + 1).collect::<String>();
        if let Some((head, _)) = cleaned.rsplit_once(' ') {
            cleaned = head.trim().to_string();
        }
        if cleaned.chars().count() > max_chars {
            cleaned = cleaned.chars().take(max_chars).collect();
        }
    }
    cleaned.trim().to_string()
}

fn strip_code_fence(text: &str) -> String {
    let raw = text.trim();
    if !(raw.starts_with("```") && raw.ends_with("```")) {
        return raw.to_string();
    }
    let lines: Vec<&str> = raw.lines().collect();
    if lines.len() < 2 {
        return raw.to_string();
    }
    let mut body = lines[1..lines.len() - 1].join("\n").trim().to_string();
    if body.to_ascii_lowercase().starts_with("json") {
        body = body[4..].trim().to_string();
    }
    body
}

fn extract_json_object_from_text(text: &str) -> Option<Map<String, Value>> {
    let raw = strip_code_fence(text);
    if raw.trim().is_empty() {
        return None;
    }
    let mut candidates = vec![raw.clone()];
    if let (Some(start), Some(end)) = (raw.find('{'), raw.rfind('}')) {
        if end > start {
            candidates.push(raw[start..=end].to_string());
        }
    }
    for candidate in candidates {
        if let Ok(parsed) = serde_json::from_str::<Value>(&candidate) {
            if let Some(object) = parsed.as_object() {
                return Some(object.clone());
            }
        }
    }
    None
}

fn coerce_text_list(value: Option<&Value>, max_items: usize, max_chars: usize) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };
    let mut raw_items: Vec<String> = Vec::new();
    match value {
        Value::Array(rows) => {
            for row in rows {
                if let Some(text) = row.as_str() {
                    raw_items.push(text.to_string());
                }
            }
        }
        Value::String(text) => {
            raw_items.extend(text.split(',').map(str::to_string));
        }
        _ => {}
    }

    let mut cleaned = Vec::new();
    let mut seen = Vec::new();
    for row in raw_items {
        let mut text = row.split_whitespace().collect::<Vec<&str>>().join(" ");
        text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        if text.chars().count() > max_chars {
            text = text
                .chars()
                .take(max_chars)
                .collect::<String>()
                .trim()
                .to_string();
        }
        let key = text.to_ascii_lowercase();
        if seen.iter().any(|existing| existing == &key) {
            continue;
        }
        seen.push(key);
        cleaned.push(text);
        if cleaned.len() >= max_items {
            break;
        }
    }
    cleaned
}

fn normalize_hex_color(value: &str) -> Option<String> {
    let raw = value.trim();
    if !raw.starts_with('#') {
        return None;
    }
    let mut body = raw.trim_start_matches('#').to_string();
    if body.len() == 3 && body.chars().all(|ch| ch.is_ascii_hexdigit()) {
        body = body
            .chars()
            .flat_map(|ch| [ch, ch])
            .collect::<String>()
            .to_ascii_uppercase();
    }
    if body.len() != 6 || !body.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some(format!("#{}", body.to_ascii_uppercase()))
}

fn parse_dna_payload(
    payload: &Map<String, Value>,
) -> Option<(Vec<String>, Vec<String>, Vec<String>, String)> {
    let palette_raw = coerce_text_list(payload.get("palette"), 8, 12);
    let mut palette = Vec::new();
    for row in palette_raw {
        if let Some(code) = normalize_hex_color(&row) {
            if !palette.contains(&code) {
                palette.push(code);
            }
        }
    }
    let colors = coerce_text_list(payload.get("colors"), 8, 42);
    let materials = coerce_text_list(payload.get("materials"), 8, 42);
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .map(|value| clean_text_inference(value, Some(180)))
        .unwrap_or_default();
    let summary = if summary.is_empty() {
        let color_part = if colors.is_empty() {
            "the extracted palette".to_string()
        } else {
            colors
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<String>>()
                .join(", ")
        };
        let material_part = if materials.is_empty() {
            "the extracted materials".to_string()
        } else {
            materials
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<String>>()
                .join(", ")
        };
        format!("Rebuild with {color_part} and {material_part}.")
    } else {
        summary
    };
    if palette.is_empty() && colors.is_empty() && materials.is_empty() {
        return None;
    }
    Some((palette, colors, materials, summary))
}

fn parse_soul_payload(payload: &Map<String, Value>) -> Option<(String, String)> {
    let raw_emotion = payload
        .get("emotion")
        .and_then(Value::as_str)
        .or_else(|| payload.get("primary_emotion").and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let emotion = clean_text_inference(&raw_emotion, Some(64));
    if emotion.is_empty() {
        return None;
    }
    let summary = payload
        .get("summary")
        .and_then(Value::as_str)
        .map(|value| clean_text_inference(value, Some(180)))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("Make the scene emotionally {emotion}."));
    Some((emotion, summary))
}

fn build_labeled_image_content(
    labels_and_paths: &[(&str, &Path)],
    instruction: &str,
    max_dim: u32,
) -> Option<Vec<Value>> {
    let mut content = Vec::new();
    for (label, path) in labels_and_paths {
        if !label.trim().is_empty() {
            content.push(json!({
                "type": "input_text",
                "text": *label,
            }));
        }
        let data_url = prepare_vision_image_data_url(path, max_dim)?;
        content.push(json!({
            "type": "input_image",
            "image_url": data_url,
        }));
    }
    content.push(json!({
        "type": "input_text",
        "text": instruction,
    }));
    Some(content)
}

fn description_realtime_instruction() -> &'static str {
    "Describe the image as one short caption fragment (<=40 chars), not a full sentence. Use noun-phrase style like 'LeBron James holding basketball'. Do not use auxiliary verbs like is/are/was/were. Return only the caption."
}

fn description_instruction(max_chars: usize) -> String {
    format!(
        "Write one concise computer-vision caption fragment for the attached image (<= {max_chars} characters). Use noun-phrase style, not a full sentence. Avoid auxiliary verbs (is/are/was/were) and avoid leading articles when possible. If a person or character is confidently recognizable, use the proper name (example: 'Michael Jordan holding basketball'). Otherwise use a concrete visual subject plus one discriminator (action, garment, color, material, viewpoint, or composition cue). Do not infer sports team/franchise from jersey colors alone; only mention a team when text/logo is clearly readable. No hedging. No questions. No extra commentary. Output ONLY the caption."
    )
}

fn diagnose_instruction() -> &'static str {
    "Diagnose this image like an honest creative director.\nDo NOT describe the image. Diagnose what's working and what isn't, using specific visual evidence.\nWrite in plain, easy English. Short lines. Lots of whitespace. No jargon.\nThink like a tiny council first:\n1) Art director (taste, composition)\n2) Commercial lens (clarity, conversion)\nThen write ONE merged answer.\n\nIf it looks like a product photo meant to sell something, judge it as a product shot (lighting, background, crop, color accuracy, reflections/shadows, edge cutout quality, legibility).\nOtherwise, judge it by the most likely use case (ad, poster, UI, editorial, etc).\n\nFormat (keep under ~180 words):\nUSE CASE (guess): <product shot | ad | poster | UI | editorial | other>\n\nTOP ISSUE:\n<one sentence>\n\nWHAT'S WORKING:\n- <2-4 bullets>\n\nWHAT TO FIX NEXT:\n- <3-5 bullets>\n\nNEXT TEST:\n- <2 bullets>\n\nRules: keep bullets to one line each. Be concrete about composition/hierarchy, focal point, color, lighting, depth, typography/legibility (if present), and realism/materials. No generic praise."
}

fn canvas_context_instruction() -> &'static str {
    canvas_context_realtime_instruction()
}

fn argue_instruction() -> &'static str {
    "Argue between two creative directions based on Image A and Image B.\nYou are not neutral: make the strongest case for each, using specific visual evidence.\nWrite in plain, easy English. Short lines. Lots of whitespace. No jargon.\nIf these are product shots, judge them as product shots; otherwise use the most likely use case.\n\nFormat (keep under ~220 words):\nIMAGE A WINS IF:\n- <3-5 bullets>\n\nIMAGE B WINS IF:\n- <3-5 bullets>\n\nMY PICK:\n<A or B> — <one sentence>\n\nWHY:\n<2-3 short sentences>\n\nNEXT TEST:\n- <2 bullets>\n"
}

fn dna_extract_instruction() -> &'static str {
    "Extract this image's visual DNA for transfer.\nFocus only on COLORS and MATERIALS that are visually dominant.\nRespond with JSON only (no markdown):\n{\n  \"palette\": [\"#RRGGBB\", \"...\"],\n  \"colors\": [\"short color phrases\"],\n  \"materials\": [\"short material phrases\"],\n  \"summary\": \"one short sentence for edit transfer\"\n}\nRules: 3-8 palette entries. 2-8 colors. 2-8 materials. Summary must be <= 16 words and directly usable in an edit instruction."
}

fn soul_extract_instruction() -> &'static str {
    "Extract this image's dominant emotional soul.\nRespond with JSON only (no markdown):\n{\n  \"emotion\": \"single dominant emotion phrase\",\n  \"summary\": \"one short sentence for edit transfer\"\n}\nRules: emotion should be concise and concrete (e.g., serene tension, triumphant warmth). Summary must be <= 14 words and directly usable in an edit instruction."
}

fn triplet_rule_instruction() -> &'static str {
    "You are an elite creative director. You will be shown three images: Image A, Image B, Image C.\nYour job: identify the ONE consistent design rule the user is applying across all three.\n\nReturn JSON ONLY with this schema:\n{\n  \"principle\": \"<one sentence rule>\",\n  \"evidence\": [\n    {\"image\": \"A\", \"note\": \"<short concrete visual evidence>\"},\n    {\"image\": \"B\", \"note\": \"<short concrete visual evidence>\"},\n    {\"image\": \"C\", \"note\": \"<short concrete visual evidence>\"}\n  ],\n  \"annotations\": [\n    {\"image\": \"A\", \"x\": 0.0, \"y\": 0.0, \"label\": \"<what to look at>\"},\n    {\"image\": \"B\", \"x\": 0.0, \"y\": 0.0, \"label\": \"<what to look at>\"},\n    {\"image\": \"C\", \"x\": 0.0, \"y\": 0.0, \"label\": \"<what to look at>\"}\n  ],\n  \"confidence\": 0.0\n}\n\nRules:\n- x and y are fractions in [0,1] relative to the image (0,0 top-left).\n- Keep annotations to 0-6 total points; omit the field or use [] if unsure.\n- No markdown, no prose outside JSON, no trailing commas."
}

fn odd_one_out_instruction() -> &'static str {
    "You are curating a mood board. You will be shown three images: Image A, Image B, Image C.\nTwo images share a pattern. One breaks it.\n\nReturn JSON ONLY with this schema:\n{\n  \"odd_image\": \"A\",\n  \"pattern\": \"<one short paragraph describing what A/B share>\",\n  \"explanation\": \"<why the odd one breaks it, concrete visual reasons>\",\n  \"confidence\": 0.0\n}\n\nRules:\n- odd_image MUST be exactly \"A\", \"B\", or \"C\".\n- No markdown, no prose outside JSON, no trailing commas."
}

fn intent_icons_instruction(mother: bool) -> String {
    let base = r#"You are a realtime Canvas-to-Intent Icon Engine.

ROLE
Observe a live visual canvas where users place images.
Your job is NOT to explain intent, guess motivation, or ask questions.
Your job is to surface the user's intent as a set of clear, human-legible ICONS for image generation.

HARD CONSTRAINTS
- Output JSON only. No prose. No user-facing text.
- The JSON must be syntactically valid (single top-level object).
- Communicate intent exclusively through icons, spatial grouping, highlights, and branching lanes.
- Never infer or expose "why".
- If uncertain, present multiple icon paths rather than choosing one.

INPUT SIGNALS
You receive:
- A CANVAS SNAPSHOT image (may contain multiple user images placed spatially).
- An optional CONTEXT_ENVELOPE_JSON (input text) that is authoritative for:
  - canvas size
  - per-image positions/sizes/order
  - per-image vision_desc labels (optional): short, noisy phrases derived from the images (not user text)
  - intent round index and remaining time (timer_enabled/rounds_enabled may be false)
  - prior user selections (YES/NO/MAYBE) by branch
- Optional SOURCE_IMAGE_REFERENCE inputs (high-res) for one or more canvas images.

INTERPRETATION RULES
- Treat images as signals of intent, not meaning.
- If vision_desc labels are present in CONTEXT_ENVELOPE_JSON.images[], treat them as weak hints only.
- If SOURCE_IMAGE_REFERENCE inputs are present, prioritize them for identity/detail disambiguation.
- Placement implies structure:
  - Left-to-right = flow
  - Top-to-bottom = hierarchy
  - Clusters = coupling
  - Isolation = emphasis
  - Relative size = emphasis/importance

OUTPUT GOAL
Continuously emit a minimal, evolving set of INTENT ICONS that describe:
1) WHAT kind of system/action the user is assembling
2) HOW they are choosing to act on that system

ICON TAXONOMY (STRICT)
Use only these icon_id values:

Core
- IMAGE_GENERATION
- OUTPUTS
- ITERATION
- PIPELINE

Use Cases (branch lanes)
- GAME_DEV_ASSETS
- STREAMING_CONTENT
- UI_UX_PROTOTYPING
- ECOMMERCE_POD
- CONTENT_ENGINE

Asset Types
- CONCEPT_ART
- SPRITES
- TEXTURES
- CHARACTER_SHEETS
- THUMBNAILS
- OVERLAYS
- EMOTES
- SOCIAL_GRAPHICS
- SCREENS
- WIREFRAMES
- MOCKUPS
- USER_FLOWS
- MERCH_DESIGN
- PRODUCT_PHOTOS
- MARKETPLACE_LISTINGS
- BRAND_SYSTEM
- MULTI_CHANNEL

Signatures
- MIXED_FIDELITY
- VOLUME
- OUTCOMES
- STRUCTURED
- SINGULAR
- PHYSICAL_OUTPUT
- PROCESS
- AUTOMATION

Relations
- FLOW
- DEPENDENCY
- FEEDBACK

Checkpoints
- YES_TOKEN
- NO_TOKEN
- MAYBE_TOKEN

BRANCH IDS (PREFERRED)
- game_dev_assets
- streaming_content
- uiux_prototyping
- ecommerce_pod
- content_engine

TRANSFORMATION MODES (FOR MOTHER PROPOSALS)
Choose exactly one primary mode from this enum:
- amplify: Push the current composition into a cinematic crescendo.
- transcend: Lift the scene into a more transcendent visual world.
- destabilize: Shift the composition toward controlled visual instability.
- purify: Simplify geometry and light into a calm sculptural image.
- hybridize: Fuse the current references into one coherent composition.
- mythologize: Recast the scene as mythic visual storytelling.
- monumentalize: Turn the scene into a monumental hero composition.
- fracture: Introduce intentional fracture and expressive disruption.
- romanticize: Infuse the composition with intimate emotional warmth.
- alienate: Reframe the scene with uncanny, otherworldly distance.
Also provide 1-3 ranked alternatives with confidences.

OUTPUT FORMAT (STRICT JSON)
{
  "frame_id": "<input frame id>",
  "schema": "brood.intent_icons",
  "schema_version": 1,
  "transformation_mode": "<one mode from enum>",
  "transformation_mode_candidates": [
    {
      "mode": "<one mode from enum>",
      "confidence": 0.0
    }
  ],
  "image_descriptions": [
    {
      "image_id": "<from CONTEXT_ENVELOPE_JSON.images[].id>",
      "label": "<CV caption fragment, <=40 chars, concrete and specific>",
      "confidence": 0.0
    }
  ],
  "intent_icons": [
    {
      "icon_id": "<from taxonomy>",
      "confidence": 0.0,
      "position_hint": "primary"
    }
  ],
  "relations": [
    {
      "from_icon": "<icon_id>",
      "to_icon": "<icon_id>",
      "relation_type": "FLOW"
    }
  ],
  "branches": [
    {
      "branch_id": "<id>",
      "confidence": 0.0,
      "icons": ["GAME_DEV_ASSETS", "SPRITES", "ITERATION"],
      "lane_position": "left",
      "evidence_image_ids": ["<image_id>"]
    }
  ],
  "checkpoint": {
    "icons": ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"],
    "applies_to": "<branch_id or icon cluster>"
  }
}

BEHAVIOR RULES
- Always maintain one primary intent cluster and 1-3 alternative clusters.
- Always try to fill image_descriptions for each image in CONTEXT_ENVELOPE_JSON.images[].
- Emit exactly one image_descriptions row per CONTEXT_ENVELOPE_JSON.images[].id when available.
- Preserve CONTEXT_ENVELOPE_JSON.images[] id order in image_descriptions.
- Never swap labels across image_id values.
- transformation_mode must be one of the 10 enum values above.
- transformation_mode_candidates should include the primary mode and be sorted by confidence DESC.
- Include branches[].confidence in [0.0, 1.0] and sort branches by confidence DESC.
- checkpoint.applies_to should match the highest-confidence branch_id.
- evidence_image_ids should reference CONTEXT_ENVELOPE_JSON.images[].id (0-3 ids).
- image_descriptions labels must use neutral computer-vision caption style.
- Keep labels short and concrete. `A photo of ...` is acceptable but not required.
- If a person or character is confidently recognizable, use the proper name (for example: "Michael Jordan holding a basketball").
- Prefer identifiable names over generic role nouns; avoid labels like "basketball player holding ball" when a confident identity is available.
- Do not infer team/franchise identity from jersey color alone; only mention a team when text/logo evidence is clearly visible.
- If not identifiable by name, use a concrete visual subject + one discriminator (action, garment, color, material, viewpoint, or composition cue).
- Avoid generic placeholders like "portrait photo", "object image", "person picture".
- Do not hedge ("appears to", "looks like"), ask questions, or add commentary.
- Keep labels concise and distinctive; omit minor details if needed to stay within the char budget.
- Do not copy visible text; avoid brand names.
- Do not collapse ambiguity too early.
- Start broad with use-case lanes; add Asset Types and Signatures as evidence accumulates.
- Increase specificity only after YES_TOKEN is applied.
- After NO_TOKEN, deprioritize that branch and propose another alternative.
- The icons must be understandable without explanation, language, or onboarding.

SAFETY
- Do not emit intent icons for illegal or deceptive systems.
- Do not produce impersonation or identity abuse flows.
- Keep all intent representations general-purpose and constructive.

Return JSON only."#;
    if mother {
        return format!(
            "MODE\nYou are in Mother proposal mode for Brood.\nOptimization target: stunningly awe-inspiring and joyous + novel.\nYou must maximize visual wow while preserving coherence and subject identity.\n\nMOTHER CONTEXT RULES\n- CONTEXT_ENVELOPE_JSON.mother_context is authoritative when present.\n- Treat mother_context.creative_directive and mother_context.optimization_target as hard steering.\n- Prefer transformation modes that are novel relative to mother_context.recent_rejected_modes_for_context.\n- Avoid repeating mother_context.last_accepted_mode unless confidence improvement is substantial.\n- Use mother_context.selected_ids and mother_context.active_id to prioritize evidence_image_ids.\n- Use images[].origin to balance uploaded references with mother-generated continuity.\n- For 2+ images, prefer coherent fusion over collage and preserve a single camera/lighting world.\n- Keep anti-artifact behavior conservative: avoid ghosting, duplication, and interface residue.\n\nReturn the same strict JSON schema contract as the default intent engine.\n\n{}",
            base
        );
    }
    base.to_string()
}

fn vision_description_realtime_model() -> String {
    let value = first_non_empty_env(&[
        "BROOD_DESCRIBE_REALTIME_MODEL",
        "OPENAI_DESCRIBE_REALTIME_MODEL",
    ])
    .unwrap_or_else(|| "gpt-realtime-mini".to_string());
    normalize_realtime_model_name(&value, "gpt-realtime-mini")
}

fn vision_infer_description_realtime(
    path: &Path,
    max_chars: usize,
) -> Option<DescriptionVisionInference> {
    let api_key = openai_api_key()?;
    let model = vision_description_realtime_model();
    if model.trim().is_empty() {
        return None;
    }
    let data_url = read_image_as_data_url(path)?;
    let mut ws = open_realtime_websocket(&model, &api_key).ok()?;
    let _ = websocket_send_json(
        &mut ws,
        &json!({
            "type": "session.update",
            "session": {
                "modalities": ["text"],
            },
        }),
    );
    let request = json!({
        "type": "response.create",
        "response": {
            "conversation": "none",
            "modalities": ["text"],
            "input": [{
                "type": "message",
                "role": "user",
                "content": [
                    {"type": "input_text", "text": description_realtime_instruction()},
                    {"type": "input_image", "image_url": data_url},
                ],
            }],
            "max_output_tokens": 120,
        },
    });
    if websocket_send_json(&mut ws, &request).is_err() {
        let _ = ws.close(None);
        return None;
    }

    let mut buffer = String::new();
    let mut response_id: Option<String> = None;
    let started = Instant::now();
    while started.elapsed().as_secs_f64() <= 60.0 {
        let message = match ws.read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(err))
                if matches!(err.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                continue;
            }
            Err(_) => {
                let _ = ws.close(None);
                return None;
            }
        };
        let raw = match message {
            WsMessage::Text(text) => text.to_string(),
            WsMessage::Binary(bytes) => String::from_utf8_lossy(&bytes).to_string(),
            WsMessage::Ping(_) | WsMessage::Pong(_) => continue,
            WsMessage::Close(_) => {
                let _ = ws.close(None);
                return None;
            }
            _ => continue,
        };
        let parsed: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let event_type = parsed
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        if event_type == "error" {
            let _ = ws.close(None);
            return None;
        }
        if event_type == "response.created" {
            if let Some(id) = parsed
                .get("response")
                .and_then(Value::as_object)
                .and_then(|row| row.get("id"))
                .and_then(Value::as_str)
            {
                response_id = Some(id.to_string());
            }
            continue;
        }
        if event_type == "response.output_text.delta" {
            let delta = parsed
                .get("delta")
                .and_then(Value::as_str)
                .or_else(|| parsed.get("text").and_then(Value::as_str))
                .unwrap_or_default();
            if !delta.is_empty() {
                buffer = append_stream_delta(&buffer, delta);
            }
            continue;
        }
        if event_type == "response.output_text.done" {
            if let Some(text) = parsed
                .get("text")
                .and_then(Value::as_str)
                .or_else(|| parsed.get("output_text").and_then(Value::as_str))
            {
                if !text.is_empty() {
                    buffer = merge_stream_text(&buffer, text);
                }
            }
            continue;
        }
        if event_type == "response.done" {
            let response = parsed.get("response").cloned().unwrap_or(Value::Null);
            if let Some(expected) = response_id.as_ref() {
                let actual = response
                    .as_object()
                    .and_then(|row| row.get("id"))
                    .and_then(Value::as_str);
                if actual.is_some() && actual != Some(expected.as_str()) {
                    continue;
                }
            }
            let (text, _) = resolve_streamed_response_text(&buffer, &response);
            let cleaned = clean_description(&text, max_chars);
            if cleaned.trim().is_empty() {
                let _ = ws.close(None);
                return None;
            }
            let (input_tokens, output_tokens) = extract_token_usage_pair(&response);
            let model_name = response
                .as_object()
                .and_then(|row| row.get("model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .or_else(|| Some(model.clone()));
            let _ = ws.close(None);
            return Some(DescriptionVisionInference {
                description: cleaned,
                source: "openai_realtime_describe".to_string(),
                model: model_name,
                input_tokens,
                output_tokens,
            });
        }
    }
    let _ = ws.close(None);
    None
}

fn vision_infer_description(path: &Path, max_chars: usize) -> Option<DescriptionVisionInference> {
    if let Some(inference) = vision_infer_description_realtime(path, max_chars) {
        return Some(inference);
    }
    let requested = first_non_empty_env(&["BROOD_DESCRIBE_MODEL", "OPENAI_DESCRIBE_MODEL"])
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let mut models = vec![requested.clone()];
    if requested != "gpt-5-nano" {
        models.push("gpt-5-nano".to_string());
    }
    let data_url = prepare_vision_image_data_url(path, 1024)?;
    for model in models {
        let content = vec![
            json!({"type": "input_text", "text": description_instruction(max_chars)}),
            json!({"type": "input_image", "image_url": data_url.clone()}),
        ];
        let result = openai_vision_request(&model, content, 120, Duration::from_secs_f64(22.0));
        let Some((text, input_tokens, output_tokens, model_name)) = result else {
            continue;
        };
        let cleaned = clean_description(&text, max_chars);
        if cleaned.is_empty() {
            continue;
        }
        return Some(DescriptionVisionInference {
            description: cleaned,
            source: "openai_vision".to_string(),
            model: Some(model_name),
            input_tokens,
            output_tokens,
        });
    }
    None
}

fn vision_infer_diagnosis(path: &Path) -> Option<TextVisionInference> {
    let model = first_non_empty_env(&["BROOD_DIAGNOSE_MODEL", "OPENAI_DIAGNOSE_MODEL"])
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let data_url = prepare_vision_image_data_url(path, 1024)?;
    let content = vec![
        json!({"type": "input_text", "text": diagnose_instruction()}),
        json!({"type": "input_image", "image_url": data_url}),
    ];
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 900, Duration::from_secs_f64(45.0))?;
    let cleaned = clean_text_inference(&text, Some(8000));
    if cleaned.is_empty() {
        return None;
    }
    Some(TextVisionInference {
        text: cleaned,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

fn vision_infer_canvas_context(
    path: &Path,
    requested_model: Option<String>,
) -> Option<TextVisionInference> {
    let model_raw = requested_model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            first_non_empty_env(&["BROOD_CANVAS_CONTEXT_MODEL", "OPENAI_CANVAS_CONTEXT_MODEL"])
        })
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let requested = sanitize_openai_responses_model(&model_raw, "gpt-4o-mini");
    let mut models = vec![requested.clone()];
    if requested != "gpt-4o-mini" {
        models.push("gpt-4o-mini".to_string());
    }
    let data_url = prepare_vision_image_data_url(path, 768)?;
    for model in models {
        let content = vec![
            json!({"type": "input_text", "text": canvas_context_instruction()}),
            json!({"type": "input_image", "image_url": data_url.clone()}),
        ];
        let result = openai_vision_request(&model, content, 520, Duration::from_secs_f64(28.0));
        let Some((text, input_tokens, output_tokens, model_name)) = result else {
            continue;
        };
        let cleaned = clean_text_inference(&text, Some(12000));
        if cleaned.is_empty() {
            continue;
        }
        return Some(TextVisionInference {
            text: cleaned,
            source: "openai_vision".to_string(),
            model: Some(model_name),
            input_tokens,
            output_tokens,
        });
    }
    None
}

fn vision_infer_argument(path_a: &Path, path_b: &Path) -> Option<TextVisionInference> {
    let model = first_non_empty_env(&["BROOD_ARGUE_MODEL", "OPENAI_ARGUE_MODEL"])
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let content = build_labeled_image_content(
        &[("Image A:", path_a), ("Image B:", path_b)],
        argue_instruction(),
        1024,
    )?;
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 1100, Duration::from_secs_f64(55.0))?;
    let cleaned = clean_text_inference(&text, Some(10000));
    if cleaned.is_empty() {
        return None;
    }
    Some(TextVisionInference {
        text: cleaned,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

fn vision_infer_dna_signature(path: &Path) -> Option<DnaVisionInference> {
    let model = first_non_empty_env(&["BROOD_DNA_VISION_MODEL", "OPENAI_DNA_MODEL"])
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let data_url = prepare_vision_image_data_url(path, 1024)?;
    let content = vec![
        json!({"type": "input_text", "text": dna_extract_instruction()}),
        json!({"type": "input_image", "image_url": data_url}),
    ];
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 380, Duration::from_secs_f64(35.0))?;
    let payload = extract_json_object_from_text(&text)?;
    let (palette, colors, materials, summary) = parse_dna_payload(&payload)?;
    Some(DnaVisionInference {
        palette,
        colors,
        materials,
        summary,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

fn vision_infer_soul_signature(path: &Path) -> Option<SoulVisionInference> {
    let model = first_non_empty_env(&["BROOD_SOUL_VISION_MODEL", "OPENAI_SOUL_MODEL"])
        .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let data_url = prepare_vision_image_data_url(path, 1024)?;
    let content = vec![
        json!({"type": "input_text", "text": soul_extract_instruction()}),
        json!({"type": "input_image", "image_url": data_url}),
    ];
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 240, Duration::from_secs_f64(35.0))?;
    let payload = extract_json_object_from_text(&text)?;
    let (emotion, summary) = parse_soul_payload(&payload)?;
    Some(SoulVisionInference {
        emotion,
        summary,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

fn parse_triplet_rule_payload(
    payload: &Map<String, Value>,
) -> Option<(String, Vec<Value>, Vec<Value>, f64)> {
    let principle = payload
        .get("principle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?
        .to_string();
    let mut evidence: Vec<Value> = Vec::new();
    for row in payload
        .get("evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let image = obj
            .get("image")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_uppercase())
            .filter(|value| matches!(value.as_str(), "A" | "B" | "C"));
        let note = obj
            .get("note")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let (Some(image), Some(note)) = (image, note) {
            evidence.push(json!({
                "image": image,
                "note": note,
            }));
        }
    }
    let mut annotations: Vec<Value> = Vec::new();
    for row in payload
        .get("annotations")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let image = obj
            .get("image")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_uppercase())
            .filter(|value| matches!(value.as_str(), "A" | "B" | "C"));
        let x = obj.get("x").and_then(Value::as_f64);
        let y = obj.get("y").and_then(Value::as_f64);
        if let (Some(image), Some(x), Some(y)) = (image, x, y) {
            if !(0.0..=1.0).contains(&x) || !(0.0..=1.0).contains(&y) {
                continue;
            }
            let label = obj
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            annotations.push(json!({
                "image": image,
                "x": x,
                "y": y,
                "label": label,
            }));
        }
    }
    let confidence = payload
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(0.72);
    Some((principle, evidence, annotations, confidence))
}

fn vision_infer_triplet_rule(
    path_a: &Path,
    path_b: &Path,
    path_c: &Path,
) -> Option<TripletRuleVisionInference> {
    let model = first_non_empty_env(&[
        "BROOD_EXTRACT_RULE_MODEL",
        "OPENAI_EXTRACT_RULE_MODEL",
        "BROOD_DIAGNOSE_MODEL",
        "OPENAI_DIAGNOSE_MODEL",
    ])
    .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let content = build_labeled_image_content(
        &[
            ("Image A:", path_a),
            ("Image B:", path_b),
            ("Image C:", path_c),
        ],
        triplet_rule_instruction(),
        1024,
    )?;
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 850, Duration::from_secs_f64(60.0))?;
    let payload = extract_json_object_from_text(&text)?;
    let (principle, evidence, annotations, confidence) = parse_triplet_rule_payload(&payload)?;
    Some(TripletRuleVisionInference {
        principle,
        evidence,
        annotations,
        confidence,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

fn parse_triplet_odd_payload(
    payload: &Map<String, Value>,
) -> Option<(String, i64, String, String, f64)> {
    let odd_image = payload
        .get("odd_image")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_ascii_uppercase())
        .filter(|value| matches!(value.as_str(), "A" | "B" | "C"))?;
    let odd_index = if odd_image == "A" {
        0
    } else if odd_image == "B" {
        1
    } else {
        2
    };
    let pattern = payload
        .get("pattern")
        .and_then(Value::as_str)
        .map(|value| clean_text_inference(value, Some(4000)))
        .unwrap_or_default();
    let explanation = payload
        .get("explanation")
        .and_then(Value::as_str)
        .map(|value| clean_text_inference(value, Some(4000)))
        .unwrap_or_default();
    if pattern.is_empty() && explanation.is_empty() {
        return None;
    }
    let confidence = payload
        .get("confidence")
        .and_then(Value::as_f64)
        .filter(|value| (0.0..=1.0).contains(value))
        .unwrap_or(0.72);
    Some((odd_image, odd_index, pattern, explanation, confidence))
}

fn vision_infer_triplet_odd_one_out(
    path_a: &Path,
    path_b: &Path,
    path_c: &Path,
) -> Option<TripletOddOneOutVisionInference> {
    let model = first_non_empty_env(&[
        "BROOD_ODD_ONE_OUT_MODEL",
        "OPENAI_ODD_ONE_OUT_MODEL",
        "BROOD_ARGUE_MODEL",
        "OPENAI_ARGUE_MODEL",
    ])
    .unwrap_or_else(|| "gpt-4o-mini".to_string());
    let content = build_labeled_image_content(
        &[
            ("Image A:", path_a),
            ("Image B:", path_b),
            ("Image C:", path_c),
        ],
        odd_one_out_instruction(),
        1024,
    )?;
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(&model, content, 850, Duration::from_secs_f64(60.0))?;
    let payload = extract_json_object_from_text(&text)?;
    let (odd_image, odd_index, pattern, explanation, confidence) =
        parse_triplet_odd_payload(&payload)?;
    Some(TripletOddOneOutVisionInference {
        odd_image,
        odd_index,
        pattern,
        explanation,
        confidence,
        source: "openai_vision".to_string(),
        model: Some(model_name),
        input_tokens,
        output_tokens,
    })
}

#[allow(dead_code)]
fn normalize_intent_icons_payload(
    mut payload: Map<String, Value>,
    frame_id: &str,
) -> Map<String, Value> {
    payload
        .entry("schema".to_string())
        .or_insert_with(|| Value::String("brood.intent_icons".to_string()));
    payload
        .entry("schema_version".to_string())
        .or_insert_with(|| Value::Number(1.into()));
    payload
        .entry("frame_id".to_string())
        .or_insert_with(|| Value::String(frame_id.to_string()));
    if !payload
        .get("intent_icons")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        payload.insert("intent_icons".to_string(), Value::Array(Vec::new()));
    }
    if !payload
        .get("relations")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        payload.insert("relations".to_string(), Value::Array(Vec::new()));
    }
    if !payload
        .get("branches")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        payload.insert("branches".to_string(), Value::Array(Vec::new()));
    }
    if !payload
        .get("checkpoint")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        let applies_to = payload
            .get("branches")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(Value::as_object)
            .and_then(|row| row.get("branch_id"))
            .cloned()
            .unwrap_or(Value::Null);
        payload.insert(
            "checkpoint".to_string(),
            json!({
                "icons": ["YES_TOKEN", "NO_TOKEN", "MAYBE_TOKEN"],
                "applies_to": applies_to,
            }),
        );
    }
    payload
}

#[allow(dead_code)]
fn vision_infer_intent_icons_payload(
    path: &Path,
    mother: bool,
    model_hint: &str,
) -> Option<IntentIconsVisionInference> {
    let data_url = prepare_vision_image_data_url(path, 1024)?;
    let content = vec![
        json!({"type": "input_text", "text": intent_icons_instruction(mother)}),
        json!({"type": "input_image", "image_url": data_url}),
    ];
    let (text, input_tokens, output_tokens, model_name) =
        openai_vision_request(model_hint, content, 1200, Duration::from_secs_f64(40.0))?;
    let payload = extract_json_object_from_text(&text)?;
    let frame_id = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("frame");
    let payload = normalize_intent_icons_payload(payload, frame_id);
    Some(IntentIconsVisionInference {
        payload,
        model: model_name,
        input_tokens,
        output_tokens,
    })
}

fn run_native_recreate_loop(
    engine: &mut NativeEngine,
    reference_path: &Path,
    quality_preset: &str,
    images_per_iteration: u64,
) -> Result<Map<String, Value>> {
    if !reference_path.exists() {
        bail!("reference file not found ({})", reference_path.display());
    }

    let (base_prompt, prompt_source, caption_model) = infer_recreate_prompt(reference_path);
    engine.emit_event(
        "recreate_prompt_inferred",
        json_object(json!({
            "reference": reference_path.to_string_lossy().to_string(),
            "prompt": base_prompt,
            "source": prompt_source,
            "model": caption_model,
        })),
    )?;

    let mut prompt = base_prompt.clone();
    let mut best_artifact: Option<Map<String, Value>> = None;
    let mut best_score = 0.0f64;
    let mut iterations_run = 0i64;
    let mut failure: Option<String> = None;

    for iteration in 1..=3 {
        iterations_run = iteration;
        let mut settings = chat_settings(quality_preset);
        settings.insert(
            "n".to_string(),
            Value::Number(images_per_iteration.max(1).into()),
        );
        settings.insert(
            "reference_images".to_string(),
            Value::Array(vec![Value::String(
                reference_path.to_string_lossy().to_string(),
            )]),
        );

        let mut recreate_intent = Map::new();
        recreate_intent.insert("action".to_string(), Value::String("recreate".to_string()));
        recreate_intent.insert(
            "reference".to_string(),
            Value::String(reference_path.to_string_lossy().to_string()),
        );
        recreate_intent.insert("iteration".to_string(), Value::Number(iteration.into()));
        recreate_intent.insert(
            "base_prompt".to_string(),
            Value::String(base_prompt.clone()),
        );
        recreate_intent.insert(
            "prompt_source".to_string(),
            Value::String(prompt_source.clone()),
        );
        recreate_intent.insert(
            "caption_model".to_string(),
            caption_model
                .as_ref()
                .map(|value| Value::String(value.clone()))
                .unwrap_or(Value::Null),
        );

        let artifacts = match engine.generate(&prompt, settings, recreate_intent) {
            Ok(artifacts) => artifacts,
            Err(err) => {
                failure = Some(err.to_string());
                break;
            }
        };

        for artifact in artifacts {
            let image_path = artifact
                .get("image_path")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let receipt_path = artifact
                .get("receipt_path")
                .and_then(Value::as_str)
                .map(PathBuf::from);
            let Some(image_path) = image_path else {
                continue;
            };

            let similarity = match compare_similarity(reference_path, &image_path) {
                Ok(similarity) => similarity,
                Err(err) => {
                    failure = Some(err.to_string());
                    break;
                }
            };

            if let Some(receipt_path) = receipt_path {
                if let Err(err) = write_similarity_to_receipt(&receipt_path, &similarity) {
                    failure = Some(err.to_string());
                    break;
                }
            }

            let overall = similarity
                .get("overall")
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let mut enriched = artifact.clone();
            enriched.insert("similarity".to_string(), Value::Object(similarity));
            if best_artifact.is_none() || overall > best_score {
                best_score = overall;
                best_artifact = Some(enriched);
            }
        }

        if failure.is_some() {
            break;
        }

        let best_artifact_id = best_artifact
            .as_ref()
            .and_then(|artifact| artifact.get("artifact_id"))
            .cloned()
            .unwrap_or(Value::Null);
        engine.emit_event(
            "recreate_iteration_update",
            json_object(json!({
                "iteration": iteration,
                "similarity": best_score,
                "best_artifact_id": best_artifact_id,
            })),
        )?;

        if best_score >= 0.8 {
            break;
        }
        prompt = format!("{prompt} Refine to better match the reference image.")
            .trim()
            .to_string();
    }

    let best_artifact_id = best_artifact
        .as_ref()
        .and_then(|artifact| artifact.get("artifact_id"))
        .cloned()
        .unwrap_or(Value::Null);
    engine.emit_event(
        "recreate_done",
        json_object(json!({
            "reference": reference_path.to_string_lossy().to_string(),
            "best_artifact_id": best_artifact_id,
            "best_score": best_score,
            "iterations": iterations_run,
            "success": failure.is_none(),
            "error": failure,
        })),
    )?;

    if let Some(err) = failure {
        bail!(err);
    }

    let mut out = Map::new();
    out.insert(
        "best".to_string(),
        best_artifact.map(Value::Object).unwrap_or(Value::Null),
    );
    out.insert("best_score".to_string(), json!(best_score));
    out.insert("inferred_prompt".to_string(), Value::String(base_prompt));
    out.insert("prompt_source".to_string(), Value::String(prompt_source));
    out.insert(
        "caption_model".to_string(),
        caption_model.map(Value::String).unwrap_or(Value::Null),
    );
    Ok(out)
}

fn infer_recreate_prompt(reference_path: &Path) -> (String, String, Option<String>) {
    if let Some((prompt, model)) = infer_prompt_from_receipts(reference_path) {
        return (prompt, "receipt".to_string(), model);
    }
    let file_name = reference_path
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("reference image")
        .to_string();
    (
        format!("Recreate an image similar to {file_name}."),
        "fallback".to_string(),
        None,
    )
}

fn infer_prompt_from_receipts(reference_path: &Path) -> Option<(String, Option<String>)> {
    let parent = reference_path.parent()?;
    let target = reference_path.to_string_lossy().to_string();
    let canonical_target = fs::canonicalize(reference_path).ok();

    let entries = fs::read_dir(parent).ok()?;
    for entry in entries {
        let entry = entry.ok()?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("");
        if !file_name.starts_with("receipt-") {
            continue;
        }
        let payload = read_json_object(&path)?;
        let image_path = payload
            .get("artifacts")
            .and_then(Value::as_object)
            .and_then(|row| row.get("image_path"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let same_path = if image_path == target {
            true
        } else if let (Some(expected), Ok(actual)) =
            (canonical_target.as_ref(), fs::canonicalize(&image_path))
        {
            actual == *expected
        } else {
            false
        };
        if !same_path {
            continue;
        }
        let prompt = payload
            .get("request")
            .and_then(Value::as_object)
            .and_then(|row| row.get("prompt"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)?;
        let model = payload
            .get("resolved")
            .and_then(Value::as_object)
            .and_then(|row| row.get("model"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        return Some((prompt, model));
    }
    None
}

fn compare_similarity(reference: &Path, candidate: &Path) -> Result<Map<String, Value>> {
    let dh_ref = dhash64(reference)?;
    let dh_can = dhash64(candidate)?;
    let dh_score = score_hash(dh_ref, dh_can, 64);

    let ph_ref = ahash64(reference)?;
    let ph_can = ahash64(candidate)?;
    let ph_score = score_hash(ph_ref, ph_can, 64);

    let overall = ((dh_score + ph_score) / 2.0).clamp(0.0, 1.0);
    Ok(json_object(json!({
        "dhash": dh_score,
        "phash": ph_score,
        "overall": overall,
    })))
}

fn dhash64(path: &Path) -> Result<u64> {
    let resized = image::open(path)
        .with_context(|| format!("failed to read image for dhash ({})", path.display()))?
        .resize_exact(9, 8, FilterType::Triangle)
        .to_luma8();
    let mut value = 0u64;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let left = resized.get_pixel(x, y)[0];
            let right = resized.get_pixel(x + 1, y)[0];
            value = (value << 1) | if left > right { 1 } else { 0 };
        }
    }
    Ok(value)
}

fn ahash64(path: &Path) -> Result<u64> {
    let resized = image::open(path)
        .with_context(|| format!("failed to read image for ahash ({})", path.display()))?
        .resize_exact(8, 8, FilterType::Triangle)
        .to_luma8();
    let mut sum = 0u64;
    for pixel in resized.pixels() {
        sum += pixel[0] as u64;
    }
    let avg = (sum as f64 / 64.0).clamp(0.0, 255.0);
    let mut value = 0u64;
    for y in 0..8u32 {
        for x in 0..8u32 {
            let sample = resized.get_pixel(x, y)[0] as f64;
            value = (value << 1) | if sample > avg { 1 } else { 0 };
        }
    }
    Ok(value)
}

fn score_hash(left: u64, right: u64, bits: u32) -> f64 {
    let distance = (left ^ right).count_ones() as f64;
    (1.0 - (distance / bits as f64)).clamp(0.0, 1.0)
}

fn write_similarity_to_receipt(receipt_path: &Path, similarity: &Map<String, Value>) -> Result<()> {
    let Some(mut payload) = read_json_value(receipt_path) else {
        return Ok(());
    };
    let Some(root) = payload.as_object_mut() else {
        return Ok(());
    };
    let meta = root
        .entry("result_metadata".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    if !meta.is_object() {
        *meta = Value::Object(Map::new());
    }
    if let Some(meta_obj) = meta.as_object_mut() {
        meta_obj.insert("similarity".to_string(), Value::Object(similarity.clone()));
    }
    write_json_value(receipt_path, &payload)?;
    Ok(())
}

fn export_html_native(run_dir: &Path, out_path: &Path) -> Result<()> {
    let thread_path = run_dir.join("thread.json");
    let versions = read_json_value(&thread_path)
        .and_then(|value| {
            value
                .as_object()
                .and_then(|obj| obj.get("versions"))
                .and_then(Value::as_array)
                .cloned()
        })
        .unwrap_or_default();

    let mut cards = String::new();
    for version in versions {
        let Some(version_obj) = version.as_object() else {
            continue;
        };
        let prompt = version_obj
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let version_id = version_obj
            .get("version_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let artifacts = version_obj
            .get("artifacts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for artifact in artifacts {
            let Some(artifact_obj) = artifact.as_object() else {
                continue;
            };
            let image_src = artifact_obj
                .get("image_path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let receipt_src = artifact_obj
                .get("receipt_path")
                .and_then(Value::as_str)
                .unwrap_or_default();
            cards.push_str(&format!(
                "<div class='card'><div class='thumb'><img src='{image_src}' alt='artifact'></div><div class='meta'><div class='vid'>{version_id}</div><div class='prompt'>{prompt}</div><div class='links'><a href='{receipt_src}'>receipt</a></div></div></div>",
                image_src = escape_html(image_src),
                version_id = escape_html(version_id),
                prompt = escape_html(prompt),
                receipt_src = escape_html(receipt_src),
            ));
        }
    }

    let html_doc = format!(
        "<!doctype html>\n<html>\n<head>\n  <meta charset='utf-8'>\n  <title>Brood Export</title>\n  <style>\n    body {{ font-family: Arial, sans-serif; background: #f6f6f6; margin: 0; padding: 20px; }}\n    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }}\n    .card {{ background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }}\n    .thumb {{ width: 100%; height: 200px; background: #eee; display: flex; align-items: center; justify-content: center; }}\n    .thumb img {{ max-width: 100%; max-height: 100%; }}\n    .meta {{ padding: 10px; }}\n    .vid {{ font-weight: bold; font-size: 12px; color: #444; }}\n    .prompt {{ font-size: 13px; margin: 8px 0; }}\n    .links a {{ font-size: 12px; color: #0066cc; text-decoration: none; }}\n  </style>\n</head>\n<body>\n  <h1>Brood Run Export</h1>\n  <div class='grid'>\n    {cards}\n  </div>\n</body>\n</html>\n"
    );

    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(out_path, html_doc)?;
    Ok(())
}

fn escape_html(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
    out
}

fn value_as_non_empty_string(value: Option<&Value>) -> Option<String> {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

fn action_to_command_name(action: &str) -> Option<String> {
    match action {
        "set_profile" => Some("profile".to_string()),
        "set_text_model" => Some("text_model".to_string()),
        "set_image_model" => Some("image_model".to_string()),
        "set_quality" => Some("quality".to_string()),
        "set_active_image" => Some("use".to_string()),
        "help" | "generate" | "unknown" | "noop" => None,
        other => Some(other.to_string()),
    }
}

fn json_object(value: Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        active_image_for_edit_prompt, build_realtime_websocket_request, clean_description,
        description_realtime_instruction, intent_icons_instruction,
        intent_realtime_reference_image_limit, is_anyhow_realtime_transport_error,
        is_edit_style_prompt, RealtimeJobError, RealtimeJobErrorKind, RealtimeSessionKind,
        REALTIME_BETA_HEADER_VALUE, REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_MAX,
    };
    use std::io;
    use std::time::{SystemTime, UNIX_EPOCH};
    use std::{env, fs};

    #[test]
    fn realtime_ws_request_includes_upgrade_headers() {
        let request =
            build_realtime_websocket_request("gpt-realtime-mini", "test-api-key").unwrap();
        let uri = request.uri().to_string();
        let headers = request.headers();

        assert!(
            uri.contains("/realtime?model=gpt-realtime-mini"),
            "unexpected realtime uri: {uri}"
        );
        assert!(headers.contains_key("sec-websocket-key"));
        assert_eq!(
            headers.get("upgrade").and_then(|v| v.to_str().ok()),
            Some("websocket")
        );
        assert!(headers
            .get("connection")
            .and_then(|v| v.to_str().ok())
            .map(|v| v.to_ascii_lowercase().contains("upgrade"))
            .unwrap_or(false));
        assert_eq!(
            headers.get("authorization").and_then(|v| v.to_str().ok()),
            Some("Bearer test-api-key")
        );
        assert_eq!(
            headers.get("openai-beta").and_then(|v| v.to_str().ok()),
            Some(REALTIME_BETA_HEADER_VALUE)
        );
    }

    #[test]
    fn intent_icons_instruction_enforces_cv_caption_style_labels() {
        let instruction = intent_icons_instruction(false);
        assert!(instruction.contains("computer-vision caption style"));
        assert!(instruction.contains("<=40 chars"));
        assert!(instruction.contains("A photo of ...` is acceptable but not required"));
        assert!(instruction.contains("use the proper name"));
        assert!(instruction.contains("Do not hedge (\"appears to\", \"looks like\")"));
    }

    #[test]
    fn intent_icons_per_request_hint_enforces_cv_caption_style() {
        let hint = RealtimeSessionKind::IntentIcons { mother: false }
            .per_request_input_text()
            .unwrap_or_default();
        assert!(hint.contains("computer-vision caption style"));
        assert!(hint.contains("<= 40 characters"));
        assert!(hint.contains("use the proper name"));
        assert!(hint.contains("Avoid generic role labels like 'basketball player'"));
        assert!(hint.contains("Do not mirror generic vision_desc hints"));
        assert!(hint.contains("Return strict JSON only"));
    }

    #[test]
    fn clean_description_does_not_force_photo_prefix() {
        assert_eq!(
            clean_description("Basketball player portrait.", 64),
            "Basketball player portrait"
        );
        assert_eq!(
            clean_description("image of Michael Jordan holding a basketball", 64),
            "Michael Jordan holding basketball"
        );
        assert_eq!(
            clean_description("LeBron James is holding a basketball.", 64),
            "LeBron James holding basketball"
        );
        assert_eq!(
            clean_description(
                "A basketball player in a yellow Lakers jersey is holding a ball.",
                64
            ),
            "basketball player in yellow Lakers jersey holding ball"
        );
        assert_eq!(
            clean_description("Basketball player is in a yellow jersey.", 64),
            "Basketball player in yellow jersey"
        );
    }

    #[test]
    fn description_realtime_instruction_matches_probe_style() {
        let instruction = description_realtime_instruction();
        assert!(instruction.contains("short caption fragment"));
        assert!(instruction.contains("<=40 chars"));
        assert!(instruction.contains("not a full sentence"));
        assert!(instruction.contains("Do not use auxiliary verbs"));
    }

    #[test]
    fn realtime_transport_error_uses_typed_chain_classification() {
        let broken_pipe = anyhow::Error::new(tungstenite::Error::Io(io::Error::new(
            io::ErrorKind::BrokenPipe,
            "broken pipe",
        )));
        assert!(is_anyhow_realtime_transport_error(&broken_pipe));
        let typed = RealtimeJobError::from_anyhow(broken_pipe);
        assert_eq!(typed.kind, RealtimeJobErrorKind::Transport);

        let timeout_message = anyhow::anyhow!("Realtime intent inference timed out.");
        assert!(!is_anyhow_realtime_transport_error(&timeout_message));
        let typed_timeout = RealtimeJobError::from_anyhow(timeout_message);
        assert_eq!(typed_timeout.kind, RealtimeJobErrorKind::Terminal);
    }

    #[test]
    fn intent_realtime_reference_limit_has_default_and_bounds() {
        let value = intent_realtime_reference_image_limit();
        assert!(value >= 1);
        assert!(value <= REALTIME_INTENT_REFERENCE_IMAGE_LIMIT_MAX);
    }

    #[test]
    fn edit_style_prompt_detection_only_matches_edit_and_replace_heads() {
        assert!(is_edit_style_prompt(
            "edit the image: isolate subject and keep dimensions"
        ));
        assert!(is_edit_style_prompt(
            "  REPLACE the background with pure white and preserve logos"
        ));
        assert!(!is_edit_style_prompt("editors choice cinematic portrait"));
        assert!(!is_edit_style_prompt("generate a brand new scene"));
    }

    #[test]
    fn active_image_for_edit_prompt_requires_existing_file() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let test_path = env::temp_dir().join(format!("brood-cli-edit-path-{stamp}.png"));
        fs::write(&test_path, b"test").unwrap();
        let test_path_text = test_path.to_string_lossy().to_string();

        let matched = active_image_for_edit_prompt(
            "replace the background with seamless white",
            Some(&test_path_text),
        );
        assert_eq!(matched, Some(test_path_text.clone()));
        assert_eq!(
            active_image_for_edit_prompt("generate a city skyline at dusk", Some(&test_path_text)),
            None
        );
        assert_eq!(
            active_image_for_edit_prompt(
                "edit the image: remove people",
                Some("/tmp/does-not-exist-brood-cli.png")
            ),
            None
        );

        let _ = fs::remove_file(test_path);
    }
}
