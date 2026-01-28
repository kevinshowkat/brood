#!/usr/bin/env python3
"""PARAM FORGE: interactive terminal UI for multi-provider image generation + receipts.

Usage:
  python scripts/param_forge.py \
    --provider openai --size portrait --n 1 --out outputs/param_forge
  python scripts/param_forge.py batch-run \
    --prompts prompts.txt --matrix matrix.yaml --out runs/food_glam_v1
  python scripts/param_forge.py --interactive
  python scripts/param_forge.py --defaults

Notes:
- Loads .env from the repo root.
- Uses the bundled provider adapters (OpenAI, Gemini, Imagen, Flux).
"""

from __future__ import annotations

import argparse
import base64
import copy
import contextlib
import csv
import html
import io
import itertools
import json
import math
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from dataclasses import dataclass
from pathlib import Path
import getpass
import locale
import os
import shutil
import subprocess
import termios
import tty

try:
    from dotenv import load_dotenv  # type: ignore
except Exception:  # pragma: no cover
    load_dotenv = None  # type: ignore

FIXED_PROMPT = (
    "Generate an image of a California brown pelican riding a bicycle. "
    "The bicycle must have spokes and a correctly shaped bicycle frame. "
    "The pelican must have its characteristic large pouch, and there should be a clear indication of feathers. "
    "The pelican must clearly be pedaling the bicycle. "
    "The image should show the full breeding plumage of the Californian brown pelican."
)
DEFAULT_PROMPTS = [FIXED_PROMPT]
PROVIDER_CHOICES = ["openai", "google", "black forest labs"]
MODEL_CHOICES_BY_PROVIDER = {
    "openai": ["gpt-image-1.5", "gpt-image-1-mini", "gpt-image-1"],
    "gemini": ["gemini-2.5-flash-image", "gemini-3-pro-image-preview"],
    "imagen": ["imagen-4.0-ultra", "imagen-4"],
    "flux": ["flux-2-flex", "flux-2-pro", "flux-2"],
}
SIZE_CHOICES = [
    ("4:5", "4:5 (Instagram feed)"),
    ("9:16", "9:16 (Stories/Reels/TikTok/Shorts)"),
    ("square", "1:1 (Square)"),
    ("1.91:1", "1.91:1 (LinkedIn link preview)"),
    ("16:9", "16:9 (YouTube/landscape)"),
    ("3:4", "3:4 (Portrait)"),
    ("2:3", "2:3 (Photo)"),
    ("portrait", "portrait"),
    ("landscape", "landscape"),
    ("1024x1024", "1024x1024"),
    ("1024x1536", "1024x1536"),
    ("1536x1024", "1536x1024"),
]
OUT_DIR_CHOICES = ["outputs/param_forge", "outputs/param_forge_dated"]
_API_COMMON_PARAMS: list[tuple[str, str]] = [
    ("prompt", "Text prompt describing the image."),
    ("size", "Aspect ratio / resolution. Cost: larger sizes usually cost more."),
    ("n", "Images per prompt. Cost: scales linearly with n."),
    ("model", "Model name override. Cost: model dependent."),
    ("output_format", "jpeg/png/webp output. PNG can increase payload size."),
    ("seed", "Deterministic seed (if supported)."),
    ("background", "Background mode (OpenAI only)."),
]
_API_PROVIDER_PARAMS: dict[str, list[tuple[str, str]]] = {
    "openai": [
        ("provider_options.quality", "Quality tier (low/medium/high). Cost: higher tiers cost more."),
        ("provider_options.moderation", "Moderation setting."),
        ("provider_options.input_fidelity", "Input fidelity for edits."),
        ("provider_options.output_compression", "Compression for non-PNG outputs."),
        (
            "provider_options.use_responses",
            "Use Responses API instead of images endpoint (aka openai_use_responses). Cost: may differ by API path.",
        ),
        (
            "provider_options.responses_model",
            "Responses model override (aka openai_responses_model). Cost: model dependent.",
        ),
    ],
    "gemini": [
        ("provider_options.image_size", "Size tier hint (1K/2K/4K). Cost: higher tiers cost more."),
        ("provider_options.safety_settings", "Safety config overrides."),
    ],
    "imagen": [
        ("provider_options.image_size", "Size tier hint (1K/2K/4K). Cost: higher tiers cost more."),
        ("provider_options.add_watermark", "Add watermark (true/false)."),
        ("provider_options.person_generation", "People generation policy."),
    ],
    "flux": [
        ("provider_options.endpoint", "BFL endpoint selector. Cost: depends on endpoint."),
        ("provider_options.url", "Explicit endpoint URL. Cost: depends on endpoint."),
        ("provider_options.model", "Model/endpoint alias. Cost: depends on endpoint."),
        ("provider_options.prompt_upsampling", "Prompt upsampling. Cost: may increase latency."),
        ("provider_options.guidance", "Guidance scale. Cost: may increase latency/compute."),
        ("provider_options.steps", "Diffusion steps. Cost: may increase latency/compute."),
        ("provider_options.safety_tolerance", "Safety tolerance."),
        ("provider_options.poll_interval", "Polling cadence (seconds)."),
        ("provider_options.poll_timeout", "Polling timeout (seconds)."),
        ("provider_options.request_timeout", "HTTP request timeout (seconds)."),
        ("provider_options.download_timeout", "HTTP download timeout (seconds)."),
    ],
}
_EXPERIMENT_SCHEMA_VERSION = 1
_EXPERIMENT_BUDGET_MODES = ("estimate", "strict", "off")
_EXPERIMENT_DEFAULT_CONCURRENCY = 3
_EXPERIMENT_MAX_RETRIES = 1
_EXPERIMENT_PARAM_KEYS = ("provider", "model", "size", "seed", "n", "output_format", "background")
_EXPERIMENT_LOG_SUPPRESS = (
    "Both GOOGLE_API_KEY and GEMINI_API_KEY are set. Using GOOGLE_API_KEY.",
)


def _provider_display_label(provider: str) -> str:
    provider_key = provider.strip().lower()
    if provider_key == "google":
        return "google (gemini/imagen)"
    if provider_key in {"black forest labs", "bfl", "flux"}:
        return "black forest labs (flux)"
    return provider


def _provider_display_choices() -> list[str]:
    return [_provider_display_label(choice) for choice in PROVIDER_CHOICES]


def _provider_from_display(label: str) -> str:
    mapping = {_provider_display_label(choice): choice for choice in PROVIDER_CHOICES}
    return mapping.get(label, label)

_BANNER = [
    "██████╗  █████╗ ██████╗  █████╗ ███╗   ███╗",
    "██╔══██╗██╔══██╗██╔══██╗██╔══██╗████╗ ████║",
    "██████╔╝███████║██████╔╝███████║██╔████╔██║",
    "██╔═══╝ ██╔══██║██╔══██╗██╔══██║██║╚██╔╝██║",
    "██║     ██║  ██║██║  ██║██║  ██║██║ ╚═╝ ██║",
    "╚═╝     ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝",
    "███████╗  ██████╗  ██████╗   ██████╗  ███████╗",
    "██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝ ██╔════╝",
    "█████╗   ██║   ██║ ██████╔╝ ██║  ███╗█████╗  ",
    "██╔══╝   ██║   ██║ ██╔══██╗ ██║   ██║██╔══╝  ",
    "██║      ╚██████╔╝ ██║  ██║ ╚██████╔╝███████╗",
    "╚═╝       ╚═════╝  ╚═╝  ╚═╝  ╚═════╝ ╚══════╝",
]
_VERSION_CURRENT = ("v0.6.1", "START")
_VERSION_HISTORY = [
    ("v0.6.0", "START"),
    ("v0.5.0", "The Colonel"),
    ("v0.4.0", "Pilot"),
]
_MIN_CURSES_WIDTH = max(40, max(len(line) for line in _BANNER))
_MIN_CURSES_HEIGHT = max(12, len(_BANNER) + 4)


class _CursesFallback(RuntimeError):
    pass


def _find_repo_dotenv() -> Path | None:
    if load_dotenv is None:
        return None
    current = Path(__file__).resolve()
    for parent in (current.parent, *current.parents):
        dotenv_path = parent / ".env"
        if dotenv_path.exists():
            return dotenv_path
    return None


def _load_repo_dotenv() -> Path | None:
    dotenv_path = _find_repo_dotenv()
    if load_dotenv is None:
        return dotenv_path
    if dotenv_path is not None:
        load_dotenv(dotenv_path=dotenv_path, override=False)
        return dotenv_path
    load_dotenv(override=False)
    return None


def _env_flag(name: str) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return False
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _history_base_dir() -> Path:
    return Path.home() / HISTORY_DIR_NAME


def _history_config_path() -> Path:
    return _history_base_dir() / HISTORY_CONFIG_FILE


def _history_log_path() -> Path:
    return _history_base_dir() / HISTORY_LOG_FILE


def _load_history_config() -> dict:
    path = _history_config_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return payload if isinstance(payload, dict) else {}


def _save_history_config(config: dict) -> None:
    path = _history_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(config)
    payload.setdefault("schema_version", HISTORY_SCHEMA_VERSION)
    payload["updated_at"] = _utc_iso_now()
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass


def _history_opt_in_value() -> bool | None:
    raw = os.getenv(HISTORY_OPT_IN_ENV)
    if raw is not None:
        return _env_flag(HISTORY_OPT_IN_ENV)
    config = _load_history_config()
    value = config.get("history_opt_in")
    if isinstance(value, bool):
        return value
    return None


def _persist_history_opt_in(value: bool) -> None:
    try:
        config = _load_history_config()
        config["history_opt_in"] = bool(value)
        _save_history_config(config)
    except Exception:
        return


def _new_history_session_id() -> str:
    return f"{_utc_iso_now()}-{uuid.uuid4().hex[:8]}"


def _load_history_records(max_records: int | None = None) -> list[dict]:
    path = _history_log_path()
    if not path.exists():
        return []
    records: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                raw = line.strip()
                if not raw:
                    continue
                try:
                    payload = json.loads(raw)
                except Exception:
                    continue
                if isinstance(payload, dict):
                    records.append(payload)
    except Exception:
        return []
    if max_records is not None and max_records > 0 and len(records) > max_records:
        records = records[-max_records:]
    return records


def _trim_history_records(path: Path, max_records: int) -> None:
    if max_records <= 0 or not path.exists():
        return
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return
    if len(lines) <= max_records:
        return
    trimmed = lines[-max_records:]
    path.write_text("\n".join(trimmed) + "\n", encoding="utf-8")


def _append_history_record(record: dict) -> None:
    path = _history_log_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=True) + "\n")
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    _trim_history_records(path, HISTORY_MAX_RECORDS)


def _history_record_date(value: object) -> str:
    if isinstance(value, str) and len(value) >= 10:
        return value[:10]
    return "unknown-date"


def _history_goals_match(stored: object, desired: list[str] | None) -> bool:
    if not desired:
        return True
    if isinstance(stored, list):
        stored_set = {str(item) for item in stored}
        return any(goal in stored_set for goal in desired)
    return False


def _history_provider_match(stored: object, provider: str | None, model: str | None) -> bool:
    if not provider:
        return True
    provider_key, _ = _normalize_provider_and_model(provider, model)
    stored_provider = str(stored or "").strip().lower()
    if not stored_provider:
        return False
    return stored_provider == provider_key


def _history_model_match(stored: object, model: str | None) -> bool:
    if not model:
        return True
    stored_model = str(stored or "").strip().lower()
    if not stored_model:
        return False
    return stored_model == str(model).strip().lower()


def _format_history_record_line(record: dict) -> str:
    date_label = _history_record_date(record.get("created_at"))
    settings_line = record.get("settings_line")
    if not isinstance(settings_line, str):
        settings = record.get("settings")
        if isinstance(settings, dict):
            settings_line = _format_call_settings_line(settings)
        else:
            settings_line = "(no settings)"
    metrics = record.get("metrics") if isinstance(record.get("metrics"), dict) else {}
    parts = [date_label, str(settings_line)]
    if isinstance(metrics, dict):
        cost_line = metrics.get("cost_line")
        cost_text = _strip_cost_prefix(cost_line) if isinstance(cost_line, str) else None
        elapsed = metrics.get("elapsed_sec")
        if cost_text:
            parts.append(f"cost {cost_text}")
        if isinstance(elapsed, (int, float)):
            parts.append(f"{elapsed:.1f}s")
        adherence = metrics.get("adherence")
        quality = metrics.get("quality")
        retrieval = metrics.get("retrieval_score")
        if isinstance(adherence, int):
            parts.append(f"adh {adherence}")
        if isinstance(quality, int):
            parts.append(f"qual {quality}")
        if isinstance(retrieval, (int, float)):
            parts.append(f"retr {retrieval}")
    return " | ".join(parts)


def _build_local_history_text(
    *,
    provider: str,
    model: str | None,
    user_goals: list[str] | None,
    exclude_session_id: str | None,
    limit: int | None = None,
) -> str | None:
    if limit is None:
        limit = HISTORY_PROMPT_LIMIT
    records = _load_history_records(max_records=HISTORY_MAX_RECORDS)
    if not records:
        return None
    filtered: list[dict] = []
    for record in records:
        if record.get("mode") not in {None, "optimize"}:
            continue
        if exclude_session_id and record.get("session_id") == exclude_session_id:
            continue
        if not _history_provider_match(record.get("provider"), provider, model):
            continue
        if model and not _history_model_match(record.get("model"), model):
            continue
        if not _history_goals_match(record.get("goals"), user_goals):
            continue
        filtered.append(record)
    if not filtered:
        return None
    subset = list(reversed(filtered[-limit:]))
    lines = [_format_history_record_line(entry) for entry in subset]
    return "\n".join(lines).strip() if lines else None


def _build_history_record(
    *,
    session_id: str | None,
    round_index: int,
    provider: str,
    model: str | None,
    size: str,
    n: int,
    settings: dict[str, object] | None,
    user_goals: list[str] | None,
    user_notes: str | None,
    recommendation: object,
    accepted: bool,
    elapsed: float | None,
    cost_line: str | None,
    adherence: int | None,
    quality: int | None,
    retrieval: int | None,
) -> dict:
    settings_payload = dict(settings) if isinstance(settings, dict) else {}
    record = {
        "schema_version": HISTORY_SCHEMA_VERSION,
        "created_at": _utc_iso_now(),
        "mode": "optimize",
        "session_id": session_id,
        "round": round_index,
        "provider": provider,
        "model": model,
        "size": size,
        "n": n,
        "goals": list(user_goals) if user_goals else [],
        "notes": user_notes or "",
        "settings": settings_payload,
        "settings_line": _format_call_settings_line(settings_payload),
        "metrics": {
            "elapsed_sec": elapsed,
            "cost_line": cost_line,
            "cost_per_image_usd": _parse_cost_amount(cost_line),
            "adherence": adherence,
            "quality": quality,
            "retrieval_score": retrieval,
        },
        "recommendations": {
            "summary": _recommendations_summary(recommendation),
            "accepted": accepted,
        },
    }
    return record


def _maybe_log_history_record(enabled: bool, record: dict) -> None:
    if not enabled:
        return
    try:
        _append_history_record(record)
    except Exception:
        return


def _ensure_capture_state() -> _CaptureState:
    global _CAPTURE_STATE
    if _CAPTURE_STATE is not None:
        return _CAPTURE_STATE
    session_id = time.strftime("%Y%m%d_%H%M%S")
    out_dir = _repo_root() / "runs" / "flow_capture" / session_id
    out_dir.mkdir(parents=True, exist_ok=True)
    _CAPTURE_STATE = _CaptureState(session_id=session_id, out_dir=out_dir)
    return _CAPTURE_STATE


def _capture_screen_text(stdscr) -> list[str]:
    import curses
    height, width = stdscr.getmaxyx()
    lines: list[str] = []
    for y in range(height):
        try:
            raw = stdscr.instr(y, 0, max(1, width - 1))
        except curses.error:
            raw = b""
        if isinstance(raw, bytes):
            line = raw.decode("utf-8", errors="ignore")
        else:
            line = str(raw)
        lines.append(line.rstrip())
    return lines


def _capture_screenshot(path: Path) -> str | None:
    try:
        if sys.platform == "darwin" and shutil.which("screencapture"):
            subprocess.run(["screencapture", "-x", str(path)], check=True)
            return None
        if shutil.which("gnome-screenshot"):
            subprocess.run(["gnome-screenshot", "-f", str(path)], check=True)
            return None
        if shutil.which("import"):
            subprocess.run(["import", "-window", "root", str(path)], check=True)
            return None
        return "no screenshot tool available"
    except Exception as exc:
        return str(exc)


def _flash_capture_notice(stdscr, message: str) -> None:
    import curses
    height, width = stdscr.getmaxyx()
    _safe_addstr(stdscr, max(0, height - 1), 0, _truncate_text(message, width - 1), curses.A_DIM)
    stdscr.refresh()
    time.sleep(0.4)


def _capture_current_screen(stdscr) -> None:
    state = _ensure_capture_state()
    state.counter += 1
    step = f"{state.counter:04d}"
    timestamp = _utc_iso_now()
    lines = _capture_screen_text(stdscr)
    text_path = state.out_dir / f"step_{step}.txt"
    text_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    screenshot_path = state.out_dir / f"step_{step}.png"
    screenshot_error = _capture_screenshot(screenshot_path)
    meta = {
        "step": step,
        "timestamp": timestamp,
        "session_id": state.session_id,
        "text_path": text_path.name,
        "screenshot_path": screenshot_path.name if screenshot_error is None else None,
        "screenshot_error": screenshot_error,
        "rows": len(lines),
        "cols": max((len(line) for line in lines), default=0),
    }
    meta_path = state.out_dir / f"step_{step}.json"
    meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    _flash_capture_notice(stdscr, f"Captured step {step} -> {state.out_dir}")


def _handle_capture_key(stdscr, key: int) -> bool:
    if key in _CAPTURE_KEYS:
        _capture_current_screen(stdscr)
        return True
    return False


def _retrieval_score_enabled(args: argparse.Namespace | None = None) -> bool:
    raw = os.getenv(RETRIEVAL_SCORE_ENV)
    if raw is not None:
        return _env_flag(RETRIEVAL_SCORE_ENV)
    if args is not None and getattr(args, "defaults", False):
        return False
    return True


def _final_summary_enabled() -> bool:
    raw = os.getenv(FINAL_SUMMARY_ENV)
    if raw is None:
        return True
    return _env_flag(FINAL_SUMMARY_ENV)


def _retrieval_packet_mode() -> str:
    raw = os.getenv(RETRIEVAL_PACKET_ENV, RETRIEVAL_PACKET_DEFAULT).strip().lower()
    if raw == "full":
        return "full"
    return "compact"


def _supports_color() -> bool:
    return sys.stdout.isatty()


def _style(text: str, code: str, enabled: bool) -> str:
    if not enabled:
        return text
    return f"\033[{code}m{text}\033[0m"


def _term_width(default: int = 100) -> int:
    try:
        return shutil.get_terminal_size(fallback=(default, 20)).columns
    except Exception:
        return default


def _init_locale() -> None:
    try:
        locale.setlocale(locale.LC_ALL, "")
    except Exception:
        pass


def _curses_preflight() -> tuple[bool, str | None]:
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return False, "stdin/stdout is not a TTY"
    term = os.environ.get("TERM", "")
    if term.lower() in {"", "dumb", "unknown"}:
        return False, f"TERM={term or 'unset'}"
    try:
        size = shutil.get_terminal_size(fallback=(0, 0))
        if size.columns and size.lines:
            if size.columns < _MIN_CURSES_WIDTH or size.lines < _MIN_CURSES_HEIGHT:
                return (
                    False,
                    f"terminal too small ({size.columns}x{size.lines}, need "
                    f"{_MIN_CURSES_WIDTH}x{_MIN_CURSES_HEIGHT})",
                )
    except Exception:
        pass
    return True, None


_RAINBOW_COLORS = [
    "red",
    "yellow",
    "green",
    "cyan",
    "blue",
    "magenta",
]


ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages"
ANTHROPIC_MODEL = "claude-opus-4-5-20251101"
ANTHROPIC_MAX_TOKENS = 1400
ANTHROPIC_THINKING_BUDGET = 1024
ANALYSIS_MAX_CHARS = 500
RECEIPT_ANALYZER_ENV = "RECEIPT_ANALYZER"
ANALYZER_CHOICES = ("anthropic", "openai", "council")
DEFAULT_ANALYZER = "anthropic"
OPENAI_ANALYZER_MODEL = "gpt-5.2"
OPENAI_MAX_OUTPUT_TOKENS = 350
GEMINI_ANALYZER_MODEL = "gemini-3-pro-preview"
OPENAI_STREAM_ENV = "OPENAI_IMAGE_STREAM"
OPENAI_RESPONSES_ENV = "OPENAI_IMAGE_USE_RESPONSES"
OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses"
OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta"
RETRIEVAL_SCORE_ENV = "LLM_RETRIEVAL_SCORE"
RETRIEVAL_PACKET_ENV = "LLM_RETRIEVAL_PACKET"
RETRIEVAL_PACKET_DEFAULT = "compact"
FINAL_SUMMARY_ENV = "FINAL_SUMMARY"
HISTORY_OPT_IN_ENV = "PARAM_FORGE_HISTORY"
HISTORY_DIR_NAME = ".param_forge"
HISTORY_CONFIG_FILE = "config.json"
HISTORY_LOG_FILE = "run_history.jsonl"
HISTORY_SCHEMA_VERSION = 1
HISTORY_MAX_RECORDS = 300
HISTORY_PROMPT_LIMIT = 6
MAX_ROUNDS = 3
_CAPTURE_KEYS = {ord("C")}
_CAPTURE_STATE: "_CaptureState | None" = None

_COST_ESTIMATE_CACHE: dict[tuple[str, str | None, str], str] = {}
_PRICING_REFERENCE_CACHE: dict | None = None


@dataclass
class _CaptureState:
    session_id: str
    out_dir: Path
    counter: int = 0


def _compose_side_by_side(
    left_path: Path,
    right_path: Path,
    *,
    label_left: str,
    label_right: str,
    out_dir: Path,
) -> Path | None:
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore
    except Exception:
        return None
    try:
        left = Image.open(left_path).convert("RGB")
        right = Image.open(right_path).convert("RGB")
    except Exception:
        return None
    target_h = min(left.height, right.height)
    if left.height != target_h:
        new_w = max(1, int(left.width * (target_h / left.height)))
        left = left.resize((new_w, target_h), Image.LANCZOS)
    if right.height != target_h:
        new_w = max(1, int(right.width * (target_h / right.height)))
        right = right.resize((new_w, target_h), Image.LANCZOS)
    padding = 20
    label_height = 36
    total_w = left.width + right.width + padding * 3
    total_h = target_h + label_height + padding * 2
    canvas = Image.new("RGB", (total_w, total_h), (248, 248, 248))
    draw = ImageDraw.Draw(canvas)
    try:
        font = ImageFont.truetype("Arial.ttf", 18)
    except Exception:
        font = ImageFont.load_default()
    x_left = padding
    x_right = padding * 2 + left.width
    y_img = padding + label_height
    canvas.paste(left, (x_left, y_img))
    canvas.paste(right, (x_right, y_img))
    def _draw_label(text: str, x: int, width: int) -> None:
        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        text_x = x + max(0, (width - text_w) // 2)
        text_y = padding + max(0, (label_height - text_h) // 2)
        draw.text((text_x, text_y), text, fill=(0, 0, 0), font=font)
    _draw_label(label_left, x_left, left.width)
    _draw_label(label_right, x_right, right.width)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = out_dir / f"comparison_{stamp}.png"
    canvas.save(out_path)
    return out_path


@dataclass
class _RawMode:
    fd: int
    original: list

    def __enter__(self) -> "_RawMode":
        tty.setraw(self.fd)
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        termios.tcsetattr(self.fd, termios.TCSADRAIN, self.original)


def _read_key() -> str:
    ch = sys.stdin.read(1)
    if ch == "\x03":
        raise KeyboardInterrupt
    if ch == "":
        raise KeyboardInterrupt
    if ch != "\x1b":
        return ch
    seq = ""
    for _ in range(5):
        nxt = sys.stdin.read(1)
        if nxt == "":
            break
        seq += nxt
        if nxt.isalpha() or nxt == "~":
            break
    if seq.endswith("D"):
        return "LEFT"
    if seq.endswith("C"):
        return "RIGHT"
    if seq.endswith("A"):
        return "UP"
    if seq.endswith("B"):
        return "DOWN"
    return "ESC"


def _select_from_list(label: str, choices: list[str], default_index: int = 0) -> str:
    idx = default_index
    print(f"{label} (left/right, enter to confirm):")
    while True:
        line = _format_choices_line(
            choices,
            idx,
            max_width=_term_width() - 2,
            color=_supports_color(),
        )
        sys.stdout.write("\r\033[2K" + line)
        sys.stdout.flush()
        key = _read_key()
        if key in {"LEFT", "h", "H", "a", "A"}:
            idx = (idx - 1) % len(choices)
        elif key in {"RIGHT", "l", "L", "d", "D"}:
            idx = (idx + 1) % len(choices)
        elif key in {"\r", "\n"}:
            sys.stdout.write("\r\n")
            return choices[idx]
        elif key in {"q", "Q"}:
            sys.stdout.write("\r\n")
            return choices[default_index]


def _select_int(label: str, default: int, minimum: int = 1, maximum: int = 6) -> int:
    value = default
    print(f"{label} (left/right, enter to confirm):")
    while True:
        sys.stdout.write("\r\033[2K" + f"  [{value}]")
        sys.stdout.flush()
        key = _read_key()
        if key in {"LEFT", "h", "H", "a", "A"}:
            value = max(minimum, value - 1)
        elif key in {"RIGHT", "l", "L", "d", "D"}:
            value = min(maximum, value + 1)
        elif key in {"\r", "\n"}:
            sys.stdout.write("\r\n")
            return value
        elif key in {"q", "Q"}:
            sys.stdout.write("\r\n")
    return default


def _select_text(label: str, default: str) -> str:
    print(f"{label} (enter to confirm; empty = default):")
    buffer = ""
    while True:
        sys.stdout.write("\r\033[2K  " + buffer)
        sys.stdout.flush()
        key = _read_key()
        if key in {"\r", "\n"}:
            sys.stdout.write("\r\n")
            text = buffer.strip()
            return text if text else default
        if key in {"\x7f", "\b"}:
            buffer = buffer[:-1]
            continue
        if key in {"LEFT", "RIGHT", "UP", "DOWN", "ESC"}:
            continue
        if len(key) == 1 and key.isprintable():
            buffer += key


def _model_choices_for(provider: str) -> list[str]:
    provider_key = provider.strip().lower()
    if provider_key == "google":
        return MODEL_CHOICES_BY_PROVIDER.get("gemini", []) + MODEL_CHOICES_BY_PROVIDER.get("imagen", [])
    if provider_key in {"black forest labs", "bfl"}:
        return MODEL_CHOICES_BY_PROVIDER.get("flux", [])
    return MODEL_CHOICES_BY_PROVIDER.get(provider_key, [])


def _size_label_choices() -> list[str]:
    return [label for _, label in SIZE_CHOICES]


def _size_value_from_label(label: str) -> str:
    for value, display in SIZE_CHOICES:
        if label == display:
            return value
    return label


def _normalize_size(value: str) -> str:
    return _size_value_from_label(value)


def _normalize_provider_and_model(provider: str, model: str | None) -> tuple[str, str | None]:
    provider_key = provider.strip().lower()
    if provider_key == "google":
        model_key = (model or "").lower()
        if "imagen" in model_key:
            return "imagen", model
        return "gemini", model
    if provider_key in {"black forest labs", "bfl"}:
        return "flux", model
    return provider_key, model


def _is_openai_gpt_image(provider: str | None, model: str | None) -> bool:
    if (provider or "").strip().lower() != "openai":
        return False
    model_key = (model or "").strip().lower()
    if not model_key:
        return True
    return model_key.startswith("gpt-image")


def _normalize_analyzer(value: str | None) -> str:
    if not value:
        return DEFAULT_ANALYZER
    normalized = value.strip().lower()
    if normalized not in ANALYZER_CHOICES:
        raise RuntimeError(
            f"Unsupported receipt analyzer '{value}'. Use: {', '.join(ANALYZER_CHOICES)}."
        )
    return normalized


def _resolve_receipt_analyzer(value: str | None) -> str:
    if value:
        return _normalize_analyzer(value)
    return _normalize_analyzer(os.getenv(RECEIPT_ANALYZER_ENV))


def _analyzer_display_name(analyzer: str) -> str:
    analyzer_key = analyzer.strip().lower()
    if analyzer_key == "openai":
        return "OpenAI GPT-5.2"
    if analyzer_key == "council":
        return "Council (GPT-5.2 + Claude Opus 4.5 + Gemini 3 Pro)"
    return "Claude Opus 4.5"


def _display_provider_name(provider: object | None) -> str | None:
    if provider is None:
        return None
    key = str(provider).strip().lower()
    if key in {"gemini", "imagen", "google"}:
        return "google"
    if key in {"black forest labs", "bfl", "flux"}:
        return "black forest labs"
    return str(provider)


def _allowed_settings_for_provider(provider: str) -> list[str]:
    if provider == "openai":
        return ["quality", "moderation", "input_fidelity", "output_compression", "use_responses"]
    if provider == "gemini":
        return ["image_size"]
    if provider == "imagen":
        return ["add_watermark", "person_generation"]
    if provider == "flux":
        return [
            "endpoint",
            "url",
            "model",
            "poll_interval",
            "poll_timeout",
            "request_timeout",
            "download_timeout",
            "prompt_upsampling",
            "guidance",
            "steps",
            "safety_tolerance",
        ]
    return []


def _allowed_models_for_provider(provider: str | None, current_model: str | None = None) -> list[str]:
    if not provider:
        return [current_model] if current_model else []
    provider_key, model_key = _normalize_provider_and_model(str(provider), current_model)
    models = list(MODEL_CHOICES_BY_PROVIDER.get(provider_key, []))
    if model_key and model_key not in models:
        models.append(model_key)
    return models


def _model_options_line(
    provider: str,
    size: str,
    current_model: str | None,
    provider_options: dict[str, object] | None = None,
) -> str:
    models = _allowed_models_for_provider(provider, current_model)
    if not models:
        return ""
    options = provider_options if isinstance(provider_options, dict) else None
    items: list[str] = []
    for model in models:
        cost = _estimate_cost_value(
            provider=provider,
            model=model,
            size=size,
            provider_options=options,
        )
        if cost is not None:
            items.append(f"{model} (~${_format_price(cost)})")
        else:
            items.append(str(model))
    return "Model options (same provider): " + ", ".join(items)


def _allowed_settings_for_receipt(receipt: dict, provider: str | None = None) -> list[str]:
    allowed: set[str] = set()
    blocked_top_level = {
        "prompt",
        "mode",
        "out_dir",
        "inputs",
        "user",
        "metadata",
        "stream",
        "partial_images",
        "provider",
    }
    blocked_resolved = {"width", "height", "aspect_ratio"}
    top_level_keys = {"size", "n", "seed", "output_format", "model"}

    provider_key = provider
    if not provider_key and isinstance(receipt, dict):
        resolved_provider = None
        request_provider = None
        resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else None
        request = receipt.get("request") if isinstance(receipt.get("request"), dict) else None
        if isinstance(resolved, dict):
            resolved_provider = resolved.get("provider")
        if isinstance(request, dict):
            request_provider = request.get("provider")
        provider_key = resolved_provider or request_provider
    if provider_key:
        provider_key, _ = _normalize_provider_and_model(str(provider_key), None)

    if provider_key == "openai":
        top_level_keys.add("background")

    for key in top_level_keys:
        allowed.add(key)

    if provider_key:
        allowed.update(_allowed_settings_for_provider(provider_key))

    request = receipt.get("request") if isinstance(receipt, dict) else None
    if isinstance(request, dict):
        for key in request.keys():
            if key in blocked_top_level or key == "inputs":
                continue
            if key == "provider_options":
                provider_options = request.get("provider_options")
                if isinstance(provider_options, dict):
                    allowed.update(str(opt_key) for opt_key in provider_options.keys())
                continue
            allowed.add(str(key))

    resolved = receipt.get("resolved") if isinstance(receipt, dict) else None
    if isinstance(resolved, dict):
        provider_params = resolved.get("provider_params")
        if isinstance(provider_params, dict):
            for key in provider_params.keys():
                if key in blocked_resolved:
                    continue
                if key == "image_size" and provider_key not in {"gemini"}:
                    provider_options = (
                        request.get("provider_options") if isinstance(request, dict) else None
                    )
                    if not (isinstance(provider_options, dict) and "image_size" in provider_options):
                        continue
                allowed.add(str(key))

    return sorted({key for key in allowed if key not in blocked_top_level and key})


_TOP_LEVEL_RECOMMENDATION_KEYS = {"size", "n", "seed", "output_format", "background", "model"}
_BLOCKED_RECOMMENDATION_KEYS = {
    "prompt",
    "mode",
    "out_dir",
    "inputs",
    "user",
    "metadata",
    "stream",
    "partial_images",
    "provider",
}


def _filter_unsupported_top_level_recommendations(
    recommendations: list[dict],
    provider: str | None,
) -> list[dict]:
    if not provider:
        return recommendations
    provider_key, _ = _normalize_provider_and_model(str(provider), None)
    if provider_key == "openai":
        return recommendations
    filtered: list[dict] = []
    for rec in recommendations:
        name = str(rec.get("setting_name") or "").strip().lower()
        target = str(rec.get("setting_target") or "provider_options").strip().lower()
        if target in {"request", "top_level", "request_settings", ""} and name == "background":
            continue
        filtered.append(rec)
    return filtered


def _extract_setting_json(text: str) -> tuple[str, object | None]:
    match = re.search(r"<setting_json>(.*?)</setting_json>", text, flags=re.S)
    if not match:
        return text.strip(), None
    raw_json = match.group(1).strip()
    recommendation = None
    try:
        recommendation = json.loads(raw_json)
    except json.JSONDecodeError:
        recommendation = None
    cleaned = (text[: match.start()] + text[match.end():]).strip()
    return cleaned, recommendation


def _parse_recommendation_payload(payload: object) -> tuple[object | None, str | None, bool]:
    if payload is None:
        return None, None, False
    if isinstance(payload, dict):
        if "recommendations" in payload and isinstance(payload.get("recommendations"), list):
            return payload.get("recommendations"), None, False
        if "setting_name" in payload:
            return [payload], None, False
        return None, None, False
    if isinstance(payload, list):
        return payload, None, False
    return None, None, False


def _normalize_recommendations(raw: object) -> list[dict]:
    candidates: list[dict] = []
    if isinstance(raw, dict):
        candidates = [raw]
    elif isinstance(raw, list):
        candidates = [item for item in raw if isinstance(item, dict)]
    else:
        return []

    cleaned: list[dict] = []
    for rec in candidates:
        name = str(rec.get("setting_name") or "").strip()
        name_lower = name.lower()
        if not name or name_lower in {"none", "null", "no_change", "no change", "n/a"}:
            continue
        if name_lower in _BLOCKED_RECOMMENDATION_KEYS:
            continue
        value = rec.get("setting_value")
        if value is None:
            continue
        if isinstance(value, str) and value.strip().lower() in {"none", "null", "no_change", "no change", "n/a"}:
            continue
        target = rec.get("setting_target")
        if not target:
            target = "request" if name_lower in _TOP_LEVEL_RECOMMENDATION_KEYS else "provider_options"
        if name_lower in _TOP_LEVEL_RECOMMENDATION_KEYS:
            target = "request"
        rec_clean = dict(rec)
        rec_clean["setting_name"] = name
        rec_clean["setting_target"] = str(target).strip()
        cleaned.append(rec_clean)

    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for rec in cleaned:
        key = (
            str(rec.get("setting_target") or "").lower(),
            str(rec.get("setting_name") or "").lower(),
        )
        if key in seen:
            continue
        seen.add(key)
        deduped.append(rec)
    return deduped[:3]


def _coerce_setting_value(value: object) -> object:
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "false"}:
            return lowered == "true"
        try:
            if "." in lowered:
                return float(lowered)
            return int(lowered)
        except Exception:
            return lowered
    if isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, list):
        return [_coerce_setting_value(item) for item in value]
    if isinstance(value, dict):
        return {str(k).lower(): _coerce_setting_value(v) for k, v in value.items()}
    return value


def _values_equivalent(left: object, right: object) -> bool:
    left_norm = _coerce_setting_value(left)
    right_norm = _coerce_setting_value(right)
    if isinstance(left_norm, (int, float)) and isinstance(right_norm, (int, float)):
        return float(left_norm) == float(right_norm)
    return left_norm == right_norm


def _filter_noop_recommendations(
    recs: list[dict],
    resolved: dict | None,
    request: dict | None,
    *,
    provider: str | None = None,
    model: str | None = None,
) -> list[dict]:
    filtered: list[dict] = []
    for rec in recs:
        setting_name = str(rec.get("setting_name") or "").strip()
        if not setting_name:
            continue
        setting_target = str(rec.get("setting_target") or "provider_options")
        current_value = _lookup_current_setting_value_with_defaults(
            setting_name,
            setting_target,
            resolved,
            request,
            provider,
            model,
        )
        if current_value is None:
            filtered.append(rec)
            continue
        if _values_equivalent(current_value, rec.get("setting_value")):
            continue
        filtered.append(rec)
    return filtered


def _filter_locked_size_recommendations(
    recs: list[dict],
    locked_size: str | None,
) -> list[dict]:
    if not locked_size:
        return recs
    locked_norm = _normalize_size(str(locked_size))
    filtered: list[dict] = []
    for rec in recs:
        setting_name = str(rec.get("setting_name") or "").strip().lower()
        if setting_name != "size":
            filtered.append(rec)
            continue
        rec_value = rec.get("setting_value")
        rec_norm = _normalize_size(str(rec_value))
        if rec_norm == locked_norm:
            filtered.append(rec)
        # Skip recommendations that change the user-selected size/aspect ratio.
    return filtered


def _filter_model_recommendations(
    recs: list[dict],
    allowed_models: list[str],
) -> list[dict]:
    if not allowed_models:
        return recs
    allowed = {str(model).strip().lower() for model in allowed_models if model}
    filtered: list[dict] = []
    for rec in recs:
        setting_name = str(rec.get("setting_name") or "").strip().lower()
        if setting_name != "model":
            filtered.append(rec)
            continue
        rec_value = str(rec.get("setting_value") or "").strip().lower()
        if rec_value in allowed:
            filtered.append(rec)
    return filtered


def _sanitize_recommendation_rationales(
    recs: list[dict],
    cost_line: str | None,
    *,
    provider: str | None = None,
    size: str | None = None,
    n: int | None = None,
    provider_options: dict[str, object] | None = None,
) -> list[dict]:
    if not recs:
        return recs
    base_cost_token = _extract_price_token(cost_line)
    options = provider_options if isinstance(provider_options, dict) else None
    updated: list[dict] = []
    for rec in recs:
        rec_copy = dict(rec)
        rationale = rec_copy.get("rationale")
        if isinstance(rationale, str):
            cost_token = base_cost_token
            setting_name = str(rec_copy.get("setting_name") or "").strip().lower()
            if setting_name == "model" and provider and size:
                try:
                    rec_model = str(rec_copy.get("setting_value") or "").strip()
                    rec_cost_line = _estimate_cost_only(
                        provider=provider,
                        model=rec_model or None,
                        size=size,
                        n=n or 1,
                        provider_options=options,
                    )
                    rec_cost_token = _extract_price_token(rec_cost_line)
                    if rec_cost_token:
                        cost_token = rec_cost_token
                except Exception:
                    pass
            normalized = _normalize_rationale_cost(
                rationale,
                cost_token,
                force_simple=setting_name == "model",
            )
            if normalized:
                rec_copy["rationale"] = normalized
            else:
                rec_copy.pop("rationale", None)
        updated.append(rec_copy)
    return updated


def _extract_cost_line(text: str) -> tuple[str, str | None]:
    lines = text.splitlines()
    cost_line = None
    remaining: list[str] = []
    for line in lines:
        stripped = line.strip()
        upper = stripped.upper()
        if upper.startswith("COST"):
            cost_line = stripped
            continue
        remaining.append(line)
    return "\n".join(remaining).strip(), cost_line


def _normalize_rec_line(text: str) -> str:
    lines = text.splitlines()
    updated: list[str] = []
    for line in lines:
        if line.strip().upper().startswith("REC:"):
            rec = line.strip()[4:].strip()
            updated.append(f"REC: {rec}")
        else:
            updated.append(line)
    return "\n".join(updated).strip()


def _rec_line_text(text: str) -> str | None:
    for line in text.splitlines():
        if line.strip().upper().startswith("REC:"):
            return line.strip()[4:].strip().lower()
    return None


def _extract_price_token(text: str | None) -> str | None:
    if not text:
        return None
    match = re.search(r"\$[0-9]+(?:\.[0-9]+)?(?:/1K)?", text, flags=re.I)
    if match:
        return match.group(0)
    return None


def _normalize_cost_token(cost_token: str) -> str:
    if "/1k" in cost_token.lower():
        return cost_token
    return f"{cost_token}/1K"


def _rationale_needs_simple_cost(rationale: str) -> bool:
    if re.search(r"\b(both|same|either|vs\.?|versus|compare|compared|equal|each)\b", rationale, flags=re.I):
        return True
    price_hits = re.findall(r"\$[0-9]+(?:\.[0-9]+)?(?:/1K)?", rationale, flags=re.I)
    return len(price_hits) > 1


def _normalize_rationale_cost(
    rationale: str,
    cost_token: str | None,
    *,
    force_simple: bool = False,
) -> str | None:
    trimmed = rationale.strip()
    if not trimmed:
        return None
    contains_cost = bool(re.search(r"\b(cost|save|savings)\b", trimmed, flags=re.I)) or "$" in trimmed
    if not contains_cost:
        return trimmed
    if not cost_token:
        return None
    normalized_token = _normalize_cost_token(cost_token)
    if force_simple or _rationale_needs_simple_cost(trimmed):
        return f"Local cost estimate: {normalized_token} images."
    if "$" in trimmed:
        return re.sub(
            r"\$[0-9]+(?:\.[0-9]+)?(?:/1K)?",
            normalized_token,
            trimmed,
            flags=re.I,
        )
    return f"Local cost estimate: {normalized_token} images."


def _rewrite_rec_line(
    text: str,
    recommendations: list[dict],
) -> str:
    if recommendations:
        parts: list[str] = []
        for rec in recommendations:
            name = str(rec.get("setting_name") or "").strip()
            if not name:
                continue
            value = _format_setting_value(rec.get("setting_value"))
            target = str(rec.get("setting_target") or "provider_options").strip().lower()
            if target == "provider_options":
                parts.append(f"{name}={value}")
            else:
                parts.append(f"{name}={value}")
        rec_line = "REC: " + "; ".join(parts) if parts else "REC: no changes recommended."
    else:
        rec_line = "REC: no changes recommended."
    lines = text.splitlines()
    replaced = False
    for idx, line in enumerate(lines):
        if line.strip().upper().startswith("REC:"):
            lines[idx] = rec_line
            replaced = True
            break
    if not replaced:
        lines.append(rec_line)
    return "\n".join(lines).strip()


def _strip_cost_prefix(cost_line: str | None) -> str | None:
    if not cost_line:
        return None
    stripped = cost_line.strip()
    if stripped.upper().startswith("COST:"):
        stripped = stripped[5:].strip()
    return stripped or None


def _parse_cost_amount(cost_line: str | None) -> float | None:
    if not cost_line:
        return None
    match = re.search(r"\$?([0-9]+(?:\.[0-9]+)?)", cost_line)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except Exception:
        return None
    lowered = cost_line.lower()
    if "/1k" in lowered or "per 1k" in lowered or "per 1000" in lowered:
        return value / 1000.0
    return value


def _analysis_history_line(entry: dict) -> str:
    round_index = entry.get("round")
    settings = entry.get("settings") or "(no settings)"
    elapsed = entry.get("elapsed")
    cost_line = entry.get("cost")
    recs = entry.get("recs")
    accepted = entry.get("accepted")
    parts: list[str] = []
    if round_index is not None:
        parts.append(f"Round {round_index}")
    parts.append(str(settings))
    if isinstance(elapsed, (int, float)):
        parts.append(f"elapsed {elapsed:.1f}s")
    cost_text = _strip_cost_prefix(cost_line)
    if cost_text:
        parts.append(f"cost {cost_text}")
    if recs:
        applied_text = "applied" if accepted else "not applied"
        parts.append(f"recs {recs} ({applied_text})")
    else:
        parts.append("recs none")
    return "; ".join(parts)


def _format_analysis_history(history: list[dict]) -> str:
    if not history:
        return ""
    lines = [_analysis_history_line(entry) for entry in history]
    return "\n".join(lines).strip()


def _append_analysis_history(
    history: list[dict],
    *,
    round_index: int,
    settings: dict[str, object] | None,
    recommendations: object,
    accepted: bool,
    elapsed: float | None,
    cost_line: str | None,
    adherence: int | None,
    quality: int | None,
    retrieval: int | None = None,
) -> None:
    summary = _recommendations_summary(recommendations)
    history.append(
        {
            "round": round_index,
            "settings": _format_call_settings_line(settings or {}),
            "settings_dict": copy.deepcopy(settings) if isinstance(settings, dict) else None,
            "elapsed": elapsed,
            "cost": cost_line,
            "recs": summary,
            "accepted": accepted,
            "adherence": adherence,
            "quality": quality,
            "retrieval": retrieval,
        }
    )


def _recommendations_rationale(recommendation: object) -> str | None:
    recs = _normalize_recommendations(recommendation)
    if not recs:
        return None
    rationales: list[str] = []
    seen: set[str] = set()
    for rec in recs:
        rationale = rec.get("rationale")
        if not isinstance(rationale, str):
            continue
        cleaned = rationale.strip()
        if not cleaned:
            continue
        key = cleaned.lower()
        if key in seen:
            continue
        seen.add(key)
        rationales.append(cleaned)
        if len(rationales) >= 2:
            break
    if not rationales:
        return None
    joined = " / ".join(rationales)
    return f"Rationale: {joined}"


def _average_score(values: list[int | None]) -> int | None:
    scores = [value for value in values if isinstance(value, (int, float))]
    if not scores:
        return None
    return int(round(sum(scores) / len(scores)))


def _quality_from_history(
    history: list[dict] | None,
    current_quality: int | None = None,
) -> tuple[int | None, int | None]:
    baseline = None
    latest = None
    for entry in history or []:
        value = entry.get("quality")
        if isinstance(value, int):
            if baseline is None:
                baseline = value
            latest = value
    if current_quality is not None:
        latest = current_quality
        if baseline is None:
            baseline = current_quality
    return baseline, latest


def _adherence_from_history(
    history: list[dict] | None,
    current_adherence: int | None = None,
) -> tuple[int | None, int | None]:
    baseline = None
    latest = None
    for entry in history or []:
        value = entry.get("adherence")
        if isinstance(value, int):
            if baseline is None:
                baseline = value
            latest = value
    if current_adherence is not None:
        latest = current_adherence
        if baseline is None:
            baseline = current_adherence
    return baseline, latest


def _retrieval_from_history(
    history: list[dict] | None,
    current_retrieval: int | None = None,
) -> tuple[int | None, int | None]:
    baseline = None
    latest = None
    for entry in history or []:
        value = entry.get("retrieval")
        if isinstance(value, int):
            if baseline is None:
                baseline = value
            latest = value
    if current_retrieval is not None:
        latest = current_retrieval
        if baseline is None:
            baseline = current_retrieval
    return baseline, latest


def _baseline_metrics_from_history(history: list[dict] | None) -> tuple[float | None, str | None]:
    if not history:
        return None, None
    first = history[0]
    elapsed = first.get("elapsed")
    cost_line = first.get("cost")
    baseline_elapsed = float(elapsed) if isinstance(elapsed, (int, float)) else None
    baseline_cost_line = str(cost_line) if isinstance(cost_line, str) else None
    return baseline_elapsed, baseline_cost_line


def _history_metric_value(entry: dict, key: str) -> float | int | None:
    if key == "time":
        value = entry.get("elapsed")
        return float(value) if isinstance(value, (int, float)) else None
    if key == "cost":
        return _parse_cost_amount(entry.get("cost"))
    if key == "quality":
        value = entry.get("quality")
        return int(value) if isinstance(value, int) else None
    if key == "adherence":
        value = entry.get("adherence")
        return int(value) if isinstance(value, int) else None
    if key == "retrieval":
        value = entry.get("retrieval")
        return int(value) if isinstance(value, int) else None
    return None


def _best_round_criteria(user_goals: list[str] | None) -> list[tuple[str, str]]:
    goals = set(user_goals or [])
    if not goals or goals == {"something else"}:
        return []
    wants_time = "minimize time to render" in goals
    wants_cost = "minimize cost of render" in goals
    wants_quality = "maximize quality of render" in goals
    wants_retrieval = "maximize LLM retrieval score" in goals
    criteria: list[tuple[str, str]] = []

    def _add(item: tuple[str, str]) -> None:
        if item not in criteria:
            criteria.append(item)

    if wants_time:
        _add(("time", "min"))
    if wants_cost:
        _add(("cost", "min"))
    if wants_quality:
        _add(("quality", "max"))
        _add(("adherence", "max"))
    if wants_retrieval:
        _add(("retrieval", "max"))
    if (wants_time or wants_cost) and not wants_quality:
        _add(("quality", "max"))
        _add(("adherence", "max"))
    if (wants_time or wants_cost) and not wants_retrieval:
        _add(("retrieval", "max"))
    return criteria


def _best_round_from_history(
    history: list[dict] | None,
    user_goals: list[str] | None,
) -> dict | None:
    if not history:
        return None
    criteria = _best_round_criteria(user_goals)
    if not criteria:
        return history[-1]
    criteria = [
        (key, mode)
        for key, mode in criteria
        if any(_history_metric_value(entry, key) is not None for entry in history)
    ]
    if not criteria:
        return history[-1]

    def _key(entry: dict) -> tuple[float, ...]:
        parts: list[float] = []
        for metric_key, mode in criteria:
            value = _history_metric_value(entry, metric_key)
            if mode == "min":
                parts.append(float(value) if value is not None else float("inf"))
            else:
                parts.append(-float(value) if value is not None else float("inf"))
        return tuple(parts)

    best = history[0]
    best_key = _key(best)
    for entry in history[1:]:
        entry_key = _key(entry)
        if entry_key < best_key:
            best = entry
            best_key = entry_key
        elif entry_key == best_key:
            best_round = entry.get("round")
            current_round = best.get("round")
            if isinstance(best_round, int) and isinstance(current_round, int):
                if best_round >= current_round:
                    best = entry
                    best_key = entry_key
    return best


def _compress_analysis_to_limit(text: str, limit: int, *, analyzer: str | None = None) -> str:
    if len(text) <= limit:
        return text
    prompt = (
        "Shorten the content to <= "
        + str(limit)
        + " characters total, preserving the four lines labeled ADH/UNSET/COST/REC "
        + "and the <setting_json>...</setting_json> block. "
        + "Do not add new content. Keep the JSON valid and unchanged if possible.\n\n"
        + text
    )
    compressed, _ = _call_analyzer(prompt, analyzer=analyzer, enable_web_search=False)
    if len(compressed) <= limit:
        return compressed
    # Second pass if needed
    compressed2, _ = _call_analyzer(
        "Tighten to <= "
        + str(limit)
        + " chars total. Preserve ADH/UNSET/COST/REC labels and <setting_json> block.\n\n"
        + compressed,
        analyzer=analyzer,
        enable_web_search=False,
    )
    if len(compressed2) <= limit:
        return compressed2
    return compressed2


def _load_pricing_reference() -> dict:
    global _PRICING_REFERENCE_CACHE
    if _PRICING_REFERENCE_CACHE is not None:
        return _PRICING_REFERENCE_CACHE
    path = _repo_root() / "docs" / "pricing_reference.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            _PRICING_REFERENCE_CACHE = data
            return data
    except Exception:
        pass
    _PRICING_REFERENCE_CACHE = {}
    return _PRICING_REFERENCE_CACHE


def _openai_size_key(size: str) -> str:
    size_key = size.strip().lower()
    if size_key in {"1024x1024", "square", "1:1"}:
        return "1024x1024"
    if size_key in {"1024x1536", "portrait", "3:4", "4:5", "9:16"}:
        return "1024x1536"
    if size_key in {"1536x1024", "landscape", "16:9", "1.91:1", "2:3"}:
        return "1536x1024"
    return "1024x1024"


def _gemini_size_tier(size: str) -> str:
    if "4k" in size.lower() or "4096" in size:
        return "4k"
    return "1k_2k"


def _format_price(value: float, digits: int = 3) -> str:
    return f"{value:.{digits}f}".rstrip("0").rstrip(".")


def _normalize_quality_tier(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"low", "medium", "high"}:
        return normalized
    if normalized in {"standard", "std"}:
        return "medium"
    return None


def _normalize_imagen_quality(value: object | None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"fast", "standard", "ultra"}:
        return normalized
    return None


def _is_batch_pricing(provider_options: dict[str, object] | None) -> bool:
    if not provider_options:
        return False
    for key in ("batch", "use_batch", "batch_mode"):
        if provider_options.get(key) is True:
            return True
    for key in ("pricing_tier", "usage_tier", "pricing", "mode"):
        value = provider_options.get(key)
        if isinstance(value, str) and value.strip().lower() == "batch":
            return True
    return False


def _pricing_option_key(
    provider_key: str,
    size: str,
    provider_options: dict[str, object] | None,
) -> tuple | None:
    if not provider_options:
        return None
    if provider_key == "openai":
        return ("quality", _normalize_quality_tier(provider_options.get("quality")))
    if provider_key == "gemini":
        return ("batch", _is_batch_pricing(provider_options), "tier", _gemini_size_tier(size))
    if provider_key == "imagen":
        return ("quality", _normalize_imagen_quality(provider_options.get("quality")))
    return None


def _estimate_cost_only(
    *,
    provider: str,
    model: str | None,
    size: str,
    n: int,
    provider_options: dict[str, object] | None = None,
) -> str | None:
    provider_key = provider.strip().lower()
    cache_key = (provider_key, model, size, _pricing_option_key(provider_key, size, provider_options))
    cached = _COST_ESTIMATE_CACHE.get(cache_key)
    if cached:
        return cached
    pricing = _load_pricing_reference()
    model_key = (model or "").strip().lower()
    cost_line: str | None = None

    def _per_1k(value: float, digits: int = 3) -> str:
        return f"${_format_price(float(value) * 1000.0, digits=digits)}/1K"

    if provider_key == "openai":
        model_key = model_key or "gpt-image-1"
        size_key = _openai_size_key(size)
        model_prices = pricing.get("openai", {}).get(model_key, {})
        size_prices = model_prices.get(size_key) if isinstance(model_prices, dict) else None
        if isinstance(size_prices, dict):
            quality = _normalize_quality_tier(provider_options.get("quality") if provider_options else None)
            price = None
            if quality:
                price = size_prices.get(quality)
            if price is None:
                price = size_prices.get("medium") or size_prices.get("standard") or size_prices.get("low")
            if isinstance(price, (int, float)):
                quality_label = quality or "medium"
                cost_line = (
                    f"COST: ~{_per_1k(float(price))} images "
                    f"({model_key}, {size_key}, {quality_label})"
                )

    elif provider_key == "gemini":
        model_key = model_key or "gemini-2.5-flash-image"
        model_prices = pricing.get("gemini", {}).get(model_key, {})
        if model_key == "gemini-2.5-flash-image":
            use_batch = _is_batch_pricing(provider_options)
            tier_key = "batch" if use_batch else "standard"
            price = model_prices.get(tier_key) if isinstance(model_prices, dict) else None
            if isinstance(price, (int, float)):
                label = "batch" if use_batch else "standard"
                cost_line = f"COST: ~{_per_1k(float(price))} images ({model_key}, {label})"
        elif model_key == "gemini-3-pro-image-preview":
            tier = _gemini_size_tier(size)
            use_batch = _is_batch_pricing(provider_options)
            key = f"{'batch' if use_batch else 'standard'}_{tier}"
            price = model_prices.get(key) if isinstance(model_prices, dict) else None
            if isinstance(price, (int, float)):
                label = "1K/2K" if tier == "1k_2k" else "4K"
                mode_label = "batch" if use_batch else "standard"
                cost_line = f"COST: ~{_per_1k(float(price))} images ({model_key}, {mode_label} {label})"

    elif provider_key == "imagen":
        model_key = model_key or "imagen-4"
        model_prices = pricing.get("imagen", {}).get(model_key, {})
        if isinstance(model_prices, dict):
            quality = _normalize_imagen_quality(provider_options.get("quality") if provider_options else None)
            price = None
            if quality:
                price = model_prices.get(quality)
            if price is None:
                price = model_prices.get("standard") or model_prices.get("ultra") or model_prices.get("fast")
            if isinstance(price, (int, float)):
                label = (
                    "ultra"
                    if model_key.endswith("ultra")
                    else "fast"
                    if model_key.endswith("fast")
                    else "standard"
                )
                if quality:
                    label = quality
                cost_line = f"COST: ~{_per_1k(float(price))} images ({model_key}, {label})"

    elif provider_key == "flux":
        model_key = model_key or "flux-2"
        model_prices = pricing.get("flux", {}).get(model_key, {})
        if isinstance(model_prices, dict):
            price = model_prices.get("from")
            if isinstance(price, (int, float)):
                cost_line = f"COST: from {_per_1k(float(price))} images ({model_key})"

    if cost_line:
        _COST_ESTIMATE_CACHE[cache_key] = cost_line
    return cost_line


def _apply_recommendation(args: argparse.Namespace, recommendation: object) -> bool:
    recs = _normalize_recommendations(recommendation)
    if not recs:
        return False

    applied = False
    for rec in recs:
        setting_name = rec.get("setting_name")
        if not setting_name:
            continue
        setting_value = rec.get("setting_value")
        if isinstance(setting_value, str):
            lowered = setting_value.strip().lower()
            if lowered in {"true", "false"}:
                setting_value = lowered == "true"
            else:
                try:
                    if "." in lowered:
                        setting_value = float(lowered)
                    else:
                        setting_value = int(lowered)
                except Exception:
                    pass
        setting_target = str(rec.get("setting_target") or "").strip().lower()
        setting_name_lower = str(setting_name).strip().lower()
        if setting_name_lower in {"use_responses", "openai_responses"} and setting_target == "request":
            setting_target = "provider_options"

        if setting_name_lower == "seed" or setting_name_lower in _TOP_LEVEL_RECOMMENDATION_KEYS:
            if setting_name_lower == "seed":
                try:
                    args.seed = int(setting_value)
                    applied = True
                except Exception:
                    continue
            elif setting_name_lower == "n":
                try:
                    args.n = int(setting_value)
                    applied = True
                except Exception:
                    continue
            elif setting_name_lower == "size":
                args.size = _normalize_size(str(setting_value))
                applied = True
            elif setting_name_lower == "model":
                args.model = str(setting_value)
                applied = True
            elif setting_name_lower == "output_format":
                setattr(args, "output_format", str(setting_value))
                applied = True
            elif setting_name_lower == "background":
                setattr(args, "background", str(setting_value))
                applied = True
            continue

        if setting_target not in {"provider_options", "provider", "options", ""}:
            continue
        options = getattr(args, "provider_options", None)
        if not isinstance(options, dict):
            options = {}
            args.provider_options = options
        options[str(setting_name)] = setting_value
        if str(setting_name_lower) in {"use_responses", "openai_responses"} and getattr(args, "provider", "") == "openai":
            args.openai_responses = bool(setting_value)
            if args.openai_responses:
                args.openai_stream = False
        applied = True
    return applied


def _recommendations_summary(recommendation: object) -> str:
    recs = _normalize_recommendations(recommendation)
    if not recs:
        return ""
    parts: list[str] = []
    for rec in recs:
        setting_name = rec.get("setting_name")
        if not setting_name:
            continue
        setting_value = rec.get("setting_value")
        setting_target = str(rec.get("setting_target") or "provider_options")
        if setting_target == "provider_options":
            parts.append(
                f"provider_options.{setting_name}={_format_setting_value(setting_value)}"
            )
        else:
            parts.append(f"{setting_name}={_format_setting_value(setting_value)}")
    return ", ".join(parts)


def _interactive_args_raw(color_override: bool | None = None) -> argparse.Namespace:
    print("PARAM FORGE")
    for line in _version_text_lines():
        print(line)
    print("Test image-gen APIs and capture receipts that help configure calls.")
    try:
        fd = sys.stdin.fileno()
        original = termios.tcgetattr(fd)
    except Exception:
        return _interactive_args_simple()
    with _RawMode(fd, original):
        experiment_selected = False
        while True:
            mode = _select_from_list("Mode", ["Optimize", "Batch run", "API Explore"], 0)
            if mode.lower() == "batch run":
                experiment_selected = True
                break
            if mode.lower() == "api explore":
                _show_api_explore_raw()
                continue
            break
    if experiment_selected:
        return _interactive_experiment_args_simple()
    provider = _select_from_list("Provider", _provider_display_choices(), 0)
    provider = _provider_from_display(provider)
    model = _select_from_list("Model", _model_choices_for(provider), 0)
    prompt_text = _select_text("Prompt (press Enter to use default prompt)", DEFAULT_PROMPTS[0])
    size_label = _select_from_list("Size", _size_label_choices(), 0)
    size = _size_value_from_label(size_label)
    n = _select_int("Images per prompt", 1, minimum=1, maximum=4)
    out_choice = _select_from_list("Output dir", OUT_DIR_CHOICES, 0)
    return _build_interactive_namespace(provider, model, prompt_text, size, n, out_choice)


def _interactive_args_simple() -> argparse.Namespace:
    print("PARAM FORGE (simple mode)")
    for line in _version_text_lines():
        print(line)
    print("Type a number and press Enter. Press Enter to accept defaults.")

    while True:
        mode = _prompt_choice("Mode", ["Optimize", "Batch run", "API Explore"], 0)
        if mode.lower() == "batch run":
            return _interactive_experiment_args_simple()
        if mode.lower() == "api explore":
            _show_api_explore_raw()
            continue
        break
    provider = _prompt_choice("Provider", _provider_display_choices(), 0)
    provider = _provider_from_display(provider)
    model = _prompt_choice("Model", _model_choices_for(provider), 0)
    prompt_text = _prompt_text("Prompt (press Enter to use default prompt)", DEFAULT_PROMPTS[0])
    size_label = _prompt_choice("Size", _size_label_choices(), 0)
    size = _size_value_from_label(size_label)
    n = _prompt_int("Images per prompt", 1, minimum=1, maximum=4)
    out_choice = _prompt_choice("Output dir", OUT_DIR_CHOICES, 0)
    return _build_interactive_namespace(provider, model, prompt_text, size, n, out_choice)


def _prompt_choice(label: str, choices: list[str], default_index: int = 0) -> str:
    while True:
        print(f"{label}:")
        for idx, choice in enumerate(choices, start=1):
            suffix = " (default)" if idx - 1 == default_index else ""
            print(f"  {idx}. {choice}{suffix}")
        try:
            response = input(f"Select {label} [default {default_index + 1}]: ").strip()
        except EOFError:
            raise KeyboardInterrupt from None
        if response == "":
            return choices[default_index]
        if response.isdigit():
            selected = int(response)
            if 1 <= selected <= len(choices):
                return choices[selected - 1]


def _prompt_multi_select(
    label: str,
    choices: list[str],
    *,
    default_indices: list[int] | None = None,
) -> list[str]:
    if default_indices is None:
        default_indices = []
    default_indices = [i for i in default_indices if 0 <= i < len(choices)]
    default_display = ", ".join(str(i + 1) for i in default_indices) if default_indices else "none"
    while True:
        print(f"{label} (comma-separated numbers):")
        for idx, choice in enumerate(choices, start=1):
            marker = " (default)" if idx - 1 in default_indices else ""
            print(f"  {idx}. {choice}{marker}")
        try:
            response = input(f"Select {label} [default {default_display}]: ").strip()
        except EOFError:
            raise KeyboardInterrupt from None
        if response == "":
            if default_indices:
                return [choices[i] for i in default_indices]
            return []
        parts = [part.strip() for part in response.split(",") if part.strip()]
        indices: list[int] = []
        valid = True
        for part in parts:
            if not part.isdigit():
                valid = False
                break
            value = int(part)
            if not (1 <= value <= len(choices)):
                valid = False
                break
            indices.append(value - 1)
        if not valid:
            print("Please enter valid numbers separated by commas.")
            continue
        selected = [choices[i] for i in indices]
        return list(dict.fromkeys(selected))
        print("Invalid choice. Try again.")


def _prompt_int(label: str, default: int, minimum: int = 1, maximum: int = 6) -> int:
    while True:
        try:
            response = input(f"{label} [{default}]: ").strip()
        except EOFError:
            raise KeyboardInterrupt from None
        if response == "":
            return default
        try:
            value = int(response)
        except ValueError:
            print("Please enter a number.")
            continue
        if minimum <= value <= maximum:
            return value
        print(f"Enter a number between {minimum} and {maximum}.")


def _prompt_text(label: str, default: str) -> str:
    while True:
        try:
            response = input(f"{label}: ").strip()
        except EOFError:
            raise KeyboardInterrupt from None
        if response == "":
            return default
        return response


def _default_experiment_out_dir() -> str:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    return f"runs/experiment_{stamp}"


def _build_experiment_namespace(
    *,
    prompts_path: str | None,
    prompt_text: str | None,
    matrix_payload: dict | None,
    matrix_path: str | None,
    out_dir: str,
    concurrency: int | None,
    provider_concurrency: str | None,
    budget: float | None,
    budget_mode: str | None,
    dry_run: bool,
    resume: bool,
) -> argparse.Namespace:
    return argparse.Namespace(
        mode="experiment",
        prompts=prompts_path,
        prompt_text=prompt_text,
        matrix_payload=matrix_payload,
        matrix=matrix_path,
        out=out_dir,
        concurrency=concurrency,
        provider_concurrency=provider_concurrency,
        budget=budget,
        budget_mode=budget_mode,
        dry_run=dry_run,
        resume=resume,
    )


def _run_experiment_from_namespace(args: argparse.Namespace) -> int:
    argv: list[str] = []
    if getattr(args, "resume", False):
        argv.append("--resume")
    prompts_path = getattr(args, "prompts", None)
    prompt_text = getattr(args, "prompt_text", None)
    if not prompts_path and not getattr(args, "resume", False):
        text = str(prompt_text or DEFAULT_PROMPTS[0]).strip()
        if text:
            run_dir = Path(str(args.out)).expanduser().resolve()
            run_dir.mkdir(parents=True, exist_ok=True)
            prompt_line = " ".join(text.splitlines()).strip()
            filename = "prompts-inline.txt"
            prompt_path = run_dir / filename
            if prompt_path.exists():
                stamp = time.strftime("%Y%m%d_%H%M%S")
                prompt_path = run_dir / f"prompts-inline-{stamp}.txt"
            prompt_path.write_text(prompt_line + "\n", encoding="utf-8")
            prompts_path = str(prompt_path)
    if prompts_path:
        argv += ["--prompts", str(prompts_path)]
    matrix_path = getattr(args, "matrix", None)
    matrix_payload = getattr(args, "matrix_payload", None)
    if not matrix_path and matrix_payload and not getattr(args, "resume", False):
        run_dir = Path(str(args.out)).expanduser().resolve()
        run_dir.mkdir(parents=True, exist_ok=True)
        filename = "matrix-inline.json"
        out_path = run_dir / filename
        if out_path.exists():
            stamp = time.strftime("%Y%m%d_%H%M%S")
            out_path = run_dir / f"matrix-inline-{stamp}.json"
        out_path.write_text(json.dumps(matrix_payload, indent=2) + "\n", encoding="utf-8")
        matrix_path = str(out_path)
    if matrix_path:
        argv += ["--matrix", str(matrix_path)]
    argv += ["--out", str(args.out)]
    if getattr(args, "concurrency", None) is not None:
        argv += ["--concurrency", str(args.concurrency)]
    if getattr(args, "provider_concurrency", None):
        argv += ["--provider-concurrency", str(args.provider_concurrency)]
    if getattr(args, "budget", None) is not None:
        argv += ["--budget", str(args.budget)]
    if getattr(args, "budget_mode", None):
        argv += ["--budget-mode", str(args.budget_mode)]
    if getattr(args, "dry_run", False):
        argv.append("--dry-run")
    cancel_event = getattr(args, "cancel_event", None)
    return _run_experiment_cli(argv, cancel_event=cancel_event)


def _interactive_experiment_args_simple() -> argparse.Namespace:
    print("PARAM FORGE (batch run)")
    for line in _version_text_lines():
        print(line)
    prompts_path: str | None = None
    prompt_text: str | None = None
    matrix_payload: dict | None = None
    source = _prompt_choice("Prompt source", ["single prompt", "prompts file"], 0)
    if source == "prompts file":
        while True:
            prompts_path = _prompt_text("Prompts file (.txt/.csv)", "")
            if not prompts_path:
                print("Prompts file is required.")
                continue
            if not Path(prompts_path).expanduser().exists():
                print(f"Prompts file not found: {prompts_path}")
                continue
            break
    else:
        prompt_text = _prompt_text("Prompt (press Enter to use default prompt)", DEFAULT_PROMPTS[0])
    matrix_path: str | None = None
    matrix_source = _prompt_choice("Matrix source", ["auto (select providers/models)", "matrix file"], 0)
    if matrix_source == "matrix file":
        while True:
            matrix_path = _prompt_text("Matrix file (.yaml/.json)", "matrix.yaml")
            if not matrix_path:
                print("Matrix file is required.")
                continue
            if not Path(matrix_path).expanduser().exists():
                print(f"Matrix file not found: {matrix_path}")
                continue
            break
    else:
        provider_display = _prompt_multi_select(
            "Providers",
            _provider_display_choices(),
            default_indices=[0],
        )
        provider_keys = [_provider_from_display(item) for item in provider_display]
        matrix_blocks: list[dict[str, object]] = []
        for provider_key in provider_keys:
            models = _prompt_multi_select(
                f"Models for {provider_key}",
                _model_choices_for(provider_key),
                default_indices=[0],
            )
            if not models:
                continue
            matrix_blocks.append(
                {
                    "provider": provider_key,
                    "model": models,
                }
            )
        if not matrix_blocks:
            print("No models selected; defaulting to openai gpt-image-1.5.")
            matrix_blocks = [{"provider": "openai", "model": ["gpt-image-1.5"]}]
        size_label = _prompt_choice("Size", _size_label_choices(), 0)
        size_value = _size_value_from_label(size_label)
        n_value = _prompt_int("Images per prompt", 1, minimum=1, maximum=4)
        matrix_payload = {
            "version": 1,
            "defaults": {"n": n_value},
            "matrix": [],
        }
        for block in matrix_blocks:
            matrix_payload["matrix"].append(
                {
                    "provider": block["provider"],
                    "model": block["model"],
                    "size": [size_value],
                }
            )
    out_dir = _prompt_text("Output run directory", _default_experiment_out_dir())
    resume = False
    while True:
        manifest_path = Path(out_dir).expanduser().resolve() / "run.json"
        if manifest_path.exists():
            choice = _prompt_choice("run.json exists. Resume?", ["yes", "no"], 0)
            if choice.lower().startswith("y"):
                resume = True
                break
            out_dir = _prompt_text("Output run directory", _default_experiment_out_dir())
            continue
        break
    concurrency = _prompt_int("Concurrency", _EXPERIMENT_DEFAULT_CONCURRENCY, minimum=1, maximum=64)
    provider_concurrency = _prompt_text(
        "Provider concurrency (optional, e.g. openai=1,gemini=2)",
        "",
    )
    budget = None
    while True:
        budget_text = _prompt_text("Budget USD (blank for none)", "")
        if not budget_text:
            break
        try:
            budget = float(budget_text)
            if budget < 0:
                raise ValueError("negative budget")
            break
        except Exception:
            print("Enter a non-negative number (or leave blank).")
    budget_mode = _prompt_choice("Budget mode", list(_EXPERIMENT_BUDGET_MODES), 0)
    dry_run_choice = _prompt_choice("Dry run", ["no", "yes"], 0)
    dry_run = dry_run_choice.lower().startswith("y")
    return _build_experiment_namespace(
        prompts_path=prompts_path,
        out_dir=out_dir,
        concurrency=concurrency,
        provider_concurrency=provider_concurrency or None,
        budget=budget,
        budget_mode=budget_mode,
        dry_run=dry_run,
        resume=resume,
        prompt_text=prompt_text,
        matrix_payload=matrix_payload,
        matrix_path=matrix_path,
    )


def _build_interactive_namespace(
    provider: str,
    model: str | None,
    prompt_text: str,
    size: str,
    n: int,
    out_choice: str,
) -> argparse.Namespace:
    prompt_text = (prompt_text or "").strip()
    prompts = [prompt_text] if prompt_text else list(DEFAULT_PROMPTS)
    out_dir = "outputs/param_forge"
    if out_choice == "outputs/param_forge_dated":
        stamp = time.strftime("%Y%m%d_%H%M%S")
        out_dir = f"outputs/param_forge/{stamp}"
    resolved_provider, resolved_model = _normalize_provider_and_model(provider, model)
    return argparse.Namespace(
        prompt=prompts,
        provider=resolved_provider,
        size=size,
        n=n,
        out=out_dir,
        model=resolved_model,
        provider_options={},
        seed=None,
        output_format=None,
        background=None,
        analyzer=_resolve_receipt_analyzer(None),
        interactive=True,
        defaults=False,
        no_color=False,
        openai_stream=_env_flag(OPENAI_STREAM_ENV),
        openai_responses=_env_flag(OPENAI_RESPONSES_ENV),
    )


def _interactive_args(color_override: bool | None = None) -> argparse.Namespace:
    try:
        import curses
    except Exception:
        return _interactive_args_raw(color_override=color_override)
    raise RuntimeError("Interactive curses selection must be run inside a curses session.")


def _interactive_args_curses(stdscr, color_override: bool | None = None) -> argparse.Namespace:
    import curses
    _init_locale()
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    stdscr.keypad(True)
    stdscr.timeout(80)
    try:
        curses.mousemask(curses.ALL_MOUSE_EVENTS | curses.REPORT_MOUSE_POSITION)
    except Exception:
        pass
    height, width = stdscr.getmaxyx()
    if width < _MIN_CURSES_WIDTH or height < _MIN_CURSES_HEIGHT:
        raise _CursesFallback(
            f"terminal too small ({width}x{height}, need {_MIN_CURSES_WIDTH}x{_MIN_CURSES_HEIGHT})"
        )
    color_enabled = (color_override is None and curses.has_colors()) or (color_override is True)
    if color_enabled:
        curses.start_color()
        curses.use_default_colors()
        base_colors = [
            curses.COLOR_RED,
            curses.COLOR_YELLOW,
            curses.COLOR_GREEN,
            curses.COLOR_CYAN,
            curses.COLOR_BLUE,
            curses.COLOR_MAGENTA,
        ]
        for idx, color in enumerate(base_colors, start=1):
            curses.init_pair(idx, color, -1)
        highlight_pair = len(base_colors) + 1
        done_pair = highlight_pair + 1
        curses.init_pair(highlight_pair, curses.COLOR_CYAN, -1)
        curses.init_pair(done_pair, curses.COLOR_GREEN, -1)
    else:
        highlight_pair = 0
        done_pair = 0

    mode_idx = 0
    provider_idx = 0
    model_idx = 0
    prompt_text = DEFAULT_PROMPTS[0]
    size_idx = 0
    count_value = 1
    out_idx = 0
    field_idx = 0
    provider_display_choices = _provider_display_choices()
    mode_choices = ["Optimize", "Batch run", "API Explore"]

    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        provider_selected = field_idx > 1
        if provider_selected:
            model_choices = _model_choices_for(PROVIDER_CHOICES[provider_idx])
        else:
            model_choices = ["(select provider)"]
        size_choices = _size_label_choices()
        if model_idx >= len(model_choices):
            model_idx = 0
        y = 0
        if color_enabled and curses.has_colors():
            try:
                curses.init_pair(99, curses.COLOR_RED, -1)
            except curses.error:
                pass
        for line in _BANNER:
            if y >= height:
                break
            truncated = line[: max(0, width - 1)]
            if color_enabled and curses.has_colors():
                for i, ch in enumerate(truncated):
                    if i >= width - 1:
                        break
                    try:
                        stdscr.addstr(y, i, ch, curses.color_pair(99) | curses.A_BOLD)
                    except curses.error:
                        pass
            else:
                try:
                    stdscr.addstr(y, 0, truncated)
                except curses.error:
                    pass
            y += 1
        version_attr = curses.A_DIM
        for line in _banner_version_lines(width):
            if y >= height:
                break
            try:
                stdscr.addstr(y, 0, line[: max(0, width - 1)], version_attr)
            except curses.error:
                pass
            y += 1
        if y < height - 1:
            y += 1
        y = _draw_choice_line(
            stdscr,
            y,
            "Mode",
            mode_choices,
            mode_idx,
            field_idx == 0,
            field_idx,
            0,
            highlight_pair,
            done_pair,
            color_enabled,
        )
        if mode_idx == 0:
            hint = "Identify optimal API settings for your goal: lower cost, faster render, etc."
        elif mode_idx == 1:
            hint = "Batch-run prompt sets across a matrix."
        else:
            hint = "Browse provider/model parameters and cost notes."
        _safe_addstr(stdscr, y, 4, hint[: max(0, width - 5)], curses.A_BOLD)
        y += 2
        if field_idx >= 1:
            y = _draw_choice_line(
                stdscr,
                y,
                "Provider",
                provider_display_choices,
                provider_idx,
                field_idx == 1,
                field_idx,
                1,
                highlight_pair,
                done_pair,
                color_enabled,
            )
            y = _draw_choice_line(
                stdscr,
                y,
                "Model",
                model_choices,
                model_idx,
                field_idx == 2,
                field_idx,
                2,
                highlight_pair,
                done_pair,
                color_enabled,
            )
            y = _draw_prompt_line(
                stdscr,
                y,
                "Prompt",
                prompt_text,
                DEFAULT_PROMPTS[0],
                field_idx == 3,
                field_idx,
                3,
                highlight_pair,
                done_pair,
                color_enabled,
                hint_text="Press (n) to input custom prompt • Enter: use default prompt",
            )
            y = _draw_choice_column(
                stdscr,
                y,
                "Size",
                size_choices,
                size_idx,
                field_idx == 4,
                field_idx,
                4,
                highlight_pair,
                done_pair,
                color_enabled,
                max_visible=6,
            )
            y = _draw_count_line(
                stdscr,
                y,
                "Images per prompt",
                count_value,
                field_idx == 5,
                field_idx,
                5,
                highlight_pair,
                done_pair,
                color_enabled,
            )
            _draw_choice_line(
                stdscr,
                y,
                "Output dir",
                OUT_DIR_CHOICES,
                out_idx,
                field_idx == 6,
                field_idx,
                6,
                highlight_pair,
                done_pair,
                color_enabled,
            )
        stdscr.refresh()

        key = stdscr.getch()
        if key == -1:
            continue
        if _handle_capture_key(stdscr, key):
            continue
        if key == curses.KEY_MOUSE:
            try:
                _, _, _, _, bstate = curses.getmouse()
            except curses.error:
                continue
            if field_idx == 4:
                if bstate & curses.BUTTON5_PRESSED:
                    size_idx = (size_idx + 1) % len(size_choices)
                elif bstate & curses.BUTTON4_PRESSED:
                    size_idx = (size_idx - 1) % len(size_choices)
            continue
        if key in (ord("q"), ord("Q"), 27):
            raise KeyboardInterrupt
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            field_idx = max(0, field_idx - 1)
            continue
        if key in (curses.KEY_DOWN, ord("j"), ord("J")):
            if field_idx == 4:
                size_idx = (size_idx + 1) % len(size_choices)
            continue
        if key in (curses.KEY_LEFT, ord("h"), ord("H"), ord("a"), ord("A")):
            if field_idx == 0:
                mode_idx = (mode_idx - 1) % len(mode_choices)
            elif field_idx == 1:
                provider_idx = (provider_idx - 1) % len(PROVIDER_CHOICES)
                model_idx = 0
            elif field_idx == 2:
                model_idx = (model_idx - 1) % len(model_choices)
            elif field_idx == 4:
                size_idx = (size_idx - 1) % len(size_choices)
            elif field_idx == 5:
                count_value = max(1, count_value - 1)
            elif field_idx == 6:
                out_idx = (out_idx - 1) % len(OUT_DIR_CHOICES)
            continue
        if key in (curses.KEY_RIGHT, ord("l"), ord("L"), ord("d"), ord("D")):
            if field_idx == 0:
                mode_idx = (mode_idx + 1) % len(mode_choices)
            elif field_idx == 1:
                provider_idx = (provider_idx + 1) % len(PROVIDER_CHOICES)
                model_idx = 0
            elif field_idx == 2:
                model_idx = (model_idx + 1) % len(model_choices)
            elif field_idx == 4:
                size_idx = (size_idx + 1) % len(size_choices)
            elif field_idx == 5:
                count_value = min(4, count_value + 1)
            elif field_idx == 6:
                out_idx = (out_idx + 1) % len(OUT_DIR_CHOICES)
            continue
        if field_idx == 3 and key in (ord("n"), ord("N")):
            default_prompt = DEFAULT_PROMPTS[0]
            initial_text = ""
            if prompt_text and prompt_text.strip() != default_prompt.strip():
                initial_text = prompt_text
            prompt_text = _prompt_prompt_curses(
                stdscr,
                default_prompt=default_prompt,
                color_enabled=color_enabled,
                initial_text=initial_text,
            )
            field_idx = 4
            continue
        if key in (10, 13, curses.KEY_ENTER, ord("\t")):
            if field_idx == 0:
                selected_mode = mode_choices[mode_idx].lower()
                if selected_mode == "batch run":
                    return _interactive_experiment_args_curses(stdscr, color_enabled=color_enabled)
                if selected_mode == "api explore":
                    _show_api_explore_curses(stdscr, color_enabled=color_enabled)
                    field_idx = 0
                    continue
                field_idx = 1
                continue
            if field_idx == 3:
                if not prompt_text:
                    prompt_text = DEFAULT_PROMPTS[0]
                field_idx = 4
                continue
            if field_idx < 6:
                field_idx += 1
                continue
            return _build_interactive_namespace(
                PROVIDER_CHOICES[provider_idx],
                _model_choices_for(PROVIDER_CHOICES[provider_idx])[model_idx],
                prompt_text,
                _size_value_from_label(size_choices[size_idx]),
                count_value,
                OUT_DIR_CHOICES[out_idx],
            )


def _run_curses_flow(color_override: bool | None = None) -> int:
    _init_locale()
    try:
        import curses
    except Exception:
        return _run_raw_fallback("curses module unavailable", color_override)

    ok, reason = _curses_preflight()
    if not ok:
        return _run_raw_fallback(reason, color_override)

    result: dict[str, object] = {
        "open_path": None,
        "exit_code": 0,
        "ran": False,
        "error": None,
        "view_ready": False,
        "view_out_dir": None,
    }

    def _curses_flow(stdscr) -> None:
        try:
            curses.curs_set(0)
        except curses.error:
            pass
        stdscr.keypad(True)
        stdscr.timeout(100)
        color_enabled = (color_override is None and curses.has_colors()) or (color_override is True)
        if color_enabled:
            curses.start_color()
            curses.use_default_colors()
            curses.init_pair(1, curses.COLOR_RED, -1)
            curses.init_pair(2, curses.COLOR_CYAN, -1)
            curses.init_pair(3, curses.COLOR_GREEN, -1)
            curses.init_pair(4, curses.COLOR_YELLOW, -1)
        history_opt_in = _history_opt_in_value()
        history_session_id: str | None = None

        def _ensure_history_opt_in() -> bool:
            nonlocal history_opt_in, history_session_id
            if history_opt_in is None:
                history_opt_in = _prompt_yes_no_curses(
                    stdscr,
                    "Enable local history to improve future Optimize recommendations? (stores settings + metrics)",
                    color_enabled=color_enabled,
                    footer_line="Press Y to opt in, N/Esc to skip",
                )
                _persist_history_opt_in(history_opt_in)
            if history_opt_in and history_session_id is None:
                history_session_id = _new_history_session_id()
            return bool(history_opt_in)
        args = _interactive_args_curses(stdscr, color_override=color_override)
        result["ran"] = True
        if args is None:
            result["exit_code"] = 1
            return
        if getattr(args, "mode", "") == "experiment":
            result["view_out_dir"] = Path(args.out)
            result["exit_code"] = _run_experiment_curses(
                stdscr,
                args=args,
                color_enabled=color_enabled,
            )
            if _has_viewer_artifacts(Path(args.out)):
                result["view_ready"] = True
            return
        result["view_out_dir"] = Path(args.out)
        args.analyzer = _resolve_receipt_analyzer(getattr(args, "analyzer", None))
        try:
            _load_repo_dotenv()
            _ensure_api_keys(
                args.provider,
                _find_repo_dotenv(),
                allow_prompt=True,
                prompt_func=lambda key, path: _prompt_for_key_curses(stdscr, key, path),
            )
            from forge_image_api import generate, stream  # type: ignore
        except Exception as exc:
            result["exit_code"] = 1
            result["error"] = str(exc)
            stdscr.erase()
            height, width = stdscr.getmaxyx()
            error_line = f"Setup failed: {exc}"
            try:
                stdscr.addstr(0, 0, error_line[: max(0, width - 1)])
            except curses.error:
                pass
            stdscr.refresh()
            try:
                curses.flushinp()
            except curses.error:
                pass
            _wait_for_non_mouse_key(stdscr)
            return
        if not hasattr(args, "openai_stream"):
            args.openai_stream = _env_flag(OPENAI_STREAM_ENV)
        if not hasattr(args, "openai_responses"):
            args.openai_responses = _env_flag(OPENAI_RESPONSES_ENV)
        def _generate_once(
            round_index: int,
            prev_settings: dict[str, object] | None,
            history_lines: list[str],
            rationale_line: str | None,
            header_lines_override: list[str] | None = None,
        ) -> tuple[
            list[Path],
            list[Path],
            bool,
            int,
            float | None,
            dict[str, object],
            list[str],
            tuple[int | None, int | None],
        ]:
            stdscr.erase()
            height, width = stdscr.getmaxyx()
            stdscr.timeout(80)
            y = _draw_banner(stdscr, color_enabled, 1)
            if history_lines:
                for line in history_lines:
                    if y >= height - 2:
                        break
                    _safe_addstr(
                        stdscr,
                        y,
                        0,
                        line[: max(0, width - 1)],
                        curses.A_DIM,
                    )
                    y += 1
                if y < height - 1:
                    y += 1
            openai_stream, _ = _apply_openai_provider_flags(args)
            use_stream = bool(openai_stream and _is_openai_gpt_image(args.provider, args.model))
            current_settings = _capture_call_settings(args)
            y = _render_generation_header(
                stdscr,
                y=y,
                width=width,
                round_index=round_index,
                prev_settings=prev_settings,
                current_settings=current_settings,
                color_enabled=color_enabled,
                rationale_line=rationale_line,
                header_lines_override=header_lines_override,
            )
            if y < height - 1:
                try:
                    stdscr.addstr(
                        y,
                        0,
                        "Generating images... (press Q to cancel)"[: width - 1],
                    )
                except curses.error:
                    pass
                y += 1
            if y < height - 1:
                _safe_addstr(
                    stdscr,
                    y,
                    0,
                    "Prompts (sequence):"[: max(0, width - 1)],
                    curses.A_BOLD,
                )
                y += 1
            stdscr.refresh()

            receipts: list[Path] = []
            images: list[Path] = []
            cancel_requested = False
            last_elapsed: float | None = None
            adherence_scores: list[int | None] = []
            quality_scores: list[int | None] = []
            total_prompts = len(args.prompt)
            prompt_entries: dict[int, dict[str, object]] = {}
            max_prompt_width = max(20, width - 1)
            for idx, prompt in enumerate(args.prompt, start=1):
                lines = _prompt_status_lines(idx, total_prompts, prompt, "pending", max_prompt_width)
                if y + len(lines) >= height - 1:
                    remaining = total_prompts - idx + 1
                    if remaining > 0 and y < height - 1:
                        summary = f"... ({remaining} more prompts; resize terminal to view)"
                        _safe_addstr(
                            stdscr,
                            y,
                            0,
                            _truncate_text(summary, max_prompt_width),
                            curses.A_DIM,
                        )
                    break
                for line in lines:
                    _safe_addstr(
                        stdscr,
                        y,
                        0,
                        line,
                        _prompt_status_attr("pending", color_enabled),
                    )
                    y += 1
                prompt_entries[idx] = {"y": y - len(lines), "prompt": prompt, "lines": len(lines)}
            status_y = min(y + 1, height - 1)
            stdscr.refresh()

            for idx, prompt in enumerate(args.prompt, start=1):
                entry = prompt_entries.get(idx)
                if entry:
                    y_line = int(entry["y"])
                    lines = _prompt_status_lines(
                        idx, total_prompts, prompt, "current", max_prompt_width
                    )
                    for offset, line in enumerate(lines):
                        _safe_addstr(
                            stdscr,
                            y_line + offset,
                            0,
                            line,
                            _prompt_status_attr("current", color_enabled),
                        )
                    stdscr.refresh()

                result_holder: dict[str, object] = {}
                done = threading.Event()
                start = time.monotonic()

                def _run_generate() -> None:
                    try:
                        if use_stream:
                            results: list[object] = []
                            for event in stream(
                                prompt=prompt,
                                provider=args.provider,
                                size=args.size,
                                n=args.n,
                                out_dir=Path(args.out),
                                model=args.model,
                                provider_options=args.provider_options,
                                seed=args.seed,
                                output_format=getattr(args, "output_format", None),
                                background=getattr(args, "background", None),
                            ):
                                if event.type == "error":
                                    raise RuntimeError(event.message or "Streaming failed.")
                                if event.type == "final" and event.result is not None:
                                    results.append(event.result)
                            result_holder["results"] = results
                        else:
                            result_holder["results"] = generate(
                                prompt=prompt,
                                provider=args.provider,
                                size=args.size,
                                n=args.n,
                                out_dir=Path(args.out),
                                model=args.model,
                                provider_options=args.provider_options,
                                seed=args.seed,
                                output_format=getattr(args, "output_format", None),
                                background=getattr(args, "background", None),
                            )
                    except Exception as exc:
                        result_holder["error"] = exc
                    finally:
                        done.set()

                thread = threading.Thread(target=_run_generate, daemon=True)
                thread.start()

                frames = ["|", "/", "-", "\\"]
                frame_idx = 0
                local_cancel = False
                while not done.is_set():
                    elapsed = time.monotonic() - start
                    status = (
                        f"{frames[frame_idx % len(frames)]} Round {round_index} "
                        f"Prompt {idx}/{total_prompts} • Elapsed {elapsed:5.1f}s "
                        "(press Q to cancel)"
                    )
                    _write_status_line(
                        stdscr,
                        status_y,
                        _truncate_text(status, max(20, width - 1)),
                        width,
                    )
                    stdscr.refresh()
                    frame_idx += 1
                    key = stdscr.getch()
                    if _handle_capture_key(stdscr, key):
                        continue
                    if key in (ord("q"), ord("Q")):
                        local_cancel = True
                thread.join()

                elapsed = time.monotonic() - start
                last_elapsed = elapsed
                _write_status_line(
                    stdscr,
                    status_y,
                    _truncate_text(f"Done in {elapsed:5.1f}s", max(20, width - 1)),
                    width,
                )
                stdscr.refresh()
                if entry:
                    y_line = int(entry["y"])
                    lines = _prompt_status_lines(
                        idx, total_prompts, prompt, "done", max_prompt_width
                    )
                    for offset, line in enumerate(lines):
                        _safe_addstr(
                            stdscr,
                            y_line + offset,
                            0,
                            line,
                            _prompt_status_attr("done", color_enabled),
                        )
                    stdscr.refresh()

                if "error" in result_holder:
                    result["exit_code"] = 1
                    _safe_addstr(
                        stdscr,
                        min(height - 1, y + 2),
                        0,
                        f"Generation failed: {result_holder['error']}",
                    )
                    stdscr.refresh()
                    stdscr.timeout(-1)
                    _wait_for_non_mouse_key(stdscr)
                    return receipts, images, True, y + 2, last_elapsed, current_settings, []

                results = result_holder.get("results", [])
                for res in results:
                    receipts.append(Path(res.receipt_path))
                    images.append(Path(res.image_path))
                if results:
                    retrieval_enabled = _retrieval_score_enabled(args)
                    for res_idx, res in enumerate(results, start=1):
                        scoring_label = "Council scoring"
                        if retrieval_enabled:
                            scoring_label = "Council scoring + retrieval"
                        stamp_holder: dict[str, object] = {}
                        stamp_done = threading.Event()

                        def _run_stamp() -> None:
                            try:
                                stamp_holder["scores"] = _apply_snapshot_for_result(
                                    image_path=Path(res.image_path),
                                    receipt_path=Path(res.receipt_path),
                                    prompt=prompt,
                                    elapsed=elapsed,
                                    fallback_settings=_capture_call_settings(args),
                                    retrieval_enabled=retrieval_enabled,
                                )
                            except Exception as exc:
                                stamp_holder["error"] = exc
                            finally:
                                stamp_done.set()

                        threading.Thread(target=_run_stamp, daemon=True).start()
                        frames = ["|", "/", "-", "\\"]
                        frame_idx = 0
                        while not stamp_done.is_set():
                            status = (
                                f"Stamping snapshot {res_idx}/{len(results)} "
                                f"({scoring_label}) {frames[frame_idx % len(frames)]}"
                            )
                            _write_status_line(
                                stdscr,
                                status_y,
                                _truncate_text(status, max(20, width - 1)),
                                width,
                                curses.A_DIM,
                            )
                            stdscr.refresh()
                            frame_idx += 1
                            time.sleep(0.1)
                        scores = stamp_holder.get("scores") or (None, None)
                        adherence_scores.append(scores[0])
                        quality_scores.append(scores[1])

                if local_cancel:
                    cancel_requested = True
                    result["exit_code"] = 1
                    _safe_addstr(
                        stdscr,
                        min(height - 1, y + 2),
                        0,
                        "Cancel requested; stopping after current prompt.",
                    )
                    stdscr.refresh()
                    break

            y += 2
            if y >= height - 2:
                y = min(height - 2, max(0, height - 3))

            if cancel_requested:
                avg_adherence = _average_score(adherence_scores)
                avg_quality = _average_score(quality_scores)
                return (
                    receipts,
                    images,
                    cancel_requested,
                    min(y + 2, height - 2),
                    last_elapsed,
                    current_settings,
                    [],
                    (avg_adherence, avg_quality),
                )

            history_block: list[str] = []
            history_block.extend(
                _build_generation_header_lines(
                    round_index=round_index,
                    prev_settings=prev_settings,
                    current_settings=current_settings,
                    max_width=max_prompt_width,
                )
            )
            history_block.append("Prompts (sequence):")
            for idx, prompt in enumerate(args.prompt, start=1):
                history_block.extend(
                    _prompt_status_lines(
                        idx,
                        total_prompts,
                        prompt,
                        "done",
                        max_prompt_width,
                    )
                )
            if last_elapsed is not None:
                history_block.append(f"Completed in {last_elapsed:.1f}s")
            avg_adherence = _average_score(adherence_scores)
            avg_quality = _average_score(quality_scores)
            return (
                receipts,
                images,
                cancel_requested,
                min(y + 2, height - 2),
                last_elapsed,
                current_settings,
                history_block,
                (avg_adherence, avg_quality),
            )

        auto_analyze_next = False
        stored_goals: list[str] | None = None
        stored_notes: str | None = None
        emphasis_line: str | None = None
        stored_cost: str | None = None
        stored_speed_benchmark: float | None = None
        analysis_history: list[dict] = []
        baseline_settings: dict[str, object] | None = None
        baseline_image: Path | None = None
        compare_baseline: Path | None = None
        compare_round_start: int | None = None
        compare_round_end: int | None = None
        compare_next_open = False
        run_index = 1
        last_call_settings: dict[str, object] | None = None
        history_lines: list[str] = []
        pending_rationale: str | None = None
        while True:
            (
                receipts,
                images,
                cancel_requested,
                prompt_y,
                last_elapsed,
                last_call_settings,
                history_block,
                round_scores,
            ) = _generate_once(
                run_index,
                last_call_settings,
                history_lines,
                pending_rationale,
            )
            if receipts:
                result["view_ready"] = True
            pending_rationale = None
            if history_block:
                if history_lines:
                    history_lines.append("")
                history_lines.extend(history_block)
            if baseline_settings is None and last_call_settings:
                baseline_settings = dict(last_call_settings)
            if baseline_image is None and run_index == 1 and images:
                baseline_image = images[-1]
            stdscr.timeout(-1)
            if cancel_requested:
                height, width = stdscr.getmaxyx()
                _safe_addstr(stdscr, max(0, height - 2), 0, "Cancelled. Press any key to exit."[:width])
                stdscr.refresh()
                _wait_for_non_mouse_key(stdscr)
                return
            if images:
                if compare_next_open and compare_baseline and images[-1].exists():
                    left_label = _round_range_label(compare_round_start, compare_round_end)
                    right_label = f"Round {run_index}"
                    composite = _compose_side_by_side(
                        compare_baseline,
                        images[-1],
                        label_left=left_label,
                        label_right=right_label,
                        out_dir=Path(args.out),
                    )
                    if composite:
                        _open_path(composite)
                        compare_baseline = composite
                        compare_round_end = run_index
                    else:
                        _open_path(images[-1])
                    compare_next_open = False
                else:
                    _open_path(images[-1])
            if receipts:
                if auto_analyze_next:
                    if (
                        stored_goals
                        and "minimize time to render" in stored_goals
                        and stored_speed_benchmark is not None
                        and last_elapsed is not None
                        and last_elapsed < stored_speed_benchmark
                    ):
                        improvement = stored_speed_benchmark - last_elapsed
                        speed_note = (
                            f"Speed improved: {stored_speed_benchmark:.1f}s → {last_elapsed:.1f}s "
                            f"(-{improvement:.1f}s)."
                        )
                        if emphasis_line:
                            emphasis_line = f"{emphasis_line} {speed_note}"
                        else:
                            emphasis_line = speed_note
                    history_enabled = _ensure_history_opt_in()
                    local_history_text = None
                    if history_enabled:
                        local_history_text = _build_local_history_text(
                            provider=args.provider,
                            model=args.model,
                            user_goals=stored_goals,
                            exclude_session_id=history_session_id,
                            limit=HISTORY_PROMPT_LIMIT,
                        )
                    recommendation, cost_line, accepted, stop_recommended = _show_receipt_analysis_curses(
                        stdscr,
                        receipt_path=receipts[-1],
                        provider=args.provider,
                        model=args.model,
                        size=args.size,
                        n=args.n,
                        out_dir=str(args.out),
                        analyzer=getattr(args, "analyzer", None),
                        color_enabled=color_enabled,
                        user_goals=stored_goals,
                        user_notes=stored_notes,
                        analysis_history=analysis_history,
                        local_history_text=local_history_text,
                        emphasis_line=emphasis_line,
                        last_elapsed=last_elapsed,
                        last_cost=stored_cost,
                        benchmark_elapsed=stored_speed_benchmark,
                        round_scores=round_scores,
                    )
                    retrieval_score = _load_retrieval_score(receipts[-1]) if receipts else None
                    _append_analysis_history(
                        analysis_history,
                        round_index=run_index,
                        settings=last_call_settings,
                        recommendations=recommendation,
                        accepted=accepted,
                        elapsed=last_elapsed,
                        cost_line=cost_line,
                        adherence=round_scores[0],
                        quality=round_scores[1],
                        retrieval=retrieval_score,
                    )
                    history_record = _build_history_record(
                        session_id=history_session_id,
                        round_index=run_index,
                        provider=args.provider,
                        model=args.model,
                        size=args.size,
                        n=args.n,
                        settings=last_call_settings,
                        user_goals=stored_goals,
                        user_notes=stored_notes,
                        recommendation=recommendation,
                        accepted=accepted,
                        elapsed=last_elapsed,
                        cost_line=cost_line,
                        adherence=round_scores[0],
                        quality=round_scores[1],
                        retrieval=retrieval_score,
                    )
                    _maybe_log_history_record(history_enabled, history_record)
                    if cost_line:
                        stored_cost = cost_line.replace("COST:", "").strip()
                    if run_index >= MAX_ROUNDS:
                        if _final_summary_enabled():
                            base_settings = last_call_settings or _capture_call_settings(args)
                            best_entry = _best_round_from_history(analysis_history, stored_goals)
                            best_round = None
                            best_settings = base_settings
                            best_elapsed = last_elapsed
                            best_cost_line = cost_line
                            best_quality = None
                            best_adherence = None
                            best_retrieval = None
                            if isinstance(best_entry, dict):
                                entry_round = best_entry.get("round")
                                if isinstance(entry_round, int):
                                    best_round = entry_round
                                entry_settings = best_entry.get("settings_dict")
                                if isinstance(entry_settings, dict):
                                    best_settings = entry_settings
                                entry_elapsed = best_entry.get("elapsed")
                                if isinstance(entry_elapsed, (int, float)):
                                    best_elapsed = float(entry_elapsed)
                                entry_cost = best_entry.get("cost")
                                if isinstance(entry_cost, str):
                                    best_cost_line = entry_cost
                                entry_quality = best_entry.get("quality")
                                if isinstance(entry_quality, int):
                                    best_quality = entry_quality
                                entry_adherence = best_entry.get("adherence")
                                if isinstance(entry_adherence, int):
                                    best_adherence = entry_adherence
                                entry_retrieval = best_entry.get("retrieval")
                                if isinstance(entry_retrieval, int):
                                    best_retrieval = entry_retrieval
                            quality_baseline, _ = _quality_from_history(analysis_history)
                            adherence_baseline, _ = _adherence_from_history(analysis_history)
                            retrieval_baseline, _ = _retrieval_from_history(analysis_history)
                            quality_current = best_quality
                            adherence_current = best_adherence
                            retrieval_current = best_retrieval
                            baseline_elapsed, baseline_cost_line = _baseline_metrics_from_history(analysis_history)
                            summary_note = None
                            final_recommendation = None
                            metrics_settings = best_settings
                            last_round = run_index if isinstance(run_index, int) else None
                            if best_round is not None and last_round is not None and best_round != last_round:
                                summary_note = f"Best tested round: {best_round} (last round: {last_round})."
                            if recommendation:
                                rec_note = (
                                    "Recommendations accepted but not re-tested; final call reflects best tested settings."
                                    if accepted
                                    else "Pending recommendations not applied; final call reflects best tested settings."
                                )
                                summary = _recommendations_summary(recommendation)
                                if summary:
                                    rec_note = f"{rec_note} Suggested: {summary}."
                                if summary_note:
                                    summary_note = f"{summary_note} {rec_note}"
                                else:
                                    summary_note = rec_note
                            _show_final_recommendation_curses(
                                stdscr,
                                settings=best_settings,
                                recommendation=final_recommendation,
                                user_goals=stored_goals,
                                color_enabled=color_enabled,
                                last_elapsed=best_elapsed,
                                cost_line=best_cost_line,
                                baseline_elapsed=baseline_elapsed,
                                baseline_cost_line=baseline_cost_line,
                                quality_baseline=quality_baseline,
                                quality_current=quality_current,
                                adherence_baseline=adherence_baseline,
                                adherence_current=adherence_current,
                                retrieval_baseline=retrieval_baseline,
                                retrieval_current=retrieval_current,
                                receipt_path=receipts[-1] if receipts else None,
                                baseline_settings=baseline_settings,
                                force_quality_metrics=bool(stored_goals and "maximize quality of render" in stored_goals),
                                summary_note=summary_note,
                                metrics_settings=metrics_settings,
                            )
                        return
                    if accepted and recommendation:
                        if _apply_recommendation(args, recommendation):
                            pending_rationale = _recommendations_rationale(recommendation)
                            goals_text = ", ".join(stored_goals) if stored_goals else "your goal"
                            summary = _recommendations_summary(recommendation)
                            if summary:
                                emphasis_line = f"Net effect: {summary} → {goals_text}"
                            else:
                                emphasis_line = f"Net effect: updates applied → {goals_text}"
                            normalized = _normalize_recommendations(recommendation)
                            if len(normalized) == 1:
                                rationale = normalized[0].get("rationale")
                                if isinstance(rationale, str) and rationale.strip():
                                    emphasis_line = f"{emphasis_line}. {rationale.strip()}"
                            if stored_goals and "minimize time to render" in stored_goals:
                                stored_speed_benchmark = last_elapsed
                            if images:
                                if compare_baseline is None:
                                    compare_baseline = images[-1]
                                    compare_round_start = run_index
                                    compare_round_end = run_index
                                compare_next_open = True
                            auto_analyze_next = True
                            run_index += 1
                            continue
                    return
                height, width = stdscr.getmaxyx()
                attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
                hot_attr = curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD
                prompt_line = "View receipt (v), analyze receipt (a), any other key = exit"
                line_y = max(0, min(prompt_y, height - 2))
                _safe_addstr(stdscr, line_y, 0, prompt_line[:width], attr)
                v_pos = prompt_line.find("(v)")
                a_pos = prompt_line.find("(a)")
                if v_pos != -1 and v_pos + 2 < width:
                    _safe_addstr(stdscr, line_y, v_pos + 1, "v", hot_attr)
                if a_pos != -1 and a_pos + 2 < width:
                    _safe_addstr(stdscr, line_y, a_pos + 1, "a", hot_attr)
                stdscr.refresh()
                key = _wait_for_non_mouse_key(stdscr)
                if key in (ord("v"), ord("V")):
                    result["open_path"] = receipts[-1]
                    return
                if key in (ord("a"), ord("A")):
                    goals_result = _prompt_goal_selection_curses(stdscr, color_enabled)
                    if goals_result is None:
                        return
                    user_goals, user_notes = goals_result
                    stored_goals = user_goals
                    stored_notes = user_notes
                    history_enabled = _ensure_history_opt_in()
                    local_history_text = None
                    if history_enabled:
                        local_history_text = _build_local_history_text(
                            provider=args.provider,
                            model=args.model,
                            user_goals=user_goals,
                            exclude_session_id=history_session_id,
                            limit=HISTORY_PROMPT_LIMIT,
                        )
                    recommendation, cost_line, accepted, stop_recommended = _show_receipt_analysis_curses(
                        stdscr,
                        receipt_path=receipts[-1],
                        provider=args.provider,
                        model=args.model,
                        size=args.size,
                        n=args.n,
                        out_dir=str(args.out),
                        analyzer=getattr(args, "analyzer", None),
                        color_enabled=color_enabled,
                        user_goals=user_goals,
                        user_notes=user_notes,
                        analysis_history=analysis_history,
                        local_history_text=local_history_text,
                        last_elapsed=last_elapsed,
                        last_cost=stored_cost,
                        benchmark_elapsed=stored_speed_benchmark,
                        round_scores=round_scores,
                    )
                    retrieval_score = _load_retrieval_score(receipts[-1]) if receipts else None
                    _append_analysis_history(
                        analysis_history,
                        round_index=run_index,
                        settings=last_call_settings,
                        recommendations=recommendation,
                        accepted=accepted,
                        elapsed=last_elapsed,
                        cost_line=cost_line,
                        adherence=round_scores[0],
                        quality=round_scores[1],
                        retrieval=retrieval_score,
                    )
                    history_record = _build_history_record(
                        session_id=history_session_id,
                        round_index=run_index,
                        provider=args.provider,
                        model=args.model,
                        size=args.size,
                        n=args.n,
                        settings=last_call_settings,
                        user_goals=user_goals,
                        user_notes=user_notes,
                        recommendation=recommendation,
                        accepted=accepted,
                        elapsed=last_elapsed,
                        cost_line=cost_line,
                        adherence=round_scores[0],
                        quality=round_scores[1],
                        retrieval=retrieval_score,
                    )
                    _maybe_log_history_record(history_enabled, history_record)
                    if cost_line:
                        stored_cost = cost_line.replace("COST:", "").strip()
                    if run_index >= MAX_ROUNDS:
                        if _final_summary_enabled():
                            base_settings = last_call_settings or _capture_call_settings(args)
                            best_entry = _best_round_from_history(analysis_history, user_goals)
                            best_round = None
                            best_settings = base_settings
                            best_elapsed = last_elapsed
                            best_cost_line = cost_line
                            best_quality = None
                            best_adherence = None
                            best_retrieval = None
                            if isinstance(best_entry, dict):
                                entry_round = best_entry.get("round")
                                if isinstance(entry_round, int):
                                    best_round = entry_round
                                entry_settings = best_entry.get("settings_dict")
                                if isinstance(entry_settings, dict):
                                    best_settings = entry_settings
                                entry_elapsed = best_entry.get("elapsed")
                                if isinstance(entry_elapsed, (int, float)):
                                    best_elapsed = float(entry_elapsed)
                                entry_cost = best_entry.get("cost")
                                if isinstance(entry_cost, str):
                                    best_cost_line = entry_cost
                                entry_quality = best_entry.get("quality")
                                if isinstance(entry_quality, int):
                                    best_quality = entry_quality
                                entry_adherence = best_entry.get("adherence")
                                if isinstance(entry_adherence, int):
                                    best_adherence = entry_adherence
                                entry_retrieval = best_entry.get("retrieval")
                                if isinstance(entry_retrieval, int):
                                    best_retrieval = entry_retrieval
                            quality_baseline, _ = _quality_from_history(analysis_history)
                            adherence_baseline, _ = _adherence_from_history(analysis_history)
                            retrieval_baseline, _ = _retrieval_from_history(analysis_history)
                            quality_current = best_quality
                            adherence_current = best_adherence
                            retrieval_current = best_retrieval
                            baseline_elapsed, baseline_cost_line = _baseline_metrics_from_history(analysis_history)
                            summary_note = None
                            final_recommendation = None
                            metrics_settings = best_settings
                            last_round = run_index if isinstance(run_index, int) else None
                            if best_round is not None and last_round is not None and best_round != last_round:
                                summary_note = f"Best tested round: {best_round} (last round: {last_round})."
                            if recommendation:
                                rec_note = (
                                    "Recommendations accepted but not re-tested; final call reflects best tested settings."
                                    if accepted
                                    else "Pending recommendations not applied; final call reflects best tested settings."
                                )
                                summary = _recommendations_summary(recommendation)
                                if summary:
                                    rec_note = f"{rec_note} Suggested: {summary}."
                                if summary_note:
                                    summary_note = f"{summary_note} {rec_note}"
                                else:
                                    summary_note = rec_note
                            _show_final_recommendation_curses(
                                stdscr,
                                settings=best_settings,
                                recommendation=final_recommendation,
                                user_goals=user_goals,
                                color_enabled=color_enabled,
                                last_elapsed=best_elapsed,
                                cost_line=best_cost_line,
                                baseline_elapsed=baseline_elapsed,
                                baseline_cost_line=baseline_cost_line,
                                quality_baseline=quality_baseline,
                                quality_current=quality_current,
                                adherence_baseline=adherence_baseline,
                                adherence_current=adherence_current,
                                retrieval_baseline=retrieval_baseline,
                                retrieval_current=retrieval_current,
                                receipt_path=receipts[-1] if receipts else None,
                                baseline_settings=baseline_settings,
                                force_quality_metrics=bool(user_goals and "maximize quality of render" in user_goals),
                                summary_note=summary_note,
                                metrics_settings=metrics_settings,
                            )
                        return
                    if accepted and recommendation:
                        if _apply_recommendation(args, recommendation):
                            pending_rationale = _recommendations_rationale(recommendation)
                            goals_text = ", ".join(user_goals) if user_goals else "your goal"
                            summary = _recommendations_summary(recommendation)
                            if summary:
                                emphasis_line = f"Net effect: {summary} → {goals_text}"
                            else:
                                emphasis_line = f"Net effect: updates applied → {goals_text}"
                            normalized = _normalize_recommendations(recommendation)
                            if len(normalized) == 1:
                                rationale = normalized[0].get("rationale")
                                if isinstance(rationale, str) and rationale.strip():
                                    emphasis_line = f"{emphasis_line}. {rationale.strip()}"
                            auto_analyze_next = True
                            if user_goals and "minimize time to render" in user_goals:
                                stored_speed_benchmark = last_elapsed
                            if images:
                                if compare_baseline is None:
                                    compare_baseline = images[-1]
                                    compare_round_start = run_index
                                    compare_round_end = run_index
                                compare_next_open = True
                            run_index += 1
                            continue
                return
            else:
                height, width = stdscr.getmaxyx()
                _safe_addstr(
                    stdscr,
                    max(0, height - 2),
                    0,
                    "No receipts produced. Press any key to exit."[:width],
                )
                stdscr.refresh()
                _wait_for_non_mouse_key(stdscr)
                return

    try:
        curses.wrapper(_curses_flow)
    except _CursesFallback as exc:
        return _run_raw_fallback(str(exc), color_override)
    except curses.error as exc:
        return _run_raw_fallback(str(exc), color_override)
    except Exception as exc:
        # If curses fails (Terminal app quirks), fall back to raw interactive flow.
        return _run_raw_fallback(str(exc), color_override)
    if not result.get("ran"):
        return _run_raw_fallback("curses flow did not start", color_override)
    if result.get("error"):
        print(f"Setup failed: {result['error']}")
    if result.get("open_path"):
        _open_path(Path(result["open_path"]))  # type: ignore[arg-type]
    if result.get("view_ready") and result.get("view_out_dir"):
        _print_view_command(Path(result["view_out_dir"]))  # type: ignore[arg-type]
    return int(result.get("exit_code", 0))


def _run_raw_fallback(reason: str | None, color_override: bool | None) -> int:
    if reason:
        reason = reason.strip()
    if reason:
        print(f"Curses UI unavailable ({reason}). Falling back to raw prompts.")
    try:
        args = _interactive_args_raw(color_override=color_override)
    except KeyboardInterrupt:
        print("\nCancelled.")
        return 1
    except Exception as exc:
        print(f"Raw prompt failed ({exc}). Falling back to simple prompts.")
        args = _interactive_args_simple()
    if getattr(args, "mode", "") == "experiment":
        exit_code = _run_experiment_from_namespace(args)
        _print_view_command(Path(args.out))
        return exit_code
    exit_code = _run_generation(args)
    _print_view_command(Path(args.out))
    return exit_code


def _safe_addstr(stdscr, y: int, x: int, text: str, attr: int = 0) -> None:
    import curses
    height, width = stdscr.getmaxyx()
    if y < 0 or x < 0 or y >= height or x >= width:
        return
    try:
        stdscr.addstr(y, x, text[: max(0, width - x - 1)], attr)
    except curses.error:
        pass


def _write_status_line(stdscr, y: int, text: str, width: int, attr: int = 0) -> None:
    if width <= 1:
        _safe_addstr(stdscr, y, 0, text, attr)
        return
    padded = text.ljust(max(0, width - 1))
    _safe_addstr(stdscr, y, 0, padded, attr)


def _wait_for_non_mouse_key(stdscr) -> int:
    import curses
    while True:
        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key == curses.KEY_MOUSE:
            try:
                curses.getmouse()
            except Exception:
                pass
            continue
        return key


def _print_lines_to_console(stdscr, title: str, lines: list[str]) -> None:
    import curses
    try:
        curses.def_prog_mode()
        curses.endwin()
    except Exception:
        pass
    print(f"\n{title}")
    if lines:
        for line in lines:
            print(line)
    else:
        print("(no content)")
    try:
        input("\nPress Enter to return...")
    except EOFError:
        pass
    try:
        curses.reset_prog_mode()
        curses.curs_set(0)
        stdscr.clear()
        stdscr.refresh()
    except Exception:
        pass


def _line_text_and_attr(line: object, *, color_enabled: bool) -> tuple[str, int]:
    import curses
    if isinstance(line, tuple) and len(line) == 2 and isinstance(line[0], str):
        text, tag = line
        if tag == "change":
            attr = curses.color_pair(3) | curses.A_BOLD if color_enabled else curses.A_BOLD
            return text, attr
        if tag == "param":
            attr = curses.color_pair(2) | curses.A_BOLD if color_enabled else curses.A_BOLD
            return text, attr
        if tag == "desc":
            attr = curses.A_DIM
            return text, attr
        if tag == "goal":
            attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
            return text, attr
        if tag == "section":
            return text, curses.A_BOLD
        return text, curses.A_NORMAL
    return str(line), curses.A_NORMAL


def _banner_version_lines(width: int) -> list[str]:
    current_label = f"{_VERSION_CURRENT[0]} — {_VERSION_CURRENT[1]}"
    prev_label = " / ".join(f"{ver} {name}" for ver, name in _VERSION_HISTORY)
    lines = [
        f"{current_label}",
        f"prev: {prev_label}" if prev_label else "prev: (none)",
    ]
    return [line[: max(0, width - 1)] for line in lines]


def _version_text_lines() -> list[str]:
    return _banner_version_lines(10_000)


def _draw_banner(stdscr, color_enabled: bool, color_pair: int = 1) -> int:
    import curses
    height, width = stdscr.getmaxyx()
    y = 0
    for line in _BANNER:
        if y >= height:
            break
        truncated = line[: max(0, width - 1)]
        if color_enabled:
            for i, ch in enumerate(truncated):
                if i >= width - 1:
                    break
                try:
                    stdscr.addstr(y, i, ch, curses.color_pair(color_pair) | curses.A_BOLD)
                except curses.error:
                    pass
        else:
            try:
                stdscr.addstr(y, 0, truncated)
            except curses.error:
                pass
        y += 1
    version_attr = curses.A_DIM
    for line in _banner_version_lines(width):
        if y >= height:
            break
        try:
            stdscr.addstr(y, 0, line[: max(0, width - 1)], version_attr)
        except curses.error:
            pass
        y += 1
    return y


def _wrap_text(text: str, max_width: int) -> list[str]:
    if max_width <= 1:
        return [text]
    lines: list[object] = []
    for raw_line in text.splitlines() or [""]:
        if not raw_line:
            lines.append("")
            continue
        words = raw_line.split()
        if not words:
            lines.append("")
            continue
        current = ""
        for word in words:
            if len(word) > max_width:
                if current:
                    lines.append(current)
                    current = ""
                while len(word) > max_width:
                    lines.append(word[:max_width])
                    word = word[max_width:]
                current = word
                continue
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= max_width:
                current = f"{current} {word}"
            else:
                lines.append(current)
                current = word
        if current:
            lines.append(current)
    return lines


def _wrap_prompt_lines(prefix: str, prompt: str, max_width: int) -> list[str]:
    if max_width <= 1:
        return [f"{prefix}{prompt}"]
    wrapped = _wrap_text(prompt, max_width - len(prefix))
    if not wrapped:
        return [prefix.rstrip()]
    lines = [f"{prefix}{wrapped[0]}"]
    indent = " " * len(prefix)
    lines.extend(f"{indent}{line}" for line in wrapped[1:])
    return lines


def _truncate_text(text: str, max_width: int) -> str:
    if max_width <= 0:
        return ""
    if len(text) <= max_width:
        return text
    if max_width <= 3:
        return text[:max_width]
    return text[: max_width - 3] + "..."


def _prompt_status_line(index: int, total: int, prompt: str, status: str, max_width: int) -> str:
    status_tag = {"pending": "[ ]", "current": "[>]", "done": "[x]"}
    tag = status_tag.get(status, "[ ]")
    line = f"{tag} {index}/{total}: {prompt}"
    return _truncate_text(line, max_width)


def _prompt_status_lines(index: int, total: int, prompt: str, status: str, max_width: int) -> list[str]:
    status_tag = {"pending": "[ ]", "current": "[>]", "done": "[x]"}
    tag = status_tag.get(status, "[ ]")
    prefix = f"{tag} {index}/{total}: "
    if max_width <= len(prefix):
        return [prefix.rstrip()]
    wrapped = _wrap_text(prompt, max_width - len(prefix))
    if not wrapped:
        return [prefix.rstrip()]
    lines = [f"{prefix}{wrapped[0]}"]
    indent = " " * len(prefix)
    lines.extend(f"{indent}{line}" for line in wrapped[1:])
    return lines


def _prompt_status_attr(status: str, color_enabled: bool) -> int:
    import curses
    if status == "current":
        return curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
    if status == "done":
        return curses.color_pair(3) | curses.A_BOLD if color_enabled else curses.A_NORMAL
    return curses.A_DIM


def _capture_call_settings(args: argparse.Namespace) -> dict[str, object]:
    provider_options = getattr(args, "provider_options", None)
    if not isinstance(provider_options, dict):
        provider_options = {}
    return {
        "provider": getattr(args, "provider", None),
        "model": getattr(args, "model", None),
        "size": getattr(args, "size", None),
        "n": getattr(args, "n", None),
        "seed": getattr(args, "seed", None),
        "output_format": getattr(args, "output_format", None),
        "background": getattr(args, "background", None),
        "provider_options": dict(provider_options),
    }


def _apply_openai_provider_flags(args: argparse.Namespace) -> tuple[bool, bool]:
    openai_stream = bool(getattr(args, "openai_stream", False))
    openai_responses = bool(getattr(args, "openai_responses", False))
    if openai_responses and getattr(args, "provider", "") == "openai":
        provider_options = getattr(args, "provider_options", None)
        if not isinstance(provider_options, dict):
            provider_options = {}
            args.provider_options = provider_options
        provider_options["use_responses"] = True
    if openai_responses:
        openai_stream = False
    return openai_stream, openai_responses


def _format_call_settings_line(settings: dict[str, object]) -> str:
    pairs: list[tuple[str, object]] = []
    for key in ("provider", "model", "size", "n", "seed", "output_format", "background"):
        value = settings.get(key)
        if value is not None:
            pairs.append((key, value))
    line = _format_kv_pairs(pairs)
    provider_options = settings.get("provider_options")
    if isinstance(provider_options, dict) and provider_options:
        options_line = _format_dict_inline(provider_options)
        if line:
            line = f"{line} | provider_options: {options_line}"
        else:
            line = f"provider_options: {options_line}"
    return line or "(no settings)"


def _round_range_label(start: int | None, end: int | None) -> str:
    if start is None or end is None:
        return "Round ?"
    if start == end:
        return f"Round {start}"
    return f"Rounds {start}-{end}"


def _build_generation_header_lines(
    *,
    round_index: int,
    prev_settings: dict[str, object] | None,
    current_settings: dict[str, object],
    max_width: int,
) -> list[str]:
    lines: list[str] = []
    if prev_settings:
        title = f"Round {round_index} (API changes vs Round {round_index - 1})"
    else:
        title = f"Round {round_index} (baseline API call)"
    lines.extend(_wrap_text(title, max_width))
    if prev_settings:
        diffs = _diff_call_settings(prev_settings, current_settings)
        if not diffs:
            diffs = ["Change: none"]
        for diff in diffs:
            prefix = "Change: " if not diff.startswith("Change:") else ""
            lines.extend(_wrap_text(f"{prefix}{diff}", max_width))
    else:
        settings_line = _format_call_settings_line(current_settings)
        lines.extend(_wrap_text(settings_line, max_width))
    return lines


def _estimate_cost_value(
    *,
    provider: str | None,
    model: str | None,
    size: str | None,
    provider_options: dict[str, object] | None = None,
) -> float | None:
    if not provider or not size:
        return None
    pricing = _load_pricing_reference()
    provider_key = provider.strip().lower()
    model_key = (model or "").strip().lower()
    if provider_key == "openai":
        model_key = model_key or "gpt-image-1"
        size_key = _openai_size_key(size)
        model_prices = pricing.get("openai", {}).get(model_key, {})
        size_prices = model_prices.get(size_key) if isinstance(model_prices, dict) else None
        if isinstance(size_prices, dict):
            quality = _normalize_quality_tier(provider_options.get("quality") if provider_options else None)
            price = None
            if quality:
                price = size_prices.get(quality)
            if price is None:
                price = size_prices.get("medium") or size_prices.get("standard") or size_prices.get("low")
            if isinstance(price, (int, float)):
                return float(price)
    if provider_key == "gemini":
        model_key = model_key or "gemini-2.5-flash-image"
        model_prices = pricing.get("gemini", {}).get(model_key, {})
        if model_key == "gemini-2.5-flash-image":
            use_batch = _is_batch_pricing(provider_options)
            tier_key = "batch" if use_batch else "standard"
            price = model_prices.get(tier_key) if isinstance(model_prices, dict) else None
            if isinstance(price, (int, float)):
                return float(price)
        if model_key == "gemini-3-pro-image-preview":
            tier = _gemini_size_tier(size)
            use_batch = _is_batch_pricing(provider_options)
            key = f"{'batch' if use_batch else 'standard'}_{tier}"
            price = model_prices.get(key) if isinstance(model_prices, dict) else None
            if isinstance(price, (int, float)):
                return float(price)
    if provider_key == "imagen":
        model_key = model_key or "imagen-4"
        model_prices = pricing.get("imagen", {}).get(model_key, {})
        if isinstance(model_prices, dict):
            quality = _normalize_imagen_quality(provider_options.get("quality") if provider_options else None)
            price = None
            if quality:
                price = model_prices.get(quality)
            if price is None:
                price = model_prices.get("standard") or model_prices.get("ultra") or model_prices.get("fast")
            if isinstance(price, (int, float)):
                return float(price)
    if provider_key == "flux":
        model_key = model_key or "flux-2"
        model_prices = pricing.get("flux", {}).get(model_key, {})
        if isinstance(model_prices, dict):
            price = model_prices.get("from")
            if isinstance(price, (int, float)):
                return float(price)
    return None


def _format_cost_value(cost: float | None) -> str:
    if cost is None:
        return "N/A"
    per_1k = float(cost) * 1000.0
    return f"${_format_price(per_1k, digits=3)}/1K"


def _display_analysis_text(text: str) -> str:
    lines: list[str] = []
    for raw_line in text.splitlines():
        stripped = raw_line.lstrip()
        prefix = raw_line[: len(raw_line) - len(stripped)]
        upper = stripped.upper()
        if upper.startswith("ADH:"):
            body = stripped[4:].strip()
            lines.append(f"{prefix}Prompt adherence notes: {body}".rstrip())
            continue
        if upper.startswith("UNSET:"):
            body = stripped[6:].strip()
            lines.append(f"{prefix}API settings unchanged: {body}".rstrip())
            continue
        lines.append(raw_line)
    return "\n".join(lines)


def _clamp_score(value: object) -> int | None:
    try:
        score = int(float(value))
    except Exception:
        return None
    if score < 0:
        return 0
    if score > 100:
        return 100
    return score


def _parse_score_payload(text: str) -> tuple[int | None, int | None]:
    adherence = None
    quality = None
    match = re.search(r"\{.*\}", text, flags=re.S)
    if match:
        try:
            payload = json.loads(match.group(0))
        except Exception:
            payload = None
        if isinstance(payload, dict):
            adherence = _clamp_score(payload.get("adherence") or payload.get("prompt_adherence"))
            quality = _clamp_score(payload.get("quality"))
    if adherence is None:
        adh_match = re.search(r"adherence[^0-9]{0,10}(\d{1,3})", text, flags=re.I)
        if adh_match:
            adherence = _clamp_score(adh_match.group(1))
    if quality is None:
        qual_match = re.search(r"quality[^0-9]{0,10}(\d{1,3})", text, flags=re.I)
        if qual_match:
            quality = _clamp_score(qual_match.group(1))
    return adherence, quality


_RETRIEVAL_AXIS_KEYS = (
    "text_legibility",
    "captionability",
    "entity_richness",
    "information_density",
    "semantic_novelty",
    "trust_signals",
    "platform_fitness",
)

_RETRIEVAL_AXIS_WEIGHTS: dict[str, float] = {
    "text_legibility": 0.2,
    "captionability": 0.15,
    "entity_richness": 0.15,
    "information_density": 0.15,
    "semantic_novelty": 0.1,
    "trust_signals": 0.15,
    "platform_fitness": 0.1,
}


def _extract_retrieval_json(text: str) -> object | None:
    match = re.search(r"<retrieval_json>(.*?)</retrieval_json>", text, flags=re.S)
    raw = match.group(1).strip() if match else text.strip()
    if "```" in raw:
        fence = re.search(r"```(?:json)?(.*?)```", raw, flags=re.S | re.I)
        if fence:
            raw = fence.group(1).strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        pass
    match = re.search(r"\{.*\}", raw, flags=re.S)
    if not match:
        return None
    try:
        return json.loads(match.group(0))
    except Exception:
        return None


def _extract_axis_scores_from_text(text: str) -> dict[str, int | None]:
    axes: dict[str, int | None] = {}
    for key in _RETRIEVAL_AXIS_KEYS:
        pattern = rf"{re.escape(key)}[^0-9]{{0,10}}(\d{{1,3}})"
        match = re.search(pattern, text, flags=re.I)
        axes[key] = _clamp_score(match.group(1)) if match else None
    return axes


def _clean_text(value: object, max_len: int) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) <= max_len:
        return text
    return text[: max_len - 3].rstrip() + "..."


def _clean_list(value: object, max_items: int) -> list[str]:
    if not isinstance(value, list):
        return []
    items: list[str] = []
    for item in value:
        if item is None:
            continue
        text = str(item).strip()
        if not text:
            continue
        items.append(text)
        if len(items) >= max_items:
            break
    return items


def _clean_claims(value: object, max_items: int) -> list[dict[str, object]]:
    if not isinstance(value, list):
        return []
    claims: list[dict[str, object]] = []
    for entry in value:
        if not isinstance(entry, dict):
            text = _clean_text(entry, 140)
            if text:
                claims.append({"text": text, "confidence": 0.5})
            if len(claims) >= max_items:
                break
            continue
        text = _clean_text(entry.get("text"), 140)
        if not text:
            continue
        confidence_raw = entry.get("confidence")
        try:
            confidence = float(confidence_raw)
        except Exception:
            confidence = 0.5
        confidence = max(0.0, min(1.0, confidence))
        claims.append({"text": text, "confidence": confidence})
        if len(claims) >= max_items:
            break
    return claims


def _normalize_retrieval_axes(value: object) -> dict[str, int | None]:
    axes: dict[str, int | None] = {}
    raw = value if isinstance(value, dict) else {}
    for key in _RETRIEVAL_AXIS_KEYS:
        axes[key] = _clamp_score(raw.get(key))
    return axes


def _compute_retrieval_score(axes: dict[str, int | None]) -> int | None:
    weighted = 0.0
    total = 0.0
    for key, weight in _RETRIEVAL_AXIS_WEIGHTS.items():
        score = axes.get(key)
        if score is None:
            continue
        weighted += score * weight
        total += weight
    if total <= 0:
        return None
    return int(round(weighted / total))


def _compact_retrieval_packet(packet: dict[str, object]) -> dict[str, object]:
    return {
        "alt_text_120": packet.get("alt_text_120"),
        "caption_280": packet.get("caption_280"),
        "entities": packet.get("entities"),
        "claims": packet.get("claims"),
        "questions_answered": packet.get("questions_answered"),
        "flags": packet.get("flags"),
    }


def _build_retrieval_prompt(prompt: str) -> str:
    return (
        "You are evaluating an image for LLM-mediated retrieval and summarization. "
        "Do NOT judge beauty. Focus on clarity, extractability, and usefulness.\n\n"
        "Score each axis 0-100 (integers):\n"
        "- text_legibility\n"
        "- captionability\n"
        "- entity_richness\n"
        "- information_density\n"
        "- semantic_novelty\n"
        "- trust_signals\n"
        "- platform_fitness\n\n"
        "Then compute retrieval_score as a weighted average using weights:\n"
        "text_legibility 0.20, captionability 0.15, entity_richness 0.15, "
        "information_density 0.15, semantic_novelty 0.10, trust_signals 0.15, "
        "platform_fitness 0.10.\n\n"
        "Return JSON with keys: retrieval_score (int), axes (object with axis scores), "
        "alt_text_120, caption_280, ocr_text, entities, claims, questions_answered, flags.\n"
        "Axes object keys: text_legibility, captionability, entity_richness, information_density, "
        "semantic_novelty, trust_signals, platform_fitness.\n\n"
        "Also output a consumption packet:\n"
        "- alt_text_120 (<=120 chars)\n"
        "- caption_280 (<=280 chars)\n"
        "- ocr_text (best effort; empty if none)\n"
        "- entities (<=12 items)\n"
        "- claims (<=5 objects {text, confidence 0-1})\n"
        "- questions_answered (<=5 items)\n"
        "- flags (<=6 items from: unreadable_text, low_contrast_text, ambiguous_subject, "
        "cluttered_layout, artifacted_content, low_trust_layout, thumbnail_failure)\n\n"
        "Return ONLY JSON wrapped in <retrieval_json>...</retrieval_json>.\n\n"
        f"Prompt:\n{prompt}"
    )


def _score_retrieval_with_council(
    *,
    prompt: str,
    image_base64: str | None,
    image_mime: str | None,
) -> dict[str, object] | None:
    if not image_base64 or not image_mime:
        return None
    if not (
        os.getenv("OPENAI_API_KEY")
        or os.getenv("OPENAI_API_KEY_BACKUP")
        or os.getenv("ANTHROPIC_API_KEY")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
    ):
        return None
    prompt_text = _build_retrieval_prompt(prompt)
    try:
        text, _ = _call_council(
            prompt_text,
            enable_web_search=False,
            image_base64=image_base64,
            image_mime=image_mime,
            chair_instructions=[
                "You are the council chair. Synthesize a single JSON response.",
                "Output ONLY <retrieval_json>...</retrieval_json>. No extra text.",
            ],
        )
    except Exception:
        return None
    payload = _extract_retrieval_json(text)
    if not isinstance(payload, dict):
        axes = _extract_axis_scores_from_text(text)
        retrieval_score = _compute_retrieval_score(axes)
        if retrieval_score is None:
            return None
        return {
            "score": retrieval_score,
            "axes": axes,
            "packet": {},
            "packet_mode": "compact",
            "model": "council",
            "raw_text": _clean_text(text, 1200),
        }
    axes_payload = payload.get("axes")
    if not isinstance(axes_payload, dict):
        axes_payload = {key: payload.get(key) for key in _RETRIEVAL_AXIS_KEYS}
    axes = _normalize_retrieval_axes(axes_payload)
    retrieval_score = _clamp_score(payload.get("retrieval_score") or payload.get("score"))
    if retrieval_score is None:
        retrieval_score = _compute_retrieval_score(axes)
    packet: dict[str, object] = {
        "alt_text_120": _clean_text(payload.get("alt_text_120"), 120),
        "caption_280": _clean_text(payload.get("caption_280"), 280),
        "ocr_text": _clean_text(payload.get("ocr_text"), 800),
        "entities": _clean_list(payload.get("entities"), 12),
        "claims": _clean_claims(payload.get("claims"), 5),
        "questions_answered": _clean_list(payload.get("questions_answered"), 5),
        "flags": _clean_list(payload.get("flags"), 6),
    }
    packet_mode = _retrieval_packet_mode()
    stored_packet = packet if packet_mode == "full" else _compact_retrieval_packet(packet)
    return {
        "score": retrieval_score,
        "axes": axes,
        "packet": stored_packet,
        "packet_mode": packet_mode,
        "model": "council",
    }


def _score_image_with_council(
    *,
    prompt: str,
    image_base64: str | None,
    image_mime: str | None,
) -> tuple[int | None, int | None]:
    if not image_base64 or not image_mime:
        return None, None
    if not (
        os.getenv("OPENAI_API_KEY")
        or os.getenv("OPENAI_API_KEY_BACKUP")
        or os.getenv("ANTHROPIC_API_KEY")
        or os.getenv("GEMINI_API_KEY")
        or os.getenv("GOOGLE_API_KEY")
    ):
        return None, None
    score_prompt = (
        "Given the prompt and the generated image, evaluate how a group of appropriate judges would rate "
        "the adherence of the generated image to the given prompt and the quality of the image. "
        "Return ONLY JSON like: {\"adherence\": 0-100, \"quality\": 0-100}. "
        "Use integers. No extra text.\n\n"
        f"Prompt:\n{prompt}"
    )
    try:
        text, _ = _call_council(
            score_prompt,
            enable_web_search=False,
            image_base64=image_base64,
            image_mime=image_mime,
            chair_instructions=[
                "You are the council chair. Synthesize the best final response.",
                "Return ONLY JSON like: {\"adherence\": 0-100, \"quality\": 0-100}. Use integers. No extra text.",
            ],
        )
    except Exception:
        return None, None
    return _parse_score_payload(text)


def _compute_colorfulness(image) -> float:
    pixels = list(image.getdata())
    if not pixels:
        return 0.0
    total = len(pixels)
    step = max(1, total // 50000)
    mean_rg = 0.0
    mean_yb = 0.0
    var_rg = 0.0
    var_yb = 0.0
    count = 0
    for idx in range(0, total, step):
        r, g, b = pixels[idx]
        rg = float(r) - float(g)
        yb = 0.5 * (float(r) + float(g)) - float(b)
        count += 1
        delta_rg = rg - mean_rg
        mean_rg += delta_rg / count
        var_rg += delta_rg * (rg - mean_rg)
        delta_yb = yb - mean_yb
        mean_yb += delta_yb / count
        var_yb += delta_yb * (yb - mean_yb)
    if count <= 1:
        return 0.0
    std_rg = math.sqrt(var_rg / (count - 1))
    std_yb = math.sqrt(var_yb / (count - 1))
    mean_rg_abs = abs(mean_rg)
    mean_yb_abs = abs(mean_yb)
    return math.sqrt(std_rg * std_rg + std_yb * std_yb) + 0.3 * math.sqrt(
        mean_rg_abs * mean_rg_abs + mean_yb_abs * mean_yb_abs
    )


def _compute_image_quality_metrics(image_path: Path) -> dict[str, object]:
    try:
        from PIL import Image, ImageFilter, ImageStat  # type: ignore
    except Exception:
        return {}
    try:
        image = Image.open(image_path).convert("RGB")
    except Exception:
        return {}
    max_dim = 512
    if max(image.width, image.height) > max_dim:
        scale = max_dim / max(image.width, image.height)
        new_size = (max(1, int(image.width * scale)), max(1, int(image.height * scale)))
        image = image.resize(new_size, Image.BICUBIC)
    luma = image.convert("L")
    luma_stats = ImageStat.Stat(luma)
    brightness = float(luma_stats.mean[0])
    contrast = float(luma_stats.stddev[0])
    edges = luma.filter(ImageFilter.FIND_EDGES)
    edge_stats = ImageStat.Stat(edges)
    sharpness = float(edge_stats.mean[0])
    colorfulness = float(_compute_colorfulness(image))
    return {
        "brightness_luma_mean": round(brightness, 2),
        "contrast_luma_std": round(contrast, 2),
        "sharpness_edge_mean": round(sharpness, 2),
        "colorfulness": round(colorfulness, 2),
        "sampled_width": image.width,
        "sampled_height": image.height,
    }


def _image_quality_gates(metrics: dict[str, object]) -> list[str]:
    gates: list[str] = []
    brightness = metrics.get("brightness_luma_mean")
    contrast = metrics.get("contrast_luma_std")
    sharpness = metrics.get("sharpness_edge_mean")
    if isinstance(brightness, (int, float)):
        if brightness < 40:
            gates.append("too_dark")
        elif brightness > 215:
            gates.append("too_bright")
    if isinstance(contrast, (int, float)) and contrast < 20:
        gates.append("low_contrast")
    if isinstance(sharpness, (int, float)) and sharpness < 3:
        gates.append("low_sharpness")
    return gates


def _build_snapshot_lines(
    *,
    elapsed: float | None,
    cost: float | None,
    adherence: int | None,
    quality: int | None,
    retrieval_score: int | None = None,
    include_retrieval: bool = False,
    retrieval_note: str | None = None,
) -> list[str]:
    elapsed_text = "N/A" if elapsed is None else f"{elapsed:.1f}s"
    adherence_text = "N/A" if adherence is None else f"{adherence}/100"
    quality_text = "N/A" if quality is None else f"{quality}/100"
    lines = [
        f"render: {elapsed_text}",
        f"cost: {_format_cost_value(cost)}",
        f"prompt adherence: {adherence_text}",
        f"LLM-rated quality: {quality_text}",
    ]
    if include_retrieval:
        if retrieval_score is None:
            retrieval_text = retrieval_note or "N/A"
        else:
            retrieval_text = f"{retrieval_score}/100"
        lines.append(f"LLM retrieval score: {retrieval_text}")
    return lines


def _snapshot_template_lines(include_retrieval: bool = False) -> list[str]:
    lines = [
        "render: 9999.9s",
        "cost: $99999/1K",
        "prompt adherence: 100/100",
        "LLM-rated quality: 100/100",
    ]
    if include_retrieval:
        lines.append("LLM retrieval score: 100/100")
    return lines


def _measure_text_metrics(draw, font, lines: list[str], line_spacing: int) -> tuple[int, int, int]:
    if not lines:
        return 0, 0, 0
    widths: list[int] = []
    heights: list[int] = []
    for line in lines:
        bbox = draw.textbbox((0, 0), line, font=font)
        widths.append(bbox[2] - bbox[0])
        heights.append(bbox[3] - bbox[1])
    max_w = max(widths) if widths else 0
    line_height = max(heights) if heights else 0
    total_h = line_height * len(lines) + line_spacing * (len(lines) - 1)
    return max_w, line_height, total_h


def _apply_snapshot_overlay(
    image_path: Path, lines: list[str], *, include_retrieval: bool = False
) -> bool:
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore
    except Exception:
        return False
    if not lines:
        return False
    try:
        image = Image.open(image_path).convert("RGBA")
    except Exception:
        return False
    base_font_size = 18
    base_scale = 2.0
    baseline_area = 1024 * 1024
    size_scale = math.sqrt((image.width * image.height) / baseline_area)
    size_scale = max(0.75, min(4.0, size_scale))
    scale_factor = base_scale * size_scale
    target_font_size = int(base_font_size * scale_factor)
    font = None
    is_truetype = False
    selected_font = None
    font_candidates = [
        "Menlo.ttf",
        "/System/Library/Fonts/Supplemental/Menlo.ttc",
        "/System/Library/Fonts/Supplemental/Menlo-Regular.ttf",
        "/Library/Fonts/Menlo.ttf",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/Library/Fonts/Arial.ttf",
        "DejaVuSans.ttf",
    ]
    for candidate in font_candidates:
        try:
            font = ImageFont.truetype(candidate, target_font_size)
            is_truetype = True
            selected_font = candidate
            break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()
    line_spacing = int(4 * scale_factor)
    padding = int(10 * scale_factor)
    template_lines = _snapshot_template_lines(include_retrieval=include_retrieval)
    if not is_truetype:
        draw = ImageDraw.Draw(image)
        max_w, line_height, total_h = _measure_text_metrics(draw, font, lines, line_spacing)
        template_w, template_height, template_total_h = _measure_text_metrics(
            draw,
            font,
            template_lines,
            line_spacing,
        )
        max_w = max(max_w, template_w)
        line_height = max(line_height, template_height)
        total_h = max(total_h, template_total_h)
        line_heights = [max(10, line_height)] * len(lines)
        box_w = max_w + 10 * 2
        box_h = total_h + 10 * 2
        max_w_allowed = int(image.width * 0.95)
        max_h_allowed = int(image.height * 0.95)
        scale = min(
            scale_factor,
            max_w_allowed / max(1, box_w),
            max_h_allowed / max(1, box_h),
        )
        scale = max(0.5, scale)
        small_overlay = Image.new("RGBA", (box_w, box_h), (0, 0, 0, 0))
        small_draw = ImageDraw.Draw(small_overlay)
        small_draw.rectangle([0, 0, box_w, box_h], fill=(0, 0, 0, 160))
        y = 10
        for line, height in zip(lines, line_heights):
            small_draw.text((10, y), line, fill=(255, 255, 255, 255), font=font)
            y += height + 4
        big_overlay = small_overlay.resize(
            (int(box_w * scale), int(box_h * scale)),
            Image.NEAREST,
        )
        overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
        overlay.paste(big_overlay, (0, 0), big_overlay)
        combined = Image.alpha_composite(image, overlay)
        suffix = image_path.suffix.lower()
        if suffix in {".jpg", ".jpeg"}:
            combined.convert("RGB").save(image_path, quality=95)
        else:
            combined.save(image_path)
        return True

    draw = ImageDraw.Draw(image)
    max_w, line_height, total_h = _measure_text_metrics(draw, font, lines, line_spacing)
    template_w, template_height, template_total_h = _measure_text_metrics(
        draw,
        font,
        template_lines,
        line_spacing,
    )
    max_w = max(max_w, template_w)
    line_height = max(line_height, template_height)
    total_h = max(total_h, template_total_h)
    line_heights = [max(10, line_height)] * len(lines)
    box_w = max_w + padding * 2
    box_h = total_h + padding * 2
    max_w_allowed = int(image.width * 0.95)
    max_h_allowed = int(image.height * 0.95)
    if (box_w > max_w_allowed or box_h > max_h_allowed) and selected_font:
        scale = min(
            max_w_allowed / max(1, box_w),
            max_h_allowed / max(1, box_h),
        )
        adjusted_size = max(8, int(target_font_size * scale))
        try:
            font = ImageFont.truetype(selected_font, adjusted_size)
        except Exception:
            font = ImageFont.load_default()
        scale_used = max(0.5, adjusted_size / base_font_size)
        line_spacing = int(4 * scale_used)
        padding = int(10 * scale_used)
        draw = ImageDraw.Draw(image)
        max_w, line_height, total_h = _measure_text_metrics(draw, font, lines, line_spacing)
        template_w, template_height, template_total_h = _measure_text_metrics(
            draw,
            font,
            template_lines,
            line_spacing,
        )
        max_w = max(max_w, template_w)
        line_height = max(line_height, template_height)
        total_h = max(total_h, template_total_h)
        line_heights = [max(10, line_height)] * len(lines)
        box_w = max_w + padding * 2
        box_h = total_h + padding * 2

    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    overlay_draw = ImageDraw.Draw(overlay)
    overlay_draw.rectangle([0, 0, box_w, box_h], fill=(0, 0, 0, 160))
    y = padding
    for line, height in zip(lines, line_heights):
        overlay_draw.text((padding, y), line, fill=(255, 255, 255, 255), font=font)
        y += height + line_spacing
    combined = Image.alpha_composite(image, overlay)
    suffix = image_path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        combined.convert("RGB").save(image_path, quality=95)
    else:
        combined.save(image_path)
    return True


def _write_retrieval_metadata(receipt_path: Path, retrieval: dict[str, object]) -> None:
    try:
        payload = _load_receipt_payload(receipt_path)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    meta = payload.get("result_metadata")
    if not isinstance(meta, dict):
        meta = {}
        payload["result_metadata"] = meta
    meta["llm_retrieval"] = retrieval
    try:
        receipt_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return


def _write_image_quality_metadata(
    receipt_path: Path,
    metrics: dict[str, object],
    gates: list[str],
) -> None:
    if not metrics:
        return
    try:
        payload = _load_receipt_payload(receipt_path)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    meta = payload.get("result_metadata")
    if not isinstance(meta, dict):
        meta = {}
        payload["result_metadata"] = meta
    meta["image_quality_metrics"] = {
        "metrics": metrics,
        "gates": gates,
        "version": "v1",
    }
    try:
        receipt_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return


def _write_render_metadata(receipt_path: Path, elapsed: float | None) -> None:
    if elapsed is None:
        return
    try:
        payload = _load_receipt_payload(receipt_path)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    meta = payload.get("result_metadata")
    if not isinstance(meta, dict):
        meta = {}
        payload["result_metadata"] = meta
    if "render_seconds" not in meta:
        try:
            meta["render_seconds"] = float(elapsed)
        except Exception:
            return
    try:
        receipt_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return


def _write_llm_scores_metadata(
    receipt_path: Path,
    adherence: int | None,
    quality: int | None,
    *,
    model: str = "council",
    version: str = "v1",
) -> None:
    if adherence is None and quality is None:
        return
    try:
        payload = _load_receipt_payload(receipt_path)
    except Exception:
        return
    if not isinstance(payload, dict):
        return
    meta = payload.get("result_metadata")
    if not isinstance(meta, dict):
        meta = {}
        payload["result_metadata"] = meta
    scores: dict[str, object] = {"model": model, "version": version}
    if adherence is not None:
        scores["adherence"] = int(adherence)
    if quality is not None:
        scores["quality"] = int(quality)
    meta["llm_scores"] = scores
    try:
        receipt_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    except Exception:
        return


def _load_retrieval_score(receipt_path: Path) -> int | None:
    try:
        payload = _load_receipt_payload(receipt_path)
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    meta = payload.get("result_metadata")
    if not isinstance(meta, dict):
        return None
    retrieval = meta.get("llm_retrieval")
    if not isinstance(retrieval, dict):
        return None
    return _clamp_score(retrieval.get("score"))


def _apply_snapshot_for_result(
    *,
    image_path: Path,
    receipt_path: Path,
    prompt: str,
    elapsed: float | None,
    fallback_settings: dict[str, object],
    retrieval_enabled: bool = True,
) -> tuple[int | None, int | None]:
    provider = fallback_settings.get("provider")
    model = fallback_settings.get("model")
    size = fallback_settings.get("size")
    provider_options = fallback_settings.get("provider_options")
    if not isinstance(provider_options, dict):
        provider_options = None
    try:
        receipt = _load_receipt_payload(receipt_path)
        if isinstance(receipt, dict):
            resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else None
            request = receipt.get("request") if isinstance(receipt.get("request"), dict) else None
            if isinstance(resolved, dict):
                provider = resolved.get("provider") or provider
                model = resolved.get("model") or model
                size = resolved.get("size") or size
            if isinstance(request, dict) and isinstance(request.get("provider_options"), dict):
                if request.get("provider_options"):
                    provider_options = request.get("provider_options")
            elif isinstance(resolved, dict) and isinstance(resolved.get("provider_params"), dict):
                if resolved.get("provider_params"):
                    provider_options = resolved.get("provider_params")
    except Exception:
        pass
    cost_value = _estimate_cost_value(
        provider=str(provider) if provider else None,
        model=str(model) if model else None,
        size=str(size) if size else None,
        provider_options=provider_options if isinstance(provider_options, dict) else None,
    )
    _write_render_metadata(receipt_path, elapsed)
    quality_metrics: dict[str, object] = {}
    quality_gates: list[str] = []
    try:
        quality_metrics = _compute_image_quality_metrics(image_path)
        quality_gates = _image_quality_gates(quality_metrics) if quality_metrics else []
    except Exception:
        quality_metrics = {}
        quality_gates = []
    if quality_metrics:
        _write_image_quality_metadata(receipt_path, quality_metrics, quality_gates)
    image_base64 = None
    image_mime = None
    try:
        image_base64, image_mime = _load_image_for_analyzer(image_path)
    except Exception:
        pass
    adherence, quality = _score_image_with_council(
        prompt=prompt,
        image_base64=image_base64,
        image_mime=image_mime,
    )
    _write_llm_scores_metadata(receipt_path, adherence, quality)
    retrieval_payload = None
    retrieval_score = None
    retrieval_note = None
    if retrieval_enabled:
        if quality_gates:
            retrieval_note = f"gated ({', '.join(quality_gates)})"
            retrieval_payload = {
                "score": None,
                "axes": {},
                "packet": {},
                "packet_mode": _retrieval_packet_mode(),
                "model": "quality_gate",
                "gated": True,
                "gate_reasons": quality_gates,
            }
            _write_retrieval_metadata(receipt_path, retrieval_payload)
        else:
            retrieval_payload = _score_retrieval_with_council(
                prompt=prompt,
                image_base64=image_base64,
                image_mime=image_mime,
            )
            if isinstance(retrieval_payload, dict):
                retrieval_score = _clamp_score(retrieval_payload.get("score"))
                _write_retrieval_metadata(receipt_path, retrieval_payload)
    lines = _build_snapshot_lines(
        elapsed=elapsed,
        cost=cost_value,
        adherence=adherence,
        quality=quality,
        retrieval_score=retrieval_score,
        include_retrieval=retrieval_enabled,
        retrieval_note=retrieval_note,
    )
    _apply_snapshot_overlay(image_path, lines, include_retrieval=retrieval_enabled)
    return adherence, quality


def _diff_call_settings(prev: dict[str, object], current: dict[str, object]) -> list[str]:
    diffs: list[str] = []
    prev_resolved = _resolved_request_for_settings(prev)
    curr_resolved = _resolved_request_for_settings(current)
    for key in ("provider", "model", "size", "n", "seed", "output_format", "background"):
        prev_val = prev.get(key)
        curr_val = current.get(key)
        if prev_val != curr_val:
            prev_default = (
                _default_setting_value_for_resolved(prev_resolved, key)
                if prev_val is None
                else None
            )
            curr_default = (
                _default_setting_value_for_resolved(curr_resolved, key)
                if curr_val is None
                else None
            )
            prev_text = _format_setting_value_with_default(prev_val, prev_default)
            curr_text = _format_setting_value_with_default(curr_val, curr_default)
            diffs.append(f"{key}: {prev_text} -> {curr_text}")
    prev_opts = prev.get("provider_options")
    curr_opts = current.get("provider_options")
    if not isinstance(prev_opts, dict):
        prev_opts = {}
    if not isinstance(curr_opts, dict):
        curr_opts = {}
    for key in sorted(set(prev_opts.keys()) | set(curr_opts.keys())):
        prev_val = prev_opts.get(key)
        curr_val = curr_opts.get(key)
        if prev_val != curr_val:
            prev_default = (
                _default_setting_value_for_resolved(prev_resolved, key, setting_target="provider_options")
                if prev_val is None
                else None
            )
            curr_default = (
                _default_setting_value_for_resolved(curr_resolved, key, setting_target="provider_options")
                if curr_val is None
                else None
            )
            diffs.append(
                "provider_options."
                + str(key)
                + ": "
                + _format_setting_value_with_default(prev_val, prev_default)
                + " -> "
                + _format_setting_value_with_default(curr_val, curr_default)
            )
    return diffs


def _render_generation_header(
    stdscr,
    *,
    y: int,
    width: int,
    round_index: int,
    prev_settings: dict[str, object] | None,
    current_settings: dict[str, object],
    color_enabled: bool,
    rationale_line: str | None = None,
    header_lines_override: list[str] | None = None,
) -> int:
    import curses
    header_attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
    change_attr = curses.color_pair(3) | curses.A_BOLD if color_enabled else curses.A_BOLD
    if header_lines_override is None:
        header_lines = _build_generation_header_lines(
            round_index=round_index,
            prev_settings=prev_settings,
            current_settings=current_settings,
            max_width=max(20, width - 1),
        )
    else:
        header_lines = header_lines_override
    for idx, line in enumerate(header_lines):
        attr = header_attr if idx == 0 else change_attr
        _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)], attr)
        y += 1
        if idx == 0 and rationale_line:
            for wrapped in _wrap_text(rationale_line, max(20, width - 1)):
                _safe_addstr(stdscr, y, 0, wrapped[: max(0, width - 1)], header_attr)
                y += 1
    return y


def _build_validation_header_lines(
    *,
    baseline_settings: dict[str, object],
    current_settings: dict[str, object],
    max_width: int,
) -> list[str]:
    lines: list[str] = []
    lines.extend(_wrap_text("Final validation run (baseline comparison)", max_width))
    baseline_line = f"Baseline: {_format_call_settings_line(baseline_settings)}"
    lines.extend(_wrap_text(baseline_line, max_width))
    current_line = f"Final settings: {_format_call_settings_line(current_settings)}"
    lines.extend(_wrap_text(current_line, max_width))
    return lines


def _format_setting_value(value: object, *, depth: int = 0) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        rendered = ", ".join(_format_setting_value(item, depth=depth + 1) for item in value)
        return rendered or "[]"
    if isinstance(value, dict):
        if depth >= 1:
            return "{...}"
        return _format_dict_inline(value, depth=depth + 1)
    return str(value)


def _resolved_request_for_settings(
    settings: dict[str, object],
) -> tuple[str, str | None, object] | None:
    provider_raw = settings.get("provider")
    if not isinstance(provider_raw, str) or not provider_raw.strip():
        provider_raw = "openai"
    model_raw = settings.get("model")
    if not isinstance(model_raw, str):
        model_raw = None
    provider_key, model_key = _normalize_provider_and_model(provider_raw, model_raw)
    size_value = settings.get("size")
    if not isinstance(size_value, str) or not size_value.strip():
        size_value = "1024x1024"
    n_value = settings.get("n")
    try:
        n_value = int(n_value) if n_value is not None else 1
    except Exception:
        n_value = 1
    try:
        from forge_image_api.core.contracts import ImageRequest  # type: ignore
        from forge_image_api.core.solver import resolve_request  # type: ignore
    except Exception:
        return None
    try:
        request = ImageRequest(prompt=".", size=str(size_value), n=n_value)
        request.output_format = settings.get("output_format")
        request.background = settings.get("background")
        if model_key:
            request.model = model_key
        provider_options = settings.get("provider_options")
        if isinstance(provider_options, dict):
            request.provider_options = dict(provider_options)
        request.seed = settings.get("seed")
        resolved = resolve_request(request, provider_key)
        return provider_key, model_key, resolved
    except Exception:
        return None


def _default_setting_value_for_resolved(
    resolved_data: tuple[str, str | None, object] | None,
    key: str,
    *,
    setting_target: str | None = None,
) -> object | None:
    if not resolved_data:
        return None
    provider_key, model_key, resolved = resolved_data
    if setting_target == "provider_options":
        provider_params = getattr(resolved, "provider_params", None)
        if isinstance(provider_params, dict) and key in provider_params:
            return provider_params.get(key)
        return _default_provider_option(provider_key, model_key, key)
    if key == "provider":
        return getattr(resolved, "provider", None)
    if key == "model":
        return getattr(resolved, "model", None)
    if key == "size":
        return getattr(resolved, "size", None)
    if key == "n":
        return getattr(resolved, "n", None)
    if key == "seed":
        return getattr(resolved, "seed", None)
    if key == "output_format":
        return getattr(resolved, "output_format", None)
    if key == "background":
        return getattr(resolved, "background", None)
    return None


def _default_output_format_for_settings(settings: dict[str, object]) -> str | None:
    resolved_data = _resolved_request_for_settings(settings)
    return _default_setting_value_for_resolved(resolved_data, "output_format")


def _format_setting_value_with_default(value: object, default: object | None) -> str:
    rendered = _format_setting_value(value)
    if value is None and default is not None:
        return f"{rendered} (default: {_format_setting_value(default)})"
    return rendered


def _size_area_estimate(size_value: object) -> float | None:
    if not isinstance(size_value, str):
        return None
    raw = size_value.strip().lower()
    if not raw:
        return None
    if "x" in raw:
        parts = raw.split("x", 1)
        try:
            w = int(float(parts[0].strip()))
            h = int(float(parts[1].strip()))
        except Exception:
            return None
        if w <= 0 or h <= 0:
            return None
        return float(w * h)
    if raw in {"portrait", "tall"}:
        return float(1024 * 1536)
    if raw in {"landscape", "wide"}:
        return float(1536 * 1024)
    if raw in {"square", "1:1"}:
        return float(1024 * 1024)
    if ":" in raw:
        parts = raw.split(":", 1)
        try:
            w = float(parts[0].strip())
            h = float(parts[1].strip())
        except Exception:
            return None
        if w <= 0 or h <= 0:
            return None
        base = 1024.0
        height = base * (h / w)
        return base * height
    return None


def _format_dict_inline(data: dict, *, max_items: int = 8, depth: int = 0) -> str:
    items: list[str] = []
    for idx, key in enumerate(sorted(data.keys())):
        if idx >= max_items:
            items.append("...")
            break
        value = data.get(key)
        items.append(f"{key}={_format_setting_value(value, depth=depth)}")
    return ", ".join(items) if items else "(none)"


def _format_kv_pairs(pairs: list[tuple[str, object]], *, sep: str = " | ") -> str:
    return sep.join(f"{key}={_format_setting_value(value)}" for key, value in pairs)


def _lookup_current_setting_value(
    setting_name: str,
    setting_target: str,
    resolved: dict | None,
    request: dict | None,
) -> object | None:
    if setting_target == "provider_options":
        if isinstance(resolved, dict):
            provider_params = resolved.get("provider_params")
            if isinstance(provider_params, dict) and setting_name in provider_params:
                return provider_params.get(setting_name)
        if isinstance(request, dict):
            provider_options = request.get("provider_options")
            if isinstance(provider_options, dict) and setting_name in provider_options:
                return provider_options.get(setting_name)
    if isinstance(resolved, dict) and setting_name in resolved:
        return resolved.get(setting_name)
    if isinstance(request, dict) and setting_name in request:
        return request.get(setting_name)
    return None


def _flux_default_params(model: str | None) -> dict[str, object]:
    model_key = (model or "").strip().lower()
    if "dev" in model_key:
        return {
            "prompt_upsampling": False,
            "safety_tolerance": 2,
            "steps": 28,
            "guidance": 3,
        }
    return {
        "prompt_upsampling": False,
        "safety_tolerance": 2,
        "steps": 40,
        "guidance": 2.5,
    }


def _default_provider_option(provider: str | None, model: str | None, key: str) -> object | None:
    provider_key = (provider or "").strip().lower()
    if provider_key == "openai" and key == "use_responses":
        return False
    if provider_key in {"black forest labs", "bfl", "flux"}:
        return _flux_default_params(model).get(key)
    return None


def _fill_defaults_for_display(
    data: dict | None,
    *,
    provider: str | None,
    model: str | None,
) -> dict | None:
    if not isinstance(data, dict) or not data:
        return data
    provider_key = (provider or "").strip().lower()
    if provider_key not in {"black forest labs", "bfl", "flux"}:
        return data
    defaults = _flux_default_params(model)
    updated = dict(data)
    for key, value in list(updated.items()):
        if value is None and key in defaults:
            updated[key] = defaults[key]
    return updated


def _lookup_current_setting_value_with_defaults(
    setting_name: str,
    setting_target: str,
    resolved: dict | None,
    request: dict | None,
    provider: str | None,
    model: str | None,
) -> object | None:
    value = _lookup_current_setting_value(setting_name, setting_target, resolved, request)
    if value is not None:
        return value
    if setting_target == "provider_options":
        return _default_provider_option(provider, model, setting_name)
    return None


def _build_receipt_detail_lines(
    receipt: dict,
    recommendation: object,
    *,
    max_width: int,
    return_tags: bool = False,
    stop_reason: str | None = None,
) -> list[object]:
    lines: list[object] = []
    def _append(line: str, tag: str | None = None) -> None:
        if tag and return_tags:
            lines.append((line, tag))
        else:
            lines.append(line)

    def _append_wrapped(text: str, tag: str | None = None) -> None:
        for line in _wrap_text(text, max_width):
            _append(line, tag)

    resolved = receipt.get("resolved") if isinstance(receipt, dict) else None
    request = receipt.get("request") if isinstance(receipt, dict) else None
    provider_value = None
    model_value = None
    if isinstance(resolved, dict):
        provider_value = resolved.get("provider")
        model_value = resolved.get("model")
    if provider_value is None and isinstance(request, dict):
        provider_value = request.get("provider")
    if model_value is None and isinstance(request, dict):
        model_value = request.get("model")

    _append("RENDER SETTINGS (RESOLVED)", "section")
    pairs: list[tuple[str, object]] = []
    for key in ("provider", "model", "size", "n", "output_format", "background", "seed"):
        value = None
        if isinstance(resolved, dict):
            value = resolved.get(key)
        if value is None and isinstance(request, dict):
            value = request.get(key)
        if key == "provider":
            value = _display_provider_name(value)
        if value is not None:
            pairs.append((key, value))
    if isinstance(resolved, dict):
        width = resolved.get("width")
        height = resolved.get("height")
        if width and height:
            pairs.append(("dimensions", f"{width}x{height}"))
    if pairs:
        _append_wrapped(_format_kv_pairs(pairs))
    else:
        _append("(no resolved settings found)")

    if isinstance(resolved, dict):
        provider_params = resolved.get("provider_params")
        provider_params = _fill_defaults_for_display(
            provider_params if isinstance(provider_params, dict) else None,
            provider=provider_value,
            model=model_value,
        )
        if isinstance(provider_params, dict) and provider_params:
            provider_line = f"provider_params: {_format_dict_inline(provider_params)}"
            _append_wrapped(provider_line)
    if isinstance(request, dict):
        provider_options = request.get("provider_options")
        provider_options = _fill_defaults_for_display(
            provider_options if isinstance(provider_options, dict) else None,
            provider=provider_value,
            model=model_value,
        )
        if isinstance(provider_options, dict) and provider_options:
            options_line = f"requested provider_options: {_format_dict_inline(provider_options)}"
            _append_wrapped(options_line)
    warnings = None
    if isinstance(resolved, dict):
        warnings = resolved.get("warnings")
    if not warnings and isinstance(receipt, dict):
        warnings = receipt.get("warnings")
    if isinstance(warnings, list) and warnings:
        warning_line = "warnings: " + "; ".join(str(w) for w in warnings)
        _append_wrapped(warning_line)

    _append("")

    _append("RECOMMENDATIONS", "section")
    recommendations = _normalize_recommendations(recommendation)
    if not recommendations:
        _append("none")
        return lines

    for idx, rec in enumerate(recommendations, start=1):
        if len(recommendations) > 1:
            _append(f"Recommendation {idx}", "section")
        setting_name = str(rec.get("setting_name") or "").strip()
        setting_value = rec.get("setting_value")
        setting_target = str(rec.get("setting_target") or "provider_options")
        detail_pairs = [
            ("setting_name", setting_name),
            ("setting_value", setting_value),
            ("target", setting_target),
        ]
        _append_wrapped(_format_kv_pairs(detail_pairs), "change")
        current_value = _lookup_current_setting_value(setting_name, setting_target, resolved, request)
        if setting_target == "provider_options":
            next_line = (
                f"next render: provider_options.{setting_name}="
                f"{_format_setting_value(setting_value)}"
            )
        else:
            next_line = f"next render: {setting_name}={_format_setting_value(setting_value)}"
        if current_value is not None:
            next_line += f" (was {_format_setting_value(current_value)})"
        _append_wrapped(next_line, "change")
        rationale = rec.get("rationale")
        if isinstance(rationale, str) and rationale.strip():
            _append_wrapped(f"rationale: {rationale.strip()}")
        if idx < len(recommendations):
            _append("")
    return lines


def _export_analysis_text(receipt_path: Path, lines: list[str]) -> Path:
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out_path = receipt_path.with_name(f"{receipt_path.stem}-analysis-{stamp}.txt")
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return out_path


def _settings_after_recommendation(
    settings: dict[str, object],
    recommendation: object,
) -> dict[str, object]:
    temp_args = argparse.Namespace(**settings)
    if not hasattr(temp_args, "provider_options") or not isinstance(temp_args.provider_options, dict):
        temp_args.provider_options = {}
    _apply_recommendation(temp_args, recommendation)
    return _capture_call_settings(temp_args)


def _settings_from_receipt(
    receipt: dict | None,
    *,
    fallback_provider: str,
    fallback_model: str | None,
    fallback_size: str,
    fallback_n: int,
) -> dict[str, object]:
    resolved = receipt.get("resolved") if isinstance(receipt, dict) else None
    request = receipt.get("request") if isinstance(receipt, dict) else None
    settings: dict[str, object] = {
        "provider": fallback_provider,
        "model": fallback_model,
        "size": fallback_size,
        "n": fallback_n,
        "seed": None,
        "output_format": None,
        "background": None,
        "provider_options": {},
    }
    for key in ("provider", "model", "size", "n", "seed", "output_format", "background"):
        value = None
        if isinstance(resolved, dict):
            value = resolved.get(key)
        if value is None and isinstance(request, dict):
            value = request.get(key)
        if value is not None:
            settings[key] = value
    provider_options = None
    if isinstance(request, dict):
        provider_options = request.get("provider_options")
    if not (isinstance(provider_options, dict) and provider_options):
        if isinstance(resolved, dict):
            provider_options = resolved.get("provider_params")
    if isinstance(provider_options, dict):
        settings["provider_options"] = dict(provider_options)
    return settings


def _build_final_recommendation_lines(
    settings: dict[str, object],
    recommendation: object,
    *,
    user_goals: list[str] | None,
    max_width: int,
    return_tags: bool = False,
    last_elapsed: float | None = None,
    cost_line: str | None = None,
    baseline_settings: dict[str, object] | None = None,
    baseline_elapsed: float | None = None,
    baseline_cost_line: str | None = None,
    quality_baseline: int | None = None,
    quality_current: int | None = None,
    adherence_baseline: int | None = None,
    adherence_current: int | None = None,
    retrieval_baseline: int | None = None,
    retrieval_current: int | None = None,
    force_quality_metrics: bool = False,
    metrics_settings: dict[str, object] | None = None,
) -> list[object]:
    lines: list[object] = []

    def _append(line: str, tag: str | None = None) -> None:
        if tag and return_tags:
            lines.append((line, tag))
        else:
            lines.append(line)

    def _append_wrapped(text: str, tag: str | None = None) -> None:
        for line in _wrap_text(text, max_width):
            _append(line, tag)

    _append("FINAL RECOMMENDED API CALL", "section")
    goals_line = ", ".join(user_goals) if user_goals else "(not specified)"
    _append_wrapped(f"Goals: {goals_line}", "goal")
    if baseline_settings:
        _append_wrapped(
            f"Round 1 baseline (vanilla): {_format_call_settings_line(baseline_settings)}",
            "change",
        )
    recommended_settings = _settings_after_recommendation(settings, recommendation) if recommendation else settings
    metric_settings = metrics_settings or recommended_settings
    _append_wrapped(_format_call_settings_line(recommended_settings))
    baseline_diffs: list[str] = []
    if baseline_settings:
        baseline_diffs = _diff_call_settings(baseline_settings, recommended_settings)
    if recommendation:
        diffs = _diff_call_settings(settings, recommended_settings)
        if not diffs:
            if baseline_diffs:
                diffs = ["Change: none (final settings already applied)"]
            else:
                diffs = ["Change: none"]
        for diff in diffs:
            prefix = "Change: " if not diff.startswith("Change:") else ""
            _append_wrapped(f"{prefix}{diff}", "change")
    else:
        if baseline_diffs:
            _append_wrapped("No changes recommended (final settings already applied).", "change")
        else:
            _append_wrapped("No changes recommended.", "change")

    goals = set(user_goals or [])
    if goals or any(
        value is not None
        for value in (
            baseline_elapsed,
            last_elapsed,
            baseline_cost_line,
            cost_line,
            quality_baseline,
            quality_current,
            adherence_baseline,
            adherence_current,
            retrieval_baseline,
            retrieval_current,
        )
    ):
        reference_settings = baseline_settings or settings
        ref_provider_options = reference_settings.get("provider_options")
        cost_ref = _estimate_cost_value(
            provider=str(reference_settings.get("provider"))
            if reference_settings.get("provider")
            else None,
            model=str(reference_settings.get("model")) if reference_settings.get("model") else None,
            size=str(reference_settings.get("size")) if reference_settings.get("size") else None,
            provider_options=ref_provider_options if isinstance(ref_provider_options, dict) else None,
        )
        if cost_ref is None:
            if baseline_settings and baseline_cost_line:
                cost_ref = _parse_cost_amount(baseline_cost_line)
            else:
                cost_ref = _parse_cost_amount(cost_line)
        target_provider_options = (
            metric_settings.get("provider_options") if isinstance(metric_settings, dict) else None
        )
        cost_target = _estimate_cost_value(
            provider=str(metric_settings.get("provider"))
            if metric_settings.get("provider")
            else None,
            model=str(metric_settings.get("model")) if metric_settings.get("model") else None,
            size=str(metric_settings.get("size")) if metric_settings.get("size") else None,
            provider_options=target_provider_options if isinstance(target_provider_options, dict) else None,
        )
        if cost_target is None:
            if not _diff_call_settings(metric_settings, settings):
                cost_target = _parse_cost_amount(cost_line) or cost_ref
            elif baseline_settings and not _diff_call_settings(metric_settings, baseline_settings):
                cost_target = cost_ref
        if cost_target is None and cost_ref is not None:
            cost_target = cost_ref

        time_ref = baseline_elapsed if baseline_elapsed is not None else last_elapsed
        time_target = None
        if time_ref is not None:
            if last_elapsed is not None and not _diff_call_settings(metric_settings, settings):
                time_target = last_elapsed
            elif cost_ref is not None and cost_target is not None and cost_ref > 0:
                time_target = time_ref * (cost_target / cost_ref)
            else:
                area_ref = _size_area_estimate(reference_settings.get("size"))
                area_target = _size_area_estimate(metric_settings.get("size"))
                if area_ref and area_target and area_ref > 0:
                    time_target = time_ref * (area_target / area_ref)

        wants_cost = "minimize cost of render" in goals
        wants_time = "minimize time to render" in goals
        wants_quality = "maximize quality of render" in goals
        wants_retrieval = "maximize LLM retrieval score" in goals

        def _fmt_seconds(value: float | None) -> str:
            if value is None:
                return "N/A"
            return f"{value:.1f}s"

        def _fmt_cost(value: float | None) -> str:
            return _format_cost_value(value)

        def _fmt_score(value: int | None) -> str:
            if value is None:
                return "N/A"
            return f"{value}/100"

        def _delta_label_pct(
            delta: float | None,
            *,
            higher_label: str,
            lower_label: str,
            invert_sign: bool = False,
        ) -> str:
            if delta is None:
                return "N/A"
            pct = abs(delta) * 100.0
            if invert_sign:
                sign = "-" if delta > 0 else "+" if delta < 0 else ""
            else:
                sign = "+" if delta > 0 else "-" if delta < 0 else ""
            if pct < 0.5:
                return "flat"
            if pct < 3:
                return f"{sign}{pct:.0f}% (minimal, {higher_label if delta > 0 else lower_label})"
            return f"{sign}{pct:.0f}% ({higher_label if delta > 0 else lower_label})"

        def _delta_label_points(delta: int | None, *, positive_label: str, negative_label: str) -> str:
            if delta is None:
                return "N/A"
            if delta == 0:
                return "flat"
            sign = "+" if delta > 0 else "-"
            abs_delta = abs(delta)
            if abs_delta == 1:
                return f"{sign}1 pt (minimal, {positive_label if delta > 0 else negative_label})"
            return f"{sign}{abs_delta} pts ({positive_label if delta > 0 else negative_label})"

        metrics: list[dict[str, object]] = []

        cost_delta = None
        if cost_ref is not None and cost_target is not None and cost_ref > 0:
            cost_delta = (cost_target - cost_ref) / cost_ref
        metrics.append(
            {
                "key": "cost",
                "label": "Cost",
                "baseline": cost_ref,
                "target": cost_target,
                "delta": cost_delta,
                "line": f"Cost: {_fmt_cost(cost_ref)} → {_fmt_cost(cost_target)}",
                "delta_text": _delta_label_pct(
                    cost_delta,
                    higher_label="higher",
                    lower_label="lower",
                    invert_sign=True,
                ),
                "primary": wants_cost,
            }
        )

        time_delta = None
        if time_ref is not None and time_target is not None and time_ref > 0:
            time_delta = (time_target - time_ref) / time_ref
        metrics.append(
            {
                "key": "time",
                "label": "Render time",
                "baseline": time_ref,
                "target": time_target,
                "delta": time_delta,
                "line": f"Render time: {_fmt_seconds(time_ref)} → {_fmt_seconds(time_target)}",
                "delta_text": _delta_label_pct(
                    time_delta,
                    higher_label="slower",
                    lower_label="faster",
                    invert_sign=True,
                ),
                "primary": wants_time,
            }
        )

        quality_delta = None
        if quality_baseline is not None and quality_current is not None:
            quality_delta = quality_current - quality_baseline
        metrics.append(
            {
                "key": "quality",
                "label": "LLM quality",
                "baseline": quality_baseline,
                "target": quality_current,
                "delta": quality_delta,
                "line": f"LLM quality: {_fmt_score(quality_baseline)} → {_fmt_score(quality_current)}",
                "delta_text": _delta_label_points(quality_delta, positive_label="better", negative_label="worse"),
                "primary": wants_quality,
            }
        )

        adherence_delta = None
        if adherence_baseline is not None and adherence_current is not None:
            adherence_delta = adherence_current - adherence_baseline
        metrics.append(
            {
                "key": "adherence",
                "label": "Prompt adherence",
                "baseline": adherence_baseline,
                "target": adherence_current,
                "delta": adherence_delta,
                "line": f"Prompt adherence: {_fmt_score(adherence_baseline)} → {_fmt_score(adherence_current)}",
                "delta_text": _delta_label_points(adherence_delta, positive_label="better", negative_label="worse"),
                "primary": wants_quality,
            }
        )

        retrieval_delta = None
        if retrieval_baseline is not None and retrieval_current is not None:
            retrieval_delta = retrieval_current - retrieval_baseline
        metrics.append(
            {
                "key": "retrieval",
                "label": "LLM retrieval",
                "baseline": retrieval_baseline,
                "target": retrieval_current,
                "delta": retrieval_delta,
                "line": f"LLM retrieval: {_fmt_score(retrieval_baseline)} → {_fmt_score(retrieval_current)}",
                "delta_text": _delta_label_points(retrieval_delta, positive_label="better", negative_label="worse"),
                "primary": wants_retrieval,
            }
        )

        order = {"time": 0, "cost": 1, "quality": 2, "adherence": 3, "retrieval": 4}
        metrics.sort(
            key=lambda item: (
                0 if item.get("primary") else 1,
                order.get(str(item.get("key")), 9),
            )
        )

        _append_wrapped("Metric changes (baseline → suggested):", "section")
        for metric in metrics:
            line = f"{metric['line']} ({metric['delta_text']})"
            tag = "goal" if metric.get("primary") else None
            _append_wrapped(line, tag)
    return lines


def _show_final_recommendation_curses(
    stdscr,
    *,
    settings: dict[str, object],
    recommendation: object,
    user_goals: list[str] | None,
    color_enabled: bool,
    last_elapsed: float | None = None,
    cost_line: str | None = None,
    baseline_elapsed: float | None = None,
    baseline_cost_line: str | None = None,
    quality_baseline: int | None = None,
    quality_current: int | None = None,
    adherence_baseline: int | None = None,
    adherence_current: int | None = None,
    retrieval_baseline: int | None = None,
    retrieval_current: int | None = None,
    receipt_path: Path | None = None,
    baseline_settings: dict[str, object] | None = None,
    force_quality_metrics: bool = False,
    summary_note: str | None = None,
    metrics_settings: dict[str, object] | None = None,
) -> None:
    import curses
    height, width = stdscr.getmaxyx()
    max_width = max(40, width - 2)
    lines = _build_final_recommendation_lines(
        settings,
        recommendation,
        user_goals=user_goals,
        max_width=max_width,
        return_tags=True,
        last_elapsed=last_elapsed,
        cost_line=cost_line,
        baseline_settings=baseline_settings,
        baseline_elapsed=baseline_elapsed,
        baseline_cost_line=baseline_cost_line,
        quality_baseline=quality_baseline,
        quality_current=quality_current,
        adherence_baseline=adherence_baseline,
        adherence_current=adherence_current,
        retrieval_baseline=retrieval_baseline,
        retrieval_current=retrieval_current,
        force_quality_metrics=force_quality_metrics,
        metrics_settings=metrics_settings,
    )
    if summary_note:
        insert_at = 1 if len(lines) > 1 else len(lines)
        lines.insert(insert_at, (summary_note, "goal"))
    if baseline_settings:
        recommended_settings = _settings_after_recommendation(settings, recommendation) if recommendation else settings
        diff_lines = _diff_call_settings(baseline_settings, recommended_settings)
        if diff_lines:
            lines.append("")
            lines.append(("Differences vs Round 1 baseline (final settings)", "section"))
            for diff in diff_lines:
                prefix = "Change: " if not diff.startswith("Change:") else ""
                for line in _wrap_text(f"{prefix}{diff}", max_width):
                    lines.append((line, "change"))
    if receipt_path:
        run_dir = receipt_path.parent
        if _has_viewer_artifacts(run_dir):
            lines.append("")
            lines.append(("Viewer command:", "section"))
            view_cmd = f"python scripts/param_forge.py view {run_dir}"
            for line in _wrap_text(view_cmd, max_width):
                lines.append((line, "desc"))
    footer_line = "Press Q or Enter to exit"
    while True:
        _render_scrollable_text_with_banner(
            stdscr,
            title_line=f"Final recommendation (max {MAX_ROUNDS} rounds)",
            body_lines=lines,
            footer_line=footer_line,
            color_enabled=color_enabled,
            footer_attr=curses.A_DIM,
        )
        break




def _prompt_prompt_curses(
    stdscr,
    *,
    default_prompt: str,
    color_enabled: bool,
    initial_text: str | None = None,
) -> str:
    import curses
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    y = _draw_banner(stdscr, color_enabled, 1)
    title = "Enter a prompt (press Enter to use the default prompt)."
    _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
    y = min(height - 2, y + 2)
    default_line = _truncate_text(default_prompt, max(0, width - 1))
    if default_line:
        _safe_addstr(
            stdscr,
            min(height - 2, y),
            0,
            f"Default: {default_line}"[: max(0, width - 1)],
            curses.A_DIM,
        )
        y = min(height - 2, y + 2)
    input_y = min(height - 1, y + 1)
    buffer = initial_text or ""
    try:
        curses.curs_set(1)
    except curses.error:
        pass
    stdscr.timeout(-1)
    while True:
        stdscr.move(input_y, 0)
        stdscr.clrtoeol()
        display = buffer
        max_len = max(1, width - 1)
        if len(display) > max_len:
            display = display[-max_len:]
        _safe_addstr(stdscr, input_y, 0, display[: max(0, width - 1)])
        stdscr.refresh()
        key = stdscr.getch()
        if key in (10, 13, curses.KEY_ENTER):
            break
        if key in (curses.KEY_BACKSPACE, 127, 8):
            buffer = buffer[:-1]
            continue
        if 32 <= key <= 126:
            buffer += chr(key)
            continue
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    stdscr.timeout(80)
    text = buffer.strip()
    return text or default_prompt


def _show_notice_curses(stdscr, title: str, message: str, *, color_enabled: bool) -> None:
    import curses
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    y = _draw_banner(stdscr, color_enabled, 1)
    if y < height - 1:
        _safe_addstr(stdscr, y, 0, title[: max(0, width - 1)], curses.A_BOLD)
        y += 2
    for line in _wrap_text(message, max(20, width - 2)):
        if y >= height - 1:
            break
        _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)])
        y += 1
    _safe_addstr(
        stdscr,
        max(0, height - 1),
        0,
        "Press any key to continue."[: max(0, width - 1)],
        curses.A_DIM,
    )
    stdscr.refresh()
    _wait_for_non_mouse_key(stdscr)


def _prompt_text_curses(
    stdscr,
    *,
    title: str,
    default_value: str,
    color_enabled: bool,
) -> str | None:
    import curses
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    y = _draw_banner(stdscr, color_enabled, 1)
    _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
    y = min(height - 2, y + 2)
    if default_value:
        default_line = _truncate_text(default_value, max(0, width - 1))
        if default_line:
            _safe_addstr(
                stdscr,
                min(height - 2, y),
                0,
                f"Default: {default_line}"[: max(0, width - 1)],
                curses.A_DIM,
            )
            y = min(height - 2, y + 2)
    _safe_addstr(
        stdscr,
        min(height - 2, y),
        0,
        "Enter text (Esc to cancel)."[: max(0, width - 1)],
        curses.A_DIM,
    )
    input_y = min(height - 1, y + 1)
    buffer = ""
    try:
        curses.curs_set(1)
    except curses.error:
        pass
    stdscr.timeout(-1)
    while True:
        stdscr.move(input_y, 0)
        stdscr.clrtoeol()
        display = buffer
        max_len = max(1, width - 1)
        if len(display) > max_len:
            display = display[-max_len:]
        _safe_addstr(stdscr, input_y, 0, display[: max(0, width - 1)])
        stdscr.refresh()
        key = stdscr.getch()
        if key in (27,):
            buffer = ""
            return None
        if key in (10, 13, curses.KEY_ENTER):
            break
        if key in (curses.KEY_BACKSPACE, 127, 8):
            buffer = buffer[:-1]
            continue
        if 32 <= key <= 126:
            buffer += chr(key)
            continue
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    stdscr.timeout(80)
    text = buffer.strip()
    return text or default_value


def _prompt_choice_curses(
    stdscr,
    *,
    title: str,
    choices: list[str],
    default_index: int,
    color_enabled: bool,
) -> str | None:
    import curses
    idx = default_index
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
        y = min(height - 2, y + 2)
        for i, choice in enumerate(choices):
            if y >= height - 1:
                break
            attr = curses.A_DIM
            if i == idx:
                attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
            _safe_addstr(stdscr, y, 2, choice[: max(0, width - 3)], attr)
            y += 1
        _safe_addstr(
            stdscr,
            max(0, height - 1),
            0,
            "Up/Down: move • Enter: select • Q/Esc: cancel"[: max(0, width - 1)],
            curses.A_DIM,
        )
        stdscr.refresh()
        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key in (ord("q"), ord("Q"), 27):
            return None
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            idx = (idx - 1) % len(choices)
            continue
        if key in (curses.KEY_DOWN, ord("j"), ord("J")):
            idx = (idx + 1) % len(choices)
            continue
        if key in (10, 13, curses.KEY_ENTER):
            return choices[idx]


def _prompt_multi_select_curses(
    stdscr,
    *,
    title: str,
    choices: list[str],
    default_indices: list[int] | None,
    color_enabled: bool,
) -> list[str] | None:
    import curses
    if default_indices is None:
        default_indices = []
    selected = [i in default_indices for i in range(len(choices))]
    idx = 0
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
        y = min(height - 2, y + 2)
        for i, choice in enumerate(choices):
            if y >= height - 1:
                break
            marker = "[x]" if selected[i] else "[ ]"
            line = f"{marker} {choice}"
            attr = curses.A_DIM
            if i == idx:
                attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
            _safe_addstr(stdscr, y, 2, line[: max(0, width - 3)], attr)
            y += 1
        _safe_addstr(
            stdscr,
            max(0, height - 1),
            0,
            "Space: toggle • Enter: continue • Q/Esc: cancel"[: max(0, width - 1)],
            curses.A_DIM,
        )
        stdscr.refresh()
        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key in (ord("q"), ord("Q"), 27):
            return None
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            idx = (idx - 1) % len(choices)
            continue
        if key in (curses.KEY_DOWN, ord("j"), ord("J")):
            idx = (idx + 1) % len(choices)
            continue
        if key in (ord(" "),):
            selected[idx] = not selected[idx]
            continue
        if key in (10, 13, curses.KEY_ENTER):
            result = [choice for i, choice in enumerate(choices) if selected[i]]
            return result


class _QueueWriter(io.TextIOBase):
    def __init__(self, sink: queue.SimpleQueue[str]) -> None:
        super().__init__()
        self._sink = sink
        self._buffer = ""

    def write(self, s: str) -> int:
        if not s:
            return 0
        self._buffer += s
        while "\n" in self._buffer:
            line, rest = self._buffer.split("\n", 1)
            if not any(token in line for token in _EXPERIMENT_LOG_SUPPRESS):
                self._sink.put(line)
            self._buffer = rest
        return len(s)

    def flush(self) -> None:
        if self._buffer:
            if not any(token in self._buffer for token in _EXPERIMENT_LOG_SUPPRESS):
                self._sink.put(self._buffer)
            self._buffer = ""


def _experiment_progress_from_manifest(manifest: dict) -> dict[str, int]:
    counts = {"total": 0, "pending": 0, "running": 0, "success": 0, "failed": 0, "skipped": 0}
    jobs = manifest.get("jobs")
    if not isinstance(jobs, list):
        return counts
    counts["total"] = len(jobs)
    for job in jobs:
        if not isinstance(job, dict):
            continue
        status = str(job.get("status") or "pending")
        if status in counts:
            counts[status] += 1
        else:
            counts["pending"] += 1
    return counts


def _normalize_provider_from_model(provider: str | None, model: str | None) -> str | None:
    if provider:
        provider_key, _ = _normalize_provider_and_model(str(provider), str(model) if model else None)
        return provider_key
    if model:
        model_key = str(model).lower()
        if "imagen" in model_key:
            return "imagen"
        if "gemini" in model_key:
            return "gemini"
        if "flux" in model_key:
            return "flux"
        if "gpt-image" in model_key or "openai" in model_key:
            return "openai"
    return None


def _extract_providers_from_matrix_payload(payload: dict) -> set[str]:
    providers: set[str] = set()
    for key in ("matrix", "include"):
        blocks = payload.get(key)
        if isinstance(blocks, dict):
            blocks = [blocks]
        if not isinstance(blocks, list):
            continue
        for block in blocks:
            if not isinstance(block, dict):
                continue
            provider_raw = block.get("provider")
            models_raw = block.get("model")
            models = _normalize_to_list(models_raw) if models_raw is not None else []
            if provider_raw is None and models:
                for model in models:
                    normalized = _normalize_provider_from_model(None, str(model))
                    if normalized:
                        providers.add(normalized)
                continue
            provider_key = _normalize_provider_from_model(str(provider_raw) if provider_raw else None, None)
            if provider_key == "gemini" and models:
                # Separate gemini vs imagen if models are mixed under google.
                for model in models:
                    normalized = _normalize_provider_from_model(str(provider_raw), str(model))
                    if normalized:
                        providers.add(normalized)
                continue
            if provider_key:
                providers.add(provider_key)
    return providers


def _run_experiment_curses(
    stdscr,
    *,
    args: argparse.Namespace,
    color_enabled: bool,
) -> int:
    import curses
    run_dir = Path(str(args.out)).expanduser().resolve()
    manifest_path = run_dir / "run.json"
    cancel_event = threading.Event()
    setattr(args, "cancel_event", cancel_event)
    _load_repo_dotenv()
    providers: set[str] = set()
    if getattr(args, "resume", False) and manifest_path.exists():
        try:
            existing = json.loads(manifest_path.read_text(encoding="utf-8"))
            jobs = existing.get("jobs") if isinstance(existing, dict) else None
            if isinstance(jobs, list):
                for job in jobs:
                    if not isinstance(job, dict):
                        continue
                    params = job.get("params") if isinstance(job.get("params"), dict) else {}
                    provider = params.get("provider")
                    if provider:
                        providers.add(str(provider))
        except Exception:
            providers = set()
    if not providers:
        matrix_payload = getattr(args, "matrix_payload", None)
        matrix_path = getattr(args, "matrix", None)
        if matrix_payload and isinstance(matrix_payload, dict):
            providers = _extract_providers_from_matrix_payload(matrix_payload)
        elif matrix_path:
            try:
                payload = _load_matrix_file(Path(str(matrix_path)).expanduser().resolve())
                if isinstance(payload, dict):
                    providers = _extract_providers_from_matrix_payload(payload)
            except Exception:
                providers = set()
    if not providers:
        providers = {"openai"}
    for provider in sorted(providers):
        try:
            _ensure_api_keys(
                provider,
                _find_repo_dotenv(),
                allow_prompt=True,
                prompt_func=lambda key, path: _prompt_for_key_curses(stdscr, key, path),
            )
        except RuntimeError as exc:
            _show_notice_curses(stdscr, "Setup failed", str(exc), color_enabled=color_enabled)
            return 1
    log_queue: queue.SimpleQueue[str] = queue.SimpleQueue()
    log_lines: list[str] = []
    max_log_lines = 6
    done_event = threading.Event()
    exit_code_holder: dict[str, int] = {"code": 1}

    def _runner() -> None:
        writer = _QueueWriter(log_queue)
        with contextlib.redirect_stdout(writer), contextlib.redirect_stderr(writer):
            exit_code_holder["code"] = _run_experiment_from_namespace(args)
        done_event.set()

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()

    while True:
        while True:
            try:
                line = log_queue.get_nowait()
            except Exception:
                break
            if line is None:
                break
            log_lines.append(str(line))
            if len(log_lines) > max_log_lines:
                log_lines = log_lines[-max_log_lines:]

        manifest: dict | None = None
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                manifest = None

        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        title = "Batch run"
        _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
        y = min(height - 2, y + 2)

        if manifest and isinstance(manifest, dict):
            inputs = manifest.get("inputs") if isinstance(manifest.get("inputs"), dict) else {}
            summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
            limits = manifest.get("limits") if isinstance(manifest.get("limits"), dict) else {}
            prompt_count = inputs.get("prompt_count")
            jobs_count = inputs.get("expanded_jobs")
            images_count = inputs.get("planned_images")
            plan_line = f"prompts={prompt_count} jobs={jobs_count} images={images_count}"
            _safe_addstr(stdscr, y, 0, plan_line[: max(0, width - 1)], curses.A_BOLD)
            y += 1
            budget = limits.get("budget_usd")
            budget_mode = limits.get("budget_mode")
            concurrency = limits.get("concurrency")
            line = f"concurrency={concurrency} budget={budget} mode={budget_mode}"
            _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)])
            y += 1
            est_cost = summary.get("estimated_cost_usd")
            _safe_addstr(stdscr, y, 0, f"estimated_cost_usd={est_cost}"[: max(0, width - 1)])
            y += 1
            progress = _experiment_progress_from_manifest(manifest)
            progress_line = (
                f"pending={progress['pending']} running={progress['running']} "
                f"ok={progress['success']} failed={progress['failed']} skipped={progress['skipped']}"
            )
            _safe_addstr(stdscr, y, 0, progress_line[: max(0, width - 1)], curses.A_BOLD)
            y += 2
        else:
            _safe_addstr(stdscr, y, 0, "Planning run..."[: max(0, width - 1)], curses.A_DIM)
            y += 2

        if log_lines and y < height - 1:
            _safe_addstr(stdscr, y, 0, "Log:"[: max(0, width - 1)], curses.A_DIM)
            y += 1
            for line in log_lines:
                if y >= height - 1:
                    break
                _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)], curses.A_DIM)
                y += 1

        footer = "Running... (Q to cancel)"
        if cancel_event.is_set():
            footer = "Cancelling... waiting for in-flight jobs"
        if done_event.is_set():
            if cancel_event.is_set():
                footer = "Run cancelled. Press Enter to exit"
            else:
                footer = "Run complete. Press Enter to exit"
        _safe_addstr(stdscr, max(0, height - 1), 0, footer[: max(0, width - 1)], curses.A_DIM)
        stdscr.refresh()

        if done_event.is_set():
            stdscr.timeout(-1)
            key = stdscr.getch()
            if _handle_capture_key(stdscr, key):
                continue
            if key in (10, 13, curses.KEY_ENTER, ord("q"), ord("Q"), 27):
                return int(exit_code_holder.get("code", 1))
        else:
            stdscr.timeout(200)
            key = stdscr.getch()
            if _handle_capture_key(stdscr, key):
                continue
            if key in (ord("q"), ord("Q"), 27):
                cancel_event.set()
                continue


def _prompt_int_curses(
    stdscr,
    *,
    title: str,
    default_value: int,
    minimum: int,
    maximum: int,
    color_enabled: bool,
) -> int | None:
    while True:
        text = _prompt_text_curses(
            stdscr,
            title=title,
            default_value=str(default_value),
            color_enabled=color_enabled,
        )
        if text is None:
            return None
        try:
            value = int(text)
        except Exception:
            _show_notice_curses(stdscr, "Invalid number", f"Enter a number between {minimum} and {maximum}.", color_enabled=color_enabled)
            continue
        if minimum <= value <= maximum:
            return value
        _show_notice_curses(stdscr, "Invalid number", f"Enter a number between {minimum} and {maximum}.", color_enabled=color_enabled)


def _prompt_float_curses(
    stdscr,
    *,
    title: str,
    default_value: str,
    color_enabled: bool,
) -> float | None | str:
    while True:
        text = _prompt_text_curses(
            stdscr,
            title=title,
            default_value=default_value,
            color_enabled=color_enabled,
        )
        if text is None:
            return None
        if text == "":
            return ""
        try:
            value = float(text)
        except Exception:
            _show_notice_curses(stdscr, "Invalid number", "Enter a non-negative number or leave blank.", color_enabled=color_enabled)
            continue
        if value < 0:
            _show_notice_curses(stdscr, "Invalid number", "Enter a non-negative number or leave blank.", color_enabled=color_enabled)
            continue
        return value


def _interactive_experiment_args_curses(
    stdscr,
    *,
    color_enabled: bool,
) -> argparse.Namespace | None:
    prompts_path: str | None = None
    prompt_text: str | None = None
    matrix_payload: dict | None = None
    source = _prompt_choice_curses(
        stdscr,
        title="Prompt source",
        choices=["single prompt", "prompts file"],
        default_index=0,
        color_enabled=color_enabled,
    )
    if source is None:
        return None
    if source == "prompts file":
        while True:
            prompts_path = _prompt_text_curses(
                stdscr,
                title="Prompts file (.txt/.csv)",
                default_value="",
                color_enabled=color_enabled,
            )
            if prompts_path is None:
                return None
            if not prompts_path.strip():
                _show_notice_curses(stdscr, "Missing prompts", "Prompts file is required.", color_enabled=color_enabled)
                continue
            if not Path(prompts_path).expanduser().exists():
                _show_notice_curses(
                    stdscr,
                    "Missing prompts",
                    f"Prompts file not found: {prompts_path}",
                    color_enabled=color_enabled,
                )
                continue
            break
    else:
        prompt_text = _prompt_prompt_curses(
            stdscr,
            default_prompt=DEFAULT_PROMPTS[0],
            color_enabled=color_enabled,
        )
    matrix_path: str | None = None
    matrix_source = _prompt_choice_curses(
        stdscr,
        title="Matrix source",
        choices=["auto (select providers/models)", "matrix file"],
        default_index=0,
        color_enabled=color_enabled,
    )
    if matrix_source is None:
        return None
    if matrix_source == "matrix file":
        while True:
            matrix_path = _prompt_text_curses(
                stdscr,
                title="Matrix file (.yaml/.json)",
                default_value="matrix.yaml",
                color_enabled=color_enabled,
            )
            if matrix_path is None:
                return None
            if not matrix_path.strip():
                _show_notice_curses(stdscr, "Missing matrix", "Matrix file is required.", color_enabled=color_enabled)
                continue
            if not Path(matrix_path).expanduser().exists():
                _show_notice_curses(
                    stdscr,
                    "Missing matrix",
                    f"Matrix file not found: {matrix_path}",
                    color_enabled=color_enabled,
                )
                continue
            break
    else:
        provider_display = _prompt_multi_select_curses(
            stdscr,
            title="Providers",
            choices=_provider_display_choices(),
            default_indices=[0],
            color_enabled=color_enabled,
        )
        if provider_display is None:
            return None
        provider_keys = [_provider_from_display(item) for item in provider_display]
        matrix_blocks: list[dict[str, object]] = []
        for provider_key in provider_keys:
            models = _prompt_multi_select_curses(
                stdscr,
                title=f"Models for {provider_key}",
                choices=_model_choices_for(provider_key),
                default_indices=[0],
                color_enabled=color_enabled,
            )
            if not models:
                continue
            matrix_blocks.append(
                {
                    "provider": provider_key,
                    "model": models,
                }
            )
        if not matrix_blocks:
            matrix_blocks = [{"provider": "openai", "model": ["gpt-image-1.5"]}]
        size_label = _prompt_choice_curses(
            stdscr,
            title="Size",
            choices=_size_label_choices(),
            default_index=0,
            color_enabled=color_enabled,
        )
        if size_label is None:
            return None
        size_value = _size_value_from_label(size_label)
        n_value = _prompt_int_curses(
            stdscr,
            title="Images per prompt",
            default_value=1,
            minimum=1,
            maximum=4,
            color_enabled=color_enabled,
        )
        if n_value is None:
            return None
        matrix_payload = {
            "version": 1,
            "defaults": {"n": n_value},
            "matrix": [],
        }
        for block in matrix_blocks:
            matrix_payload["matrix"].append(
                {
                    "provider": block["provider"],
                    "model": block["model"],
                    "size": [size_value],
                }
            )
    out_dir = _prompt_text_curses(
        stdscr,
        title="Output run directory",
        default_value=_default_experiment_out_dir(),
        color_enabled=color_enabled,
    )
    if out_dir is None:
        return None
    resume = False
    while True:
        manifest_path = Path(out_dir).expanduser().resolve() / "run.json"
        if manifest_path.exists():
            choice = _prompt_choice_curses(
                stdscr,
                title="run.json exists. Resume?",
                choices=["resume", "choose new"],
                default_index=0,
                color_enabled=color_enabled,
            )
            if choice is None:
                return None
            if choice == "resume":
                resume = True
                break
            out_dir = _prompt_text_curses(
                stdscr,
                title="Output run directory",
                default_value=_default_experiment_out_dir(),
                color_enabled=color_enabled,
            )
            if out_dir is None:
                return None
            continue
        break
    concurrency = _prompt_int_curses(
        stdscr,
        title="Concurrency",
        default_value=_EXPERIMENT_DEFAULT_CONCURRENCY,
        minimum=1,
        maximum=64,
        color_enabled=color_enabled,
    )
    if concurrency is None:
        return None
    provider_concurrency = _prompt_text_curses(
        stdscr,
        title="Provider concurrency (optional, e.g. openai=1,gemini=2)",
        default_value="",
        color_enabled=color_enabled,
    )
    if provider_concurrency is None:
        return None
    budget_value = _prompt_float_curses(
        stdscr,
        title="Budget USD (blank for none)",
        default_value="",
        color_enabled=color_enabled,
    )
    if budget_value is None:
        return None
    budget = None if budget_value == "" else float(budget_value)
    budget_mode = _prompt_choice_curses(
        stdscr,
        title="Budget mode",
        choices=list(_EXPERIMENT_BUDGET_MODES),
        default_index=0,
        color_enabled=color_enabled,
    )
    if budget_mode is None:
        return None
    dry_run_choice = _prompt_choice_curses(
        stdscr,
        title="Dry run",
        choices=["no", "yes"],
        default_index=0,
        color_enabled=color_enabled,
    )
    if dry_run_choice is None:
        return None
    dry_run = dry_run_choice.lower().startswith("y")
    return _build_experiment_namespace(
        prompts_path=prompts_path,
        prompt_text=prompt_text,
        matrix_payload=matrix_payload,
        matrix_path=matrix_path,
        out_dir=out_dir,
        concurrency=concurrency,
        provider_concurrency=provider_concurrency or None,
        budget=budget,
        budget_mode=budget_mode,
        dry_run=dry_run,
        resume=resume,
    )


def _prompt_freeform_curses(stdscr, prompt: str, *, color_enabled: bool) -> str:
    import curses
    stdscr.erase()
    height, width = stdscr.getmaxyx()
    y = _draw_banner(stdscr, color_enabled, 1)
    if y < height - 1:
        _safe_addstr(stdscr, y, 0, prompt[: max(0, width - 1)], curses.A_BOLD)
        y += 2
    _safe_addstr(stdscr, min(height - 2, y), 0, "Type your notes and press Enter."[: max(0, width - 1)], curses.A_DIM)
    stdscr.refresh()
    curses.echo()
    try:
        entry = stdscr.getstr(min(height - 1, y + 1), 0, max(1, width - 1))
        text = entry.decode("utf-8", errors="ignore").strip()
    except Exception:
        text = ""
    finally:
        curses.noecho()
    return text


def _prompt_goal_selection_curses(stdscr, color_enabled: bool) -> tuple[list[str], str | None] | None:
    import curses
    options = [
        "minimize time to render",
        "minimize cost of render",
        "maximize quality of render",
        "maximize LLM retrieval score",
        "something else",
    ]
    selected = [False] * len(options)
    idx = 0
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        title = "Select your goals (space to toggle, Enter to continue)"
        _safe_addstr(stdscr, min(height - 2, y), 0, title[: max(0, width - 1)], curses.A_BOLD)
        y = min(height - 2, y + 2)
        for i, option in enumerate(options):
            if y >= height - 1:
                break
            marker = "[x]" if selected[i] else "[ ]"
            line = f"{marker} {option}"
            attr = curses.A_DIM
            if i == idx:
                attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
            _safe_addstr(stdscr, y, 2, line[: max(0, width - 3)], attr)
            y += 1
        footer = "Space: toggle • Enter: continue • Q/Esc: cancel"
        _safe_addstr(stdscr, height - 1, 0, footer[: max(0, width - 1)], curses.A_DIM)
        stdscr.refresh()

        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key in (ord("q"), ord("Q"), 27):
            return None
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            idx = (idx - 1) % len(options)
            continue
        if key in (curses.KEY_DOWN, ord("j"), ord("J")):
            idx = (idx + 1) % len(options)
            continue
        if key == ord(" "):
            selected[idx] = not selected[idx]
            continue
        if key in (10, 13, curses.KEY_ENTER):
            if not any(selected):
                selected[idx] = True
            break

    goals = [opt for opt, is_on in zip(options, selected) if is_on]
    notes = None
    if "something else" in goals:
        notes = _prompt_freeform_curses(
            stdscr,
            "Tell us more about your goal:",
            color_enabled=color_enabled,
        )
    return goals, notes


def _prompt_yes_no_curses(
    stdscr,
    prompt: str,
    *,
    color_enabled: bool,
    footer_line: str | None = None,
) -> bool:
    import curses
    if footer_line is None:
        footer_line = "Press Y to run, N or Esc to cancel"
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        if y < height - 2:
            _safe_addstr(stdscr, y, 0, prompt[: max(0, width - 1)], curses.A_BOLD)
            y += 2
        _safe_addstr(
            stdscr,
            min(height - 1, y),
            0,
            footer_line[: max(0, width - 1)],
            curses.A_DIM,
        )
        stdscr.refresh()
        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key in (ord("y"), ord("Y")):
            return True
        if key in (ord("n"), ord("N"), 27):
            return False


def _add_wrapped_lines(
    lines: list[object],
    text: str,
    *,
    max_width: int,
    tag: str | None = None,
) -> None:
    wrapped = _wrap_text(text, max_width)
    if tag and wrapped:
        lines.append((wrapped[0], tag))
        for line in wrapped[1:]:
            lines.append(line)
        return
    for line in wrapped:
        lines.append(line)


def _add_param_doc_lines(
    lines: list[object],
    name: str,
    desc: str,
    *,
    max_width: int,
    tagged: bool,
) -> None:
    label = f"  {name}"
    if tagged:
        lines.append((label[: max_width], "param"))
    else:
        lines.append(label[: max_width])
    if not desc:
        return
    indent = "    "
    desc_width = max(10, max_width - len(indent))
    wrapped_desc = _wrap_text(desc, desc_width)
    for line in wrapped_desc:
        text = f"{indent}{line}"
        if tagged:
            lines.append((text[: max_width], "desc"))
        else:
            lines.append(text[: max_width])


def _build_api_explore_lines(
    max_width: int,
    *,
    tagged: bool = True,
    provider_filter: str | None = None,
    model_filter: str | None = None,
) -> list[object]:
    def _display_param_name(name: str) -> str:
        prefix = "provider_options."
        if name.startswith(prefix):
            return name[len(prefix):]
        return name

    lines: list[object] = []
    _add_wrapped_lines(
        lines,
        "API Explore (stub): known params per provider/model with cost notes.",
        max_width=max_width,
        tag="section" if tagged else None,
    )
    _add_wrapped_lines(
        lines,
        "Request params are top-level; provider options are nested under provider_options.",
        max_width=max_width,
    )
    lines.append("")
    sections = [
        ("OpenAI (provider: openai)", "openai", MODEL_CHOICES_BY_PROVIDER.get("openai", [])),
        ("Gemini (provider: google -> gemini)", "gemini", MODEL_CHOICES_BY_PROVIDER.get("gemini", [])),
        ("Imagen (provider: google -> imagen)", "imagen", MODEL_CHOICES_BY_PROVIDER.get("imagen", [])),
        ("Flux / BFL (provider: black forest labs)", "flux", MODEL_CHOICES_BY_PROVIDER.get("flux", [])),
    ]
    for title, provider_key, models in sections:
        if provider_filter and provider_key != provider_filter:
            continue
        _add_wrapped_lines(
            lines,
            title,
            max_width=max_width,
            tag="section" if tagged else None,
        )
        if not models:
            models = ["(default)"]
        for model in models:
            if model_filter and str(model) != str(model_filter):
                continue
            _add_wrapped_lines(
                lines,
                f"Model: {model}",
                max_width=max_width,
                tag="goal" if tagged else None,
            )
            _add_wrapped_lines(
                lines,
                "Request params:",
                max_width=max_width,
                tag="section" if tagged else None,
            )
            for name, desc in _API_COMMON_PARAMS:
                _add_param_doc_lines(
                    lines,
                    name,
                    desc,
                    max_width=max_width,
                    tagged=tagged,
                )
            provider_params = _API_PROVIDER_PARAMS.get(provider_key, [])
            if provider_params:
                lines.append("")
                _add_wrapped_lines(
                    lines,
                    "Provider options:",
                    max_width=max_width,
                    tag="section" if tagged else None,
                )
                for name, desc in provider_params:
                    label = _display_param_name(name)
                    _add_param_doc_lines(
                        lines,
                        label,
                        desc,
                        max_width=max_width,
                        tagged=tagged,
                    )
            lines.append("")
    return lines


def _show_api_explore_curses(stdscr, *, color_enabled: bool) -> None:
    provider_choices = ["All providers", "OpenAI", "Gemini", "Imagen", "Flux"]
    provider_map = {
        "OpenAI": "openai",
        "Gemini": "gemini",
        "Imagen": "imagen",
        "Flux": "flux",
    }

    while True:
        provider_choice = _prompt_choice_curses(
            stdscr,
            title="API Explore - pick provider",
            choices=provider_choices,
            default_index=0,
            color_enabled=color_enabled,
        )
        if provider_choice is None:
            return
        provider_filter = provider_map.get(provider_choice)
        model_filter = None
        if provider_filter:
            models = MODEL_CHOICES_BY_PROVIDER.get(provider_filter, [])
            model_choices = ["All models"] + list(models)
            model_choice = _prompt_choice_curses(
                stdscr,
                title="API Explore - pick model",
                choices=model_choices,
                default_index=0,
                color_enabled=color_enabled,
            )
            if model_choice is None:
                return
            if model_choice != "All models":
                model_filter = model_choice

        height, width = stdscr.getmaxyx()
        body_lines = _build_api_explore_lines(
            max_width=max(32, width - 2),
            tagged=True,
            provider_filter=provider_filter,
            model_filter=model_filter,
        )
        result = _render_scrollable_text_with_banner(
            stdscr,
            title_line="API Explore - provider/model params",
            body_lines=body_lines,
            footer_line="Up/Down/PgUp/PgDn to scroll • R to re-pick • C to capture • Q/Esc/Enter to exit",
            color_enabled=color_enabled,
            action_keys={ord("r"): "repick", ord("R"): "repick"},
        )
        if result != "repick":
            return


def _show_api_explore_raw() -> None:
    provider_choices = ["All providers", "OpenAI", "Gemini", "Imagen", "Flux"]
    provider_map = {
        "OpenAI": "openai",
        "Gemini": "gemini",
        "Imagen": "imagen",
        "Flux": "flux",
    }
    while True:
        provider_choice = _prompt_choice("API Explore - Provider", provider_choices, 0)
        provider_filter = provider_map.get(provider_choice)
        model_filter = None
        if provider_filter:
            models = MODEL_CHOICES_BY_PROVIDER.get(provider_filter, [])
            model_choices = ["All models"] + list(models)
            model_choice = _prompt_choice("API Explore - Model", model_choices, 0)
            if model_choice != "All models":
                model_filter = model_choice

        max_width = max(60, _term_width(90) - 2)
        body_lines = _build_api_explore_lines(
            max_width=max_width,
            tagged=False,
            provider_filter=provider_filter,
            model_filter=model_filter,
        )
        print("\nAPI Explore - provider/model params\n")
        for line in body_lines:
            if isinstance(line, tuple):
                print(line[0])
            else:
                print(str(line))
        try:
            choice = input("\nPress Enter to return, or R to re-pick: ").strip().lower()
        except EOFError:
            return
        if choice == "r":
            continue
        return


def _render_scrollable_text(
    stdscr,
    *,
    header_lines: list[str],
    body_lines: list[object],
    footer_line: str,
    color_enabled: bool,
) -> None:
    import curses
    top = 0
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = 0
        for line in header_lines:
            if y >= height - 1:
                break
            _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)], curses.A_BOLD)
            y += 1
        available = max(1, height - y - 1)
        max_top = max(0, len(body_lines) - available)
        visible = body_lines[top : top + available]
        for line in visible:
            if y >= height - 1:
                break
            text, attr = _line_text_and_attr(line, color_enabled=color_enabled)
            _safe_addstr(stdscr, y, 0, text[: max(0, width - 1)], attr)
            y += 1
        if height > 0:
            _safe_addstr(
                stdscr,
                height - 1,
                0,
                footer_line[: max(0, width - 1)],
                curses.A_DIM,
            )
        stdscr.refresh()

        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if key in (ord("q"), ord("Q"), 27, 10, 13):
            break
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            top = max(0, top - 1)
        elif key in (curses.KEY_DOWN, ord("j"), ord("J")):
            top = min(max_top, top + 1)
        elif key in (curses.KEY_PPAGE,):
            top = max(0, top - available)
        elif key in (curses.KEY_NPAGE,):
            top = min(max_top, top + available)
        elif key == curses.KEY_HOME:
            top = 0
        elif key == curses.KEY_END:
            top = max_top


def _render_scrollable_text_with_banner(
    stdscr,
    *,
    title_line: str,
    body_lines: list[object],
    footer_line: str,
    color_enabled: bool,
    emphasis_line: str | None = None,
    footer_attr: int | None = None,
    footer_hotkeys: dict[str, int] | None = None,
    accept_keys: set[int] | None = None,
    open_keys: set[int] | None = None,
    action_keys: dict[int, str] | None = None,
) -> str:
    import curses
    top = 0
    while True:
        stdscr.erase()
        height, width = stdscr.getmaxyx()
        y = _draw_banner(stdscr, color_enabled, 1)
        if y < height - 1:
            _safe_addstr(stdscr, y, 0, title_line[: max(0, width - 1)], curses.A_BOLD)
            y += 1
        if emphasis_line and y < height - 1:
            for line in _wrap_text(emphasis_line, max(20, width - 2)):
                if y >= height - 1:
                    break
                _safe_addstr(stdscr, y, 0, line[: max(0, width - 1)], curses.A_BOLD)
                y += 1
        if y < height - 1:
            y += 1
        available = max(1, height - y - 1)
        max_top = max(0, len(body_lines) - available)
        visible = body_lines[top : top + available]
        for line in visible:
            if y >= height - 1:
                break
            text, attr = _line_text_and_attr(line, color_enabled=color_enabled)
            _safe_addstr(stdscr, y, 0, text[: max(0, width - 1)], attr)
            y += 1
        if height > 0:
            attr = footer_attr if footer_attr is not None else curses.A_DIM
            _safe_addstr(
                stdscr,
                height - 1,
                0,
                footer_line[: max(0, width - 1)],
                attr,
            )
            if footer_hotkeys:
                for key_char, key_attr in footer_hotkeys.items():
                    pos = footer_line.find(f"({key_char})")
                    if pos != -1 and pos + 1 < width:
                        _safe_addstr(stdscr, height - 1, pos + 1, key_char, key_attr)
        stdscr.refresh()

        key = stdscr.getch()
        if _handle_capture_key(stdscr, key):
            continue
        if accept_keys and key in accept_keys:
            return "accept"
        if open_keys and key in open_keys:
            return "open"
        if action_keys and key in action_keys:
            return action_keys[key]
        if key in (ord("q"), ord("Q"), 27, 10, 13):
            return "exit"
        if key in (curses.KEY_UP, ord("k"), ord("K")):
            top = max(0, top - 1)
        elif key in (curses.KEY_DOWN, ord("j"), ord("J")):
            top = min(max_top, top + 1)
        elif key in (curses.KEY_PPAGE,):
            top = max(0, top - available)
        elif key in (curses.KEY_NPAGE,):
            top = min(max_top, top + available)
        elif key == curses.KEY_HOME:
            top = 0
        elif key == curses.KEY_END:
            top = max_top
    return "exit"


def _show_receipt_analysis_curses(
    stdscr,
    *,
    receipt_path: Path,
    provider: str,
    model: str | None,
    size: str,
    n: int,
    out_dir: str,
    analyzer: str | None = None,
    color_enabled: bool,
    user_goals: list[str] | None = None,
    user_notes: str | None = None,
    analysis_history: list[dict] | None = None,
    local_history_text: str | None = None,
    emphasis_line: str | None = None,
    allow_rerun: bool = True,
    last_elapsed: float | None = None,
    last_cost: str | None = None,
    benchmark_elapsed: float | None = None,
    round_scores: tuple[int | None, int | None] | None = None,
) -> tuple[list[dict] | None, str | None, bool, bool]:
    import curses
    analyzer_key = _normalize_analyzer(analyzer)
    cost_line: str | None = None
    pre_cost_line: str | None = None
    current_round = len(analysis_history or []) + 1
    rounds_left = max(0, MAX_ROUNDS - current_round)
    baseline_elapsed: float | None = None
    baseline_cost_text: str | None = None
    if analysis_history:
        first_entry = analysis_history[0]
        first_elapsed = first_entry.get("elapsed")
        if isinstance(first_elapsed, (int, float)):
            baseline_elapsed = float(first_elapsed)
        baseline_cost_text = _strip_cost_prefix(first_entry.get("cost"))

    if user_goals and "minimize cost of render" in user_goals and not last_cost:
        provider_options = None
        try:
            receipt = _load_receipt_payload(receipt_path)
            if isinstance(receipt, dict):
                request = receipt.get("request") if isinstance(receipt.get("request"), dict) else None
                resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else None
                if isinstance(request, dict) and isinstance(request.get("provider_options"), dict):
                    if request.get("provider_options"):
                        provider_options = request.get("provider_options")
                elif isinstance(resolved, dict) and isinstance(resolved.get("provider_params"), dict):
                    if resolved.get("provider_params"):
                        provider_options = resolved.get("provider_params")
        except Exception:
            provider_options = None
        pre_cost_line = _estimate_cost_only(
            provider=provider,
            model=model,
            size=size,
            n=n,
            provider_options=provider_options if isinstance(provider_options, dict) else None,
        )
        if pre_cost_line:
            last_cost = str(pre_cost_line).replace("COST:", "").strip()

    stdscr.erase()
    height, width = stdscr.getmaxyx()
    y = _draw_banner(stdscr, color_enabled, 1)
    if y < height - 1:
        _safe_addstr(
            stdscr,
            y,
            0,
            f"Analyzing receipt with {_analyzer_display_name(analyzer_key)}..."[: max(0, width - 1)],
        )
        y += 1
    if analyzer_key == "council" and y < height - 1:
        note_text = "Note: Council analysis can take a few minutes."
        note_attr = curses.A_DIM if hasattr(curses, "A_DIM") else 0
        _safe_addstr(stdscr, y, 0, note_text[: max(0, width - 1)], note_attr)
        y += 1
    if y < height - 1:
        model_label = model or "(default)"
        provider_line = f"Provider/Model: {_display_provider_name(provider) or provider} • {model_label}"
        _safe_addstr(stdscr, y, 0, provider_line[: max(0, width - 1)], curses.A_BOLD)
        y += 1
    if user_goals and y < height - 1:
        goals_text = "Goals: " + ", ".join(user_goals)
        goals_attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
        _safe_addstr(stdscr, y, 0, goals_text[: max(0, width - 1)], goals_attr)
        y += 1
    if y < height - 1:
        rounds_text = f"Rounds left: {rounds_left} (of {MAX_ROUNDS})"
        rounds_attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
        _safe_addstr(stdscr, y, 0, rounds_text[: max(0, width - 1)], rounds_attr)
        y += 1
    if user_goals and "minimize time to render" in user_goals and y < height - 1:
        if baseline_elapsed is not None and last_elapsed is not None:
            speed_text = f"Speed baseline: {baseline_elapsed:.1f}s → latest {last_elapsed:.1f}s"
        elif benchmark_elapsed is not None and last_elapsed is not None:
            speed_text = f"Speed benchmark: {benchmark_elapsed:.1f}s → latest {last_elapsed:.1f}s"
        else:
            speed_text = "Last render: unknown"
            if last_elapsed is not None:
                speed_text = f"Last render: {last_elapsed:.1f}s"
        _safe_addstr(stdscr, y, 0, speed_text[: max(0, width - 1)], curses.A_BOLD)
        y += 1
    if user_goals and "minimize cost of render" in user_goals and y < height - 1:
        cost_text = "Cost benchmark: estimating..."
        if baseline_cost_text:
            cost_text = f"Cost baseline: {baseline_cost_text}"
        elif last_cost:
            cost_text = f"Cost benchmark: {last_cost}"
        _safe_addstr(stdscr, y, 0, cost_text[: max(0, width - 1)], curses.A_BOLD)
        y += 1
    stdscr.refresh()
    result_holder: dict[str, object] = {}
    done = threading.Event()

    def _run_analysis() -> None:
        try:
            history_text = _format_analysis_history(analysis_history or [])
            result_holder["payload"] = _analyze_receipt_payload(
                receipt_path=receipt_path,
                provider=provider,
                model=model,
                size=size,
                n=n,
                out_dir=out_dir,
                analyzer=analyzer_key,
                user_goals=user_goals,
                user_notes=user_notes,
                history_text=history_text,
                local_history_text=local_history_text,
                history_rounds=len(analysis_history or []),
            )
        except Exception as exc:
            result_holder["error"] = exc
        finally:
            done.set()

    thread = threading.Thread(target=_run_analysis, daemon=True)
    thread.start()
    status_y = min(y, height - 1)
    frames = ["|", "/", "-", "\\"]
    frame_idx = 0
    while not done.is_set():
        status = f"Analyzing… {frames[frame_idx % len(frames)]}"
        _safe_addstr(stdscr, status_y, 0, status[: max(0, width - 1)], curses.A_DIM)
        stdscr.refresh()
        frame_idx += 1
        time.sleep(0.1)
    thread.join()

    if "error" in result_holder:
        exc = result_holder["error"]
        body_lines = _wrap_text(f"Receipt analysis failed: {exc}", max(20, width - 2))
        _render_scrollable_text_with_banner(
            stdscr,
            title_line="Receipt analysis failed",
            body_lines=body_lines,
            footer_line="Press Q or Enter to exit",
            color_enabled=color_enabled,
        )
        return None, pre_cost_line or cost_line, False, False
    analysis, citations, recommendation, cost_line, stop_reason = result_holder.get("payload")  # type: ignore[misc]
    stop_reason = None
    if not cost_line and pre_cost_line:
        cost_line = pre_cost_line
    if rounds_left <= 0:
        if analysis:
            analysis = _rewrite_rec_line(analysis, [])
        recommendation = None
    recommendations = _normalize_recommendations(recommendation)
    if not recommendations:
        recommendation = None
    else:
        recommendation = recommendations
    stop_recommended = False

    comparison_lines: list[str] = []
    if user_goals and "minimize time to render" in user_goals:
        if baseline_elapsed is not None and last_elapsed is not None:
            comparison_lines.append(f"Speed (baseline): {baseline_elapsed:.1f}s → {last_elapsed:.1f}s")
        elif benchmark_elapsed is not None and last_elapsed is not None:
            comparison_lines.append(f"Speed: {benchmark_elapsed:.1f}s → {last_elapsed:.1f}s")
    if user_goals and "minimize cost of render" in user_goals:
        latest_cost = str(cost_line).replace("COST:", "").strip() if cost_line else None
        if baseline_cost_text and latest_cost:
            comparison_lines.append(f"Cost (baseline): {baseline_cost_text} → {latest_cost}")
        elif last_cost and latest_cost:
            comparison_lines.append(f"Cost: {last_cost} → {latest_cost}")
    if comparison_lines:
        side_by_side = "\n".join(comparison_lines)
        if emphasis_line:
            emphasis_line = f"{emphasis_line}\n{side_by_side}"
        else:
            emphasis_line = side_by_side

    detail_lines: list[object] = []
    receipt_payload: dict | None = None
    quality_baseline, quality_current = _quality_from_history(
        analysis_history or [],
        round_scores[1] if round_scores else None,
    )
    adherence_baseline, adherence_current = _adherence_from_history(
        analysis_history or [],
        round_scores[0] if round_scores else None,
    )
    retrieval_current = _load_retrieval_score(receipt_path)
    retrieval_baseline, retrieval_current = _retrieval_from_history(
        analysis_history or [],
        retrieval_current,
    )
    try:
        receipt_payload = _load_receipt_payload(receipt_path)
        detail_lines = _build_receipt_detail_lines(
            receipt_payload,
            recommendation,
            max_width=max(20, width - 2),
            return_tags=True,
            stop_reason=None,
        )
    except Exception as exc:
        detail_lines = _wrap_text(f"Render settings unavailable: {exc}", max(20, width - 2))
    if rounds_left <= 0:
        detail_lines.append("")
        detail_lines.append(("Max rounds reached; no further recommendations.", "goal"))

    lines: list[str] = []
    if user_goals:
        goals_text = ", ".join(user_goals)
        lines.append((f"User goals: {goals_text}", "goal"))
        lines.append("")
    lines.append((f"Rounds left: {rounds_left} (of {MAX_ROUNDS})", "goal"))
    lines.append("")
    lines.append("MODEL ANALYSIS (LLM)")
    lines.append("")
    if analysis:
        display_analysis = _display_analysis_text(analysis)
        lines.extend(_wrap_text(display_analysis, max(20, width - 2)))
    else:
        lines.append("Receipt analysis returned no content.")
    if detail_lines:
        lines.append("")
        lines.extend(detail_lines)
    if not recommendations:
        summary_settings = _settings_from_receipt(
            receipt_payload,
            fallback_provider=provider,
            fallback_model=model,
            fallback_size=size,
            fallback_n=n,
        )
        baseline_elapsed, baseline_cost_line = _baseline_metrics_from_history(analysis_history or [])
        lines.append("")
        lines.extend(
            _build_final_recommendation_lines(
                summary_settings,
                None,
                user_goals=user_goals,
                max_width=max(20, width - 2),
                return_tags=True,
                last_elapsed=last_elapsed,
                cost_line=cost_line,
                baseline_elapsed=baseline_elapsed,
                baseline_cost_line=baseline_cost_line,
                quality_baseline=quality_baseline,
                quality_current=quality_current,
                adherence_baseline=adherence_baseline,
                adherence_current=adherence_current,
                retrieval_baseline=retrieval_baseline,
                retrieval_current=retrieval_current,
                force_quality_metrics=bool(user_goals and "maximize quality of render" in user_goals),
            )
        )

    view_cmd: str | None = None
    run_dir = receipt_path.parent
    if _has_viewer_artifacts(run_dir):
        view_cmd = f"python scripts/param_forge.py view {run_dir}"
        lines.append("")
        lines.append(("Model Showdown viewer:", "section"))
        for line in _wrap_text(view_cmd, max(20, width - 2)):
            lines.append((line, "desc"))
    view_segment = "View model showdown (v) • " if view_cmd else ""

    rec_label = "recommendations" if recommendations and len(recommendations) > 1 else "recommendation"
    footer_line = (
        f"Accept {rec_label} (y) • {view_segment}Open receipt (o) • Export text (t) • Print text (p) • "
        "Quit (q) • Up/Down/PgUp/PgDn to scroll"
    )
    footer_attr = curses.color_pair(4) | curses.A_BOLD if color_enabled else curses.A_BOLD
    hotkeys = None
    accept_keys = None
    if allow_rerun and recommendations:
        hotkeys = {
            "y": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "q": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "o": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "t": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "p": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
        }
        if view_cmd:
            hotkeys["v"] = curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD
        accept_keys = {ord("y"), ord("Y")}
    else:
        hotkeys = {
            "o": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "t": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
            "p": curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD,
        }
        if view_cmd:
            hotkeys["v"] = curses.color_pair(1) | curses.A_BOLD if color_enabled else curses.A_BOLD
    open_keys = {ord("o"), ord("O")}
    action_keys = {
        ord("t"): "export",
        ord("T"): "export",
        ord("p"): "print",
        ord("P"): "print",
    }
    if view_cmd:
        action_keys.update({ord("v"): "view", ord("V"): "view"})
    while True:
        action = _render_scrollable_text_with_banner(
            stdscr,
            title_line="Receipt analysis",
            body_lines=lines,
            footer_line=(
                footer_line
                if accept_keys
                else f"{view_segment}Open receipt (o) • Export text (t) • Print text (p) • Up/Down/PgUp/PgDn to scroll, Q or Enter to exit"
            ),
            color_enabled=color_enabled,
            emphasis_line=emphasis_line,
            footer_attr=footer_attr,
            footer_hotkeys=hotkeys,
            accept_keys=accept_keys,
            open_keys=open_keys,
            action_keys=action_keys,
        )
        if action == "view":
            if view_cmd:
                _show_notice_curses(
                    stdscr,
                    "Model Showdown",
                    f"Run: {view_cmd}",
                    color_enabled=color_enabled,
                )
            continue
        if action == "export":
            export_lines: list[str] = []
            if user_goals:
                export_lines.append(f"User goals: {', '.join(user_goals)}")
                export_lines.append("")
            if analysis:
                export_lines.append("MODEL ANALYSIS (LLM)")
                export_lines.append("")
                export_lines.extend(_display_analysis_text(analysis).splitlines())
            else:
                export_lines.append("MODEL ANALYSIS (LLM)")
                export_lines.append("")
                export_lines.append("Receipt analysis returned no content.")
            if receipt_payload is not None:
                export_lines.append("")
                export_lines.extend(
                    [
                        line
                        for line in _build_receipt_detail_lines(
                            receipt_payload,
                            recommendation,
                            max_width=120,
                            stop_reason=None,
                        )
                        if isinstance(line, str)
                    ]
                )
            else:
                export_lines.append("")
                export_lines.extend([str(line) for line in lines])
            try:
                export_path = _export_analysis_text(receipt_path, export_lines)
                _open_path(export_path)
            except Exception:
                pass
            continue
        if action == "print":
            print_lines: list[str] = []
            if user_goals:
                print_lines.append(f"User goals: {', '.join(user_goals)}")
                print_lines.append("")
            print_lines.append("MODEL ANALYSIS (LLM)")
            print_lines.append("")
            if analysis:
                print_lines.extend(_display_analysis_text(analysis).splitlines())
            else:
                print_lines.append("Receipt analysis returned no content.")
            if receipt_payload is not None:
                print_lines.append("")
                for line in _build_receipt_detail_lines(
                    receipt_payload,
                    recommendation,
                    max_width=120,
                    stop_reason=stop_reason,
                ):
                    if isinstance(line, tuple):
                        print_lines.append(line[0])
                    else:
                        print_lines.append(line)
            _print_lines_to_console(stdscr, "Receipt analysis (copyable):", print_lines)
            continue
        if action == "open":
            _open_path(receipt_path)
            continue
        if allow_rerun and recommendations and action == "accept":
            return recommendations, cost_line, True, stop_recommended
        return recommendations, cost_line, False, stop_recommended


def _draw_choice_line(
    stdscr,
    y: int,
    label: str,
    choices: list[str],
    selected_idx: int,
    active: bool,
    current_step: int,
    step_index: int,
    highlight_pair: int,
    done_pair: int,
    color_enabled: bool,
) -> int:
    import curses
    height, width = stdscr.getmaxyx()
    if y >= height - 1:
        return y
    width = max(1, width - 1)
    is_done = step_index < current_step
    label_attr = curses.A_BOLD if active else (curses.A_NORMAL if is_done else curses.A_DIM)
    prefix = "-> " if active else ("✓  " if is_done else "   ")
    try:
        stdscr.addstr(y, 0, f"{prefix}{label}:"[:width], label_attr)
    except curses.error:
        return y + 1
    y += 1
    indices, prefix, suffix = _visible_indices(choices, selected_idx, width, bracket_selected=active)
    x = 4
    if prefix:
        try:
            stdscr.addstr(y, x, "… ")
        except curses.error:
            return y + 2
        x += 2
    for idx, choice_idx in enumerate(indices):
        token = choices[choice_idx]
        if choice_idx == selected_idx:
            if active:
                token = f"[{token}]"
                if color_enabled and highlight_pair:
                    attr = curses.color_pair(highlight_pair) | curses.A_BOLD
                else:
                    attr = curses.A_REVERSE
            elif is_done:
                if color_enabled and done_pair:
                    attr = curses.color_pair(done_pair) | curses.A_BOLD
                else:
                    attr = curses.A_BOLD
            else:
                attr = curses.A_DIM
        else:
            attr = curses.A_DIM
        if y >= height - 1 or x >= width - 1:
            break
        try:
            stdscr.addstr(y, x, token[: max(0, width - x - 1)], attr)
        except curses.error:
            break
        x += len(token)
        if idx < len(indices) - 1:
            if x < width - 1:
                try:
                    stdscr.addstr(y, x, " | "[: max(0, width - x - 1)])
                except curses.error:
                    pass
            x += 3
    if suffix and x < width - 1:
        try:
            stdscr.addstr(y, x, " …")
        except curses.error:
            pass
    return y + 2


def _draw_choice_column(
    stdscr,
    y: int,
    label: str,
    choices: list[str],
    selected_idx: int,
    active: bool,
    current_step: int,
    step_index: int,
    highlight_pair: int,
    done_pair: int,
    color_enabled: bool,
    max_visible: int = 6,
) -> int:
    import curses
    height, width = stdscr.getmaxyx()
    if y >= height - 1:
        return y
    width = max(1, width - 1)
    is_done = step_index < current_step
    label_attr = curses.A_BOLD if active else (curses.A_NORMAL if is_done else curses.A_DIM)
    prefix = "-> " if active else ("✓  " if is_done else "   ")
    try:
        stdscr.addstr(y, 0, f"{prefix}{label}:"[:width], label_attr)
    except curses.error:
        return y + 1
    y += 1

    available = max(1, min(max_visible, height - y - 1))
    total = len(choices)
    if total == 0:
        return y + 1
    start = max(0, min(total - available, selected_idx - available // 2))
    end = min(total, start + available)

    for idx in range(start, end):
        token = choices[idx]
        if idx == selected_idx:
            if active:
                token = f"[{token}]"
                if color_enabled and highlight_pair:
                    attr = curses.color_pair(highlight_pair) | curses.A_BOLD
                else:
                    attr = curses.A_REVERSE
            elif is_done:
                if color_enabled and done_pair:
                    attr = curses.color_pair(done_pair) | curses.A_BOLD
                else:
                    attr = curses.A_BOLD
            else:
                attr = curses.A_DIM
        else:
            attr = curses.A_DIM
        if y >= height - 1:
            break
        _safe_addstr(stdscr, y, 4, token[: max(0, width - 5)], attr)
        y += 1

    return y + 1


def _draw_count_line(
    stdscr,
    y: int,
    label: str,
    value: int,
    active: bool,
    current_step: int,
    step_index: int,
    highlight_pair: int,
    done_pair: int,
    color_enabled: bool,
) -> int:
    import curses
    height, width = stdscr.getmaxyx()
    if y >= height - 1:
        return y
    is_done = step_index < current_step
    label_attr = curses.A_BOLD if active else (curses.A_NORMAL if is_done else curses.A_DIM)
    prefix = "-> " if active else ("✓  " if is_done else "   ")
    try:
        stdscr.addstr(y, 0, f"{prefix}{label}:"[: width - 1], label_attr)
    except curses.error:
        return y + 1
    y += 1
    token = f"[{value}]" if active else str(value)
    if active:
        if color_enabled and highlight_pair:
            attr = curses.color_pair(highlight_pair) | curses.A_BOLD
        else:
            attr = curses.A_REVERSE
    elif is_done:
        if color_enabled and done_pair:
            attr = curses.color_pair(done_pair) | curses.A_BOLD
        else:
            attr = curses.A_BOLD
    else:
        attr = curses.A_DIM
    if y < height - 1:
        try:
            stdscr.addstr(y, 4, token[: max(0, width - 5)], attr)
        except curses.error:
            pass
    return y + 2


def _draw_prompt_line(
    stdscr,
    y: int,
    label: str,
    prompt_text: str,
    default_prompt: str,
    active: bool,
    current_step: int,
    step_index: int,
    highlight_pair: int,
    done_pair: int,
    color_enabled: bool,
    hint_text: str | None = None,
) -> int:
    import curses
    height, width = stdscr.getmaxyx()
    if y >= height - 1:
        return y
    is_done = step_index < current_step
    label_attr = curses.A_BOLD if active else (curses.A_NORMAL if is_done else curses.A_DIM)
    prefix = "-> " if active else ("✓  " if is_done else "   ")
    try:
        stdscr.addstr(y, 0, f"{prefix}{label}:"[: width - 1], label_attr)
    except curses.error:
        return y + 1
    y += 1
    display = prompt_text.strip() if prompt_text else ""
    if display and default_prompt and display == default_prompt.strip():
        display = "(default prompt)"
    if not display:
        display = "(default prompt)"
    token = _truncate_text(display, max(1, width - 5))
    if active:
        if color_enabled and highlight_pair:
            attr = curses.color_pair(highlight_pair) | curses.A_BOLD
        else:
            attr = curses.A_REVERSE
    elif is_done:
        if color_enabled and done_pair:
            attr = curses.color_pair(done_pair) | curses.A_BOLD
        else:
            attr = curses.A_BOLD
    else:
        attr = curses.A_DIM
    _safe_addstr(stdscr, y, 4, token, attr)
    y += 1
    if hint_text and active:
        _safe_addstr(
            stdscr,
            y,
            4,
            _truncate_text(hint_text, max(1, width - 5)),
            curses.A_DIM,
        )
        y += 1
    return y + 1


def _visible_indices(
    choices: list[str],
    selected_idx: int,
    max_width: int,
    *,
    bracket_selected: bool = True,
) -> tuple[list[int], bool, bool]:
    def line_len(indices: list[int], prefix: bool, suffix: bool) -> int:
        tokens = []
        for i in indices:
            if i == selected_idx and bracket_selected:
                tokens.append(f"[{choices[i]}]")
            else:
                tokens.append(choices[i])
        line = "  " + " | ".join(tokens)
        if prefix:
            line = "… " + line
        if suffix:
            line = line + " …"
        return len(line)

    indices = [selected_idx]
    left = selected_idx - 1
    right = selected_idx + 1
    while True:
        grew = False
        if left >= 0 and line_len([left] + indices, True, right < len(choices)) <= max_width:
            indices = [left] + indices
            left -= 1
            grew = True
        if right < len(choices) and line_len(indices + [right], left >= 0, True) <= max_width:
            indices = indices + [right]
            right += 1
            grew = True
        if not grew:
            break
    prefix = indices[0] > 0
    suffix = indices[-1] < len(choices) - 1
    while line_len(indices, prefix, suffix) > max_width and len(indices) > 1:
        if selected_idx - indices[0] > indices[-1] - selected_idx:
            indices = indices[1:]
        else:
            indices = indices[:-1]
        prefix = indices[0] > 0
        suffix = indices[-1] < len(choices) - 1
    return indices, prefix, suffix


def _format_choices_line(choices: list[str], idx: int, max_width: int, color: bool) -> str:
    sel_start = "\x00SEL\x00"
    sel_end = "\x00END\x00"

    def token(i: int) -> str:
        if i == idx:
            return f"{sel_start}[{choices[i]}]{sel_end}"
        return choices[i]

    def line_for(indices: list[int]) -> str:
        return "  " + " | ".join(token(i) for i in indices)

    def visible_len(text: str) -> int:
        return len(text.replace(sel_start, "").replace(sel_end, ""))

    indices = [idx]
    left = idx - 1
    right = idx + 1
    while True:
        grew = False
        if left >= 0:
            candidate = [left] + indices
            if visible_len(line_for(candidate)) <= max_width:
                indices = candidate
                left -= 1
                grew = True
        if right < len(choices):
            candidate = indices + [right]
            if visible_len(line_for(candidate)) <= max_width:
                indices = candidate
                right += 1
                grew = True
        if not grew:
            break

    prefix = "… " if indices[0] > 0 else ""
    suffix = " …" if indices[-1] < len(choices) - 1 else ""
    rendered = line_for(indices)
    line = f"{prefix}{rendered}{suffix}"
    while visible_len(line) > max_width and len(indices) > 1:
        if idx - indices[0] > indices[-1] - idx:
            indices = indices[1:]
        else:
            indices = indices[:-1]
        rendered = line_for(indices)
        prefix = "… " if indices[0] > 0 else ""
        suffix = " …" if indices[-1] < len(choices) - 1 else ""
        line = f"{prefix}{rendered}{suffix}"
    if color and _supports_color():
        line = line.replace(sel_start, "\033[1;36m").replace(sel_end, "\033[0m")
    else:
        line = line.replace(sel_start, "").replace(sel_end, "")
    return line


class _Spinner:
    def __init__(self, message: str, interval: float = 0.1, show_elapsed: bool = False) -> None:
        self.message = message
        self.interval = interval
        self.show_elapsed = show_elapsed
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._start: float | None = None

    def start(self) -> None:
        if sys.stdout.isatty():
            self._start = time.monotonic()
            self._thread.start()

    def stop(self) -> None:
        if not sys.stdout.isatty():
            return
        self._stop.set()
        self._thread.join(timeout=1.0)
        sys.stdout.write("\r" + " " * (len(self.message) + 4) + "\r")
        sys.stdout.flush()

    def _run(self) -> None:
        frames = ["|", "/", "-", "\\"]
        index = 0
        while not self._stop.is_set():
            frame = frames[index % len(frames)]
            line = f"\r{self.message} {frame}"
            if self.show_elapsed and self._start is not None:
                elapsed = time.monotonic() - self._start
                line = f"{line}  {elapsed:5.1f}s"
            sys.stdout.write(line)
            sys.stdout.flush()
            time.sleep(self.interval)
            index += 1


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _write_env_key(dotenv_path: Path, key: str, value: str) -> None:
    if not dotenv_path.parent.exists():
        dotenv_path.parent.mkdir(parents=True, exist_ok=True)
    lines: list[str] = []
    if dotenv_path.exists():
        lines = dotenv_path.read_text(encoding="utf-8").splitlines()
    escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    new_line = f'{key}="{escaped}"'
    replaced = False
    for idx, line in enumerate(lines):
        if line.strip().startswith(f"{key}="):
            lines[idx] = new_line
            replaced = True
            break
    if not replaced:
        lines.append(new_line)
    dotenv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(dotenv_path, 0o600)
    except Exception:
        pass


def _prompt_for_key(key: str, dotenv_path: Path | None) -> bool:
    choice = input(f"Set {key} now? [y/N]: ").strip().lower()
    if choice not in {"y", "yes"}:
        return False
    value = getpass.getpass(f"Enter {key}: ").strip()
    if not value:
        return False
    if dotenv_path is None:
        dotenv_path = _repo_root() / ".env"
    save = input(f"Save to {dotenv_path}? [Y/n]: ").strip().lower()
    if save in {"", "y", "yes"}:
        _write_env_key(dotenv_path, key, value)
        print(f"Saved {key} to {dotenv_path}.")
    else:
        print(f"export {key}=\"{value}\"")
    os.environ[key] = value
    return True


def _prompt_for_key_curses(stdscr, key: str, dotenv_path: Path | None) -> bool:
    try:
        import curses
    except Exception:
        return _prompt_for_key(key, dotenv_path)
    try:
        try:
            curses.def_prog_mode()
            curses.endwin()
        except Exception:
            pass
        return _prompt_for_key(key, dotenv_path)
    finally:
        try:
            curses.reset_prog_mode()
            curses.curs_set(0)
            stdscr.clear()
            stdscr.refresh()
        except Exception:
            pass


def _provider_key_hint(provider: str) -> str:
    provider_key = provider.strip().lower()
    if provider_key == "openai":
        return "OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP)"
    if provider_key == "gemini":
        return "GEMINI_API_KEY (or GOOGLE_API_KEY)"
    if provider_key == "flux":
        return "BFL_API_KEY (or FLUX_API_KEY)"
    if provider_key == "imagen":
        return "GOOGLE_API_KEY (or Vertex credentials like GOOGLE_APPLICATION_CREDENTIALS)"
    return "the required API key"


def _ensure_api_keys(
    provider: str, dotenv_path: Path | None, allow_prompt: bool = True, prompt_func=None
) -> None:
    if prompt_func is None:
        prompt_func = _prompt_for_key
    provider = provider.strip().lower()
    if provider == "openai":
        if os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP"):
            return
        if not allow_prompt:
            raise RuntimeError("OPENAI_API_KEY is required for OpenAI provider.")
        if not prompt_func("OPENAI_API_KEY", dotenv_path):
            raise RuntimeError("OPENAI_API_KEY is required for OpenAI provider.")
        return
    if provider == "gemini":
        if os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"):
            return
        if not allow_prompt:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for Gemini provider.")
        if not prompt_func("GEMINI_API_KEY", dotenv_path):
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for Gemini provider.")
        return
    if provider == "flux":
        if os.getenv("BFL_API_KEY") or os.getenv("FLUX_API_KEY"):
            return
        if not allow_prompt:
            raise RuntimeError("BFL_API_KEY (or FLUX_API_KEY) is required for Flux provider.")
        if not prompt_func("BFL_API_KEY", dotenv_path):
            raise RuntimeError("BFL_API_KEY (or FLUX_API_KEY) is required for Flux provider.")
        return
    if provider == "imagen":
        vertex_present = bool(
            os.getenv("IMAGEN_VERTEX_PROJECT")
            or os.getenv("IMAGEN_VERTEX_SERVICE_ACCOUNT_FILE")
            or os.getenv("IMAGEN_VERTEX_SERVICE_ACCOUNT_JSON")
            or os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        )
        if vertex_present:
            return
        if os.getenv("GOOGLE_API_KEY"):
            return
        if not allow_prompt:
            raise RuntimeError(
                "GOOGLE_API_KEY (or Vertex credentials) is required for Imagen provider."
            )
        if not prompt_func("GOOGLE_API_KEY", dotenv_path):
            raise RuntimeError(
                "GOOGLE_API_KEY (or Vertex credentials) is required for Imagen provider."
            )
        return


def _extract_anthropic_text(payload: dict) -> str:
    content = payload.get("content")
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text":
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "\n".join(parts).strip()
    if isinstance(content, dict) and content.get("type") == "text":
        text = content.get("text")
        if isinstance(text, str):
            return text.strip()
    return ""


def _extract_anthropic_text_with_citations(payload: dict) -> tuple[str, list[dict[str, str]]]:
    content = payload.get("content")
    if not isinstance(content, list):
        text = _extract_anthropic_text(payload)
        return text, []
    lines: list[str] = []
    citations: list[dict[str, str]] = []
    citation_index: dict[tuple[str, str], int] = {}
    for item in content:
        if not isinstance(item, dict) or item.get("type") != "text":
            continue
        text = item.get("text")
        if not isinstance(text, str):
            continue
        markers: list[str] = []
        raw_citations = item.get("citations")
        if isinstance(raw_citations, list):
            for citation in raw_citations:
                if not isinstance(citation, dict):
                    continue
                url = citation.get("url")
                title = citation.get("title") or url or "Source"
                if not isinstance(url, str) or not url:
                    continue
                key = (url, str(title))
                if key not in citation_index:
                    citation_index[key] = len(citations) + 1
                    citations.append(
                        {
                            "index": str(citation_index[key]),
                            "title": str(title),
                            "url": url,
                        }
                    )
                markers.append(f"[{citation_index[key]}]")
        suffix = f" {' '.join(markers)}" if markers else ""
        lines.append(f"{text}{suffix}".strip())
    return "\n".join(lines).strip(), citations


def _call_anthropic(
    prompt: str,
    *,
    model: str = ANTHROPIC_MODEL,
    max_tokens: int = ANTHROPIC_MAX_TOKENS,
    enable_web_search: bool = True,
    enable_thinking: bool = True,
    image_base64: str | None = None,
    image_mime: str | None = None,
) -> tuple[str, list[dict[str, str]]]:
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY is required to analyze receipts.")
    content_blocks: list[dict[str, object]] = [{"type": "text", "text": prompt}]
    if image_base64 and image_mime:
        content_blocks.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": image_mime, "data": image_base64},
            }
        )
    body: dict[str, object] = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": [
            {
                "role": "user",
                "content": content_blocks,
            }
        ],
    }
    if enable_thinking:
        if max_tokens > ANTHROPIC_THINKING_BUDGET and ANTHROPIC_THINKING_BUDGET >= 1024:
            body["thinking"] = {
                "type": "enabled",
                "budget_tokens": ANTHROPIC_THINKING_BUDGET,
            }
    if enable_web_search:
        body["tools"] = [
            {
                "type": "web_search_20250305",
                "name": "web_search",
                "max_uses": 5,
            }
        ]
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        ANTHROPIC_ENDPOINT,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Anthropic request failed ({exc.code}): {raw}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Anthropic request failed: {exc.reason}") from exc
    payload = json.loads(raw)
    if isinstance(payload, dict) and payload.get("error"):
        message = payload.get("error", {}).get("message", raw)
        raise RuntimeError(f"Anthropic request failed: {message}")
    if isinstance(payload, dict):
        text, citations = _extract_anthropic_text_with_citations(payload)
        if text:
            return text, citations
    return str(payload).strip(), []


def _extract_openai_text(payload: dict) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"].strip()
    output = payload.get("output")
    if isinstance(output, list):
        parts: list[str] = []
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    text = block.get("text") or block.get("output_text")
                    if isinstance(text, str):
                        parts.append(text)
            elif isinstance(content, str):
                parts.append(content)
        if parts:
            return "\n".join(parts).strip()
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message")
        if isinstance(message, dict):
            content = message.get("content")
            if isinstance(content, str):
                return content.strip()
            if isinstance(content, list):
                parts = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    text = block.get("text")
                    if isinstance(text, str):
                        parts.append(text)
                if parts:
                    return "\n".join(parts).strip()
    return ""


def _extract_gemini_text(payload: dict) -> str:
    candidates = payload.get("candidates")
    if isinstance(candidates, list):
        for candidate in candidates:
            content = candidate.get("content") if isinstance(candidate, dict) else None
            if isinstance(content, dict):
                parts = content.get("parts")
                if isinstance(parts, list):
                    for part in parts:
                        if isinstance(part, dict):
                            text = part.get("text")
                            if isinstance(text, str) and text.strip():
                                return text.strip()
    output = payload.get("text")
    if isinstance(output, str):
        return output.strip()
    return ""


def _openai_request(
    url: str,
    *,
    body: dict[str, object],
    api_key: str,
) -> tuple[dict | None, int | None, str | None]:
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="ignore")
        message = raw
        try:
            payload = json.loads(raw)
            if isinstance(payload, dict) and payload.get("error"):
                message = str(payload.get("error", {}).get("message", raw))
        except Exception:
            pass
        return None, exc.code, message
    except urllib.error.URLError as exc:
        raise RuntimeError(f"OpenAI request failed: {exc.reason}") from exc
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"OpenAI response parse failed: {exc}") from exc
    if isinstance(payload, dict) and payload.get("error"):
        message = str(payload.get("error", {}).get("message", raw))
        return None, None, message
    return payload, None, None


def _is_openai_endpoint_error(code: int | None, message: str | None) -> bool:
    if code == 404:
        return True
    if not message:
        return False
    lowered = message.lower()
    return "not found" in lowered or "unknown endpoint" in lowered or "unknown url" in lowered


def _is_openai_image_error(message: str | None) -> bool:
    if not message:
        return False
    lowered = message.lower()
    return (
        "image" in lowered
        and (
            "not supported" in lowered
            or "unsupported" in lowered
            or "invalid" in lowered
            or "vision" in lowered
            or "does not support" in lowered
        )
    )


def _call_openai(
    prompt: str,
    *,
    model: str = OPENAI_ANALYZER_MODEL,
    max_output_tokens: int = OPENAI_MAX_OUTPUT_TOKENS,
    image_base64: str | None = None,
    image_mime: str | None = None,
    enable_web_search: bool = False,
) -> tuple[str, list[dict[str, str]]]:
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY is required to analyze receipts.")
    include_image = bool(image_base64 and image_mime)

    def _responses_body(with_image: bool) -> dict[str, object]:
        content: list[dict[str, object]] = [{"type": "input_text", "text": prompt}]
        if with_image and image_base64 and image_mime:
            content.append(
                {
                    "type": "input_image",
                    "image_url": f"data:{image_mime};base64,{image_base64}",
                }
            )
        body: dict[str, object] = {
            "model": model,
            "input": [{"role": "user", "content": content}],
            "max_output_tokens": max_output_tokens,
        }
        if enable_web_search:
            body["tools"] = [{"type": "web_search"}]
        return body

    def _chat_body(with_image: bool) -> dict[str, object]:
        content: list[dict[str, object]] = [{"type": "text", "text": prompt}]
        if with_image and image_base64 and image_mime:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:{image_mime};base64,{image_base64}"},
                }
            )
        body: dict[str, object] = {
            "model": model,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": max_output_tokens,
        }
        return body

    def _attempt(url: str, body: dict[str, object]) -> tuple[str | None, int | None, str | None]:
        payload, code, message = _openai_request(url, body=body, api_key=api_key)
        if payload is not None:
            if isinstance(payload, dict):
                text = _extract_openai_text(payload)
                if text:
                    return text, None, None
            return str(payload).strip(), None, None
        return None, code, message

    text, code, message = _attempt(OPENAI_RESPONSES_ENDPOINT, _responses_body(include_image))
    if text is not None:
        return text, []
    if include_image and _is_openai_image_error(message):
        text, code, message = _attempt(OPENAI_RESPONSES_ENDPOINT, _responses_body(False))
        if text is not None:
            return text, []
    if _is_openai_endpoint_error(code, message):
        if enable_web_search:
            detail = message or "unknown error"
            code_label = f" ({code})" if code else ""
            raise RuntimeError(f"OpenAI request failed{code_label}: {detail}")
        text, code, message = _attempt(OPENAI_CHAT_ENDPOINT, _chat_body(include_image))
        if text is not None:
            return text, []
        if include_image and _is_openai_image_error(message):
            text, code, message = _attempt(OPENAI_CHAT_ENDPOINT, _chat_body(False))
            if text is not None:
                return text, []
    detail = message or "unknown error"
    code_label = f" ({code})" if code else ""
    raise RuntimeError(f"OpenAI request failed{code_label}: {detail}")


def _call_gemini(
    prompt: str,
    *,
    model: str = GEMINI_ANALYZER_MODEL,
    image_base64: str | None = None,
    image_mime: str | None = None,
    enable_web_search: bool = False,
) -> tuple[str, list[dict[str, str]]]:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required to analyze receipts with Gemini.")
    parts: list[dict[str, object]] = [{"text": prompt}]
    if image_base64 and image_mime:
        parts.append(
            {
                "inline_data": {
                    "mime_type": image_mime,
                    "data": image_base64,
                }
            }
        )
    body = {
        "contents": [{"role": "user", "parts": parts}],
        "generationConfig": {"responseMimeType": "text/plain"},
    }
    if enable_web_search:
        body["tools"] = [{"google_search": {}}]
    endpoint = f"{GEMINI_ENDPOINT}/models/{model}:generateContent?key={api_key}"
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini request failed ({exc.code}): {raw}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Gemini request failed: {exc.reason}") from exc
    try:
        payload = json.loads(raw)
    except Exception as exc:
        raise RuntimeError(f"Gemini response parse failed: {exc}") from exc
    if isinstance(payload, dict) and payload.get("error"):
        message = payload.get("error", {}).get("message", raw)
        raise RuntimeError(f"Gemini request failed: {message}")
    if isinstance(payload, dict):
        text = _extract_gemini_text(payload)
        if text:
            return text, []
    return str(payload).strip(), []


def _call_council(
    prompt: str,
    *,
    enable_web_search: bool = True,
    image_base64: str | None = None,
    image_mime: str | None = None,
    fallback_prompt: str | None = None,
    chair_instructions: list[str] | None = None,
) -> tuple[str, list[dict[str, str]]]:
    opinions: list[tuple[str, str]] = []
    errors: list[str] = []
    lock = threading.Lock()
    ready = threading.Event()
    completed = 0
    total = 3
    quorum = 2

    def _mark_done() -> None:
        nonlocal completed
        completed += 1
        if len(opinions) >= quorum or completed >= total:
            ready.set()

    def _record_success(label: str, text: str | None) -> None:
        with lock:
            if text:
                opinions.append((label, text))
            else:
                errors.append(f"{label} returned empty response.")
            _mark_done()

    def _record_error(label: str, exc: Exception) -> None:
        with lock:
            errors.append(f"{label} failed: {exc}")
            _mark_done()

    def _run_openai() -> None:
        try:
            text, _ = _call_openai(
                prompt,
                image_base64=image_base64,
                image_mime=image_mime,
                enable_web_search=enable_web_search,
            )
            _record_success("OpenAI GPT-5.2 analyst", text)
        except Exception as exc:
            _record_error("OpenAI analyst", exc)

    def _run_anthropic() -> None:
        try:
            text, _ = _call_anthropic(
                prompt,
                enable_web_search=enable_web_search,
                image_base64=image_base64,
                image_mime=image_mime,
            )
            _record_success("Claude Opus 4.5 analyst", text)
        except Exception as exc:
            _record_error("Claude analyst", exc)

    def _run_gemini() -> None:
        try:
            text, _ = _call_gemini(
                prompt,
                image_base64=image_base64,
                image_mime=image_mime,
                enable_web_search=enable_web_search,
            )
            _record_success("Gemini 3 Pro analyst", text)
        except Exception as exc:
            _record_error("Gemini analyst", exc)

    threads = [
        threading.Thread(target=_run_openai, daemon=True),
        threading.Thread(target=_run_anthropic, daemon=True),
        threading.Thread(target=_run_gemini, daemon=True),
    ]
    for thread in threads:
        thread.start()

    ready.wait()
    with lock:
        opinions_snapshot = list(opinions)
        errors_snapshot = list(errors)

    if chair_instructions is None:
        chair_instructions = [
            "You are the council chair. Synthesize the best final response.",
            "Follow the original instructions EXACTLY: output ONLY the final response in the required 4-line format plus <setting_json>.",
            "Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals.",
            "Avoid tiny deltas (e.g., steps 20→30) unless they unlock a major improvement.",
            "Honor the user goals.",
    ]
    council_sections: list[str] = [
        *chair_instructions,
        "",
        "Original task:",
        prompt,
    ]
    if opinions_snapshot:
        council_sections.append("")
        council_sections.append("Council feedback:")
        for name, text in opinions_snapshot:
            council_sections.append(f"{name}:\n{text}")
    if errors_snapshot:
        council_sections.append("")
        council_sections.append("Notes:")
        council_sections.extend(errors_snapshot)

    chair_prompt = "\n".join(council_sections).strip()
    try:
        text, _ = _call_openai(
            chair_prompt,
            image_base64=image_base64,
            image_mime=image_mime,
            enable_web_search=enable_web_search,
        )
        return text, []
    except Exception:
        # Fall back to the best available opinion.
        if opinions_snapshot:
            return opinions_snapshot[0][1], []
        raise


def _is_anthropic_rate_limit_error(exc: Exception) -> bool:
    lowered = str(exc).lower()
    return (
        "rate limit" in lowered
        or "rate_limit" in lowered
        or "too many requests" in lowered
        or "429" in lowered
        or "overloaded" in lowered
    )


def _is_anthropic_image_size_error(exc: Exception) -> bool:
    lowered = str(exc).lower()
    if "image" not in lowered:
        return False
    size_hits = (
        "size" in lowered
        or "too large" in lowered
        or "exceed" in lowered
        or "maximum" in lowered
        or "max_image" in lowered
    )
    if not size_hits:
        return False
    return "5mb" in lowered or "5 mb" in lowered or "image" in lowered


def _call_analyzer(
    prompt: str,
    *,
    analyzer: str | None = None,
    enable_web_search: bool = True,
    image_base64: str | None = None,
    image_mime: str | None = None,
    fallback_prompt: str | None = None,
) -> tuple[str, list[dict[str, str]]]:
    analyzer_key = _normalize_analyzer(analyzer)
    if analyzer_key == "openai":
        return _call_openai(
            prompt,
            image_base64=image_base64,
            image_mime=image_mime,
        )
    if analyzer_key == "council":
        return _call_council(
            prompt,
            enable_web_search=enable_web_search,
            image_base64=image_base64,
            image_mime=image_mime,
            fallback_prompt=fallback_prompt,
        )
    try:
        return _call_anthropic(
            prompt,
            enable_web_search=enable_web_search,
            image_base64=image_base64,
            image_mime=image_mime,
        )
    except Exception as exc:
        if _is_anthropic_rate_limit_error(exc) or _is_anthropic_image_size_error(exc):
            openai_prompt = fallback_prompt or prompt
            return _call_openai(
                openai_prompt,
                image_base64=image_base64,
                image_mime=image_mime,
            )
        raise


def _load_receipt_payload(receipt_path: Path) -> dict:
    try:
        return json.loads(receipt_path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(f"failed to read {receipt_path} ({exc})") from exc


def _guess_mime_from_suffix(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".png"}:
        return "image/png"
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix in {".webp"}:
        return "image/webp"
    if suffix in {".gif"}:
        return "image/gif"
    return "image/png"


def _detect_mime(data: bytes, fallback: str) -> str:
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return fallback


def _load_image_for_analyzer(image_path: Path) -> tuple[str, str]:
    data = image_path.read_bytes()
    mime = _detect_mime(data, _guess_mime_from_suffix(image_path))
    encoded = base64.b64encode(data).decode("ascii")
    return encoded, mime


def _build_receipt_analysis_prompt(
    *,
    receipt: dict,
    explicit_fields: dict[str, object],
    target_prompt: str,
    allowed_settings: list[str],
    user_goals: list[str] | None,
    user_notes: str | None,
    history_text: str | None = None,
    local_history_text: str | None = None,
    model_options_line: str | None = None,
    enable_web_search: bool = True,
    current_round: int = 1,
    max_rounds: int = MAX_ROUNDS,
) -> str:
    top_level_candidates = ("size", "n", "seed", "output_format", "background", "model")
    top_level_allowed = [key for key in top_level_candidates if key in allowed_settings]
    top_level_hint = ", ".join(top_level_allowed) if top_level_allowed else "size, n, seed, output_format, model"
    explicit_lines = "\n".join(f"- {key}: {value}" for key, value in explicit_fields.items())
    allowed_line = ", ".join(allowed_settings) if allowed_settings else "(none)"
    goals_line = ", ".join(user_goals) if user_goals else "(not specified)"
    notes_line = user_notes.strip() if user_notes else ""
    history_block = ""
    if history_text:
        history_block = f"Session history (previous rounds):\n{history_text}\n\n"
    if local_history_text:
        history_block = f"{history_block}Local history (previous sessions):\n{local_history_text}\n\n"
    model_block = ""
    if model_options_line:
        model_block = f"{model_options_line}\n"
    summary = {
        "request": receipt.get("request"),
        "resolved": receipt.get("resolved"),
        "provider_request": receipt.get("provider_request"),
        "warnings": receipt.get("warnings"),
        "result_metadata": receipt.get("result_metadata"),
    }
    summary_json = json.dumps(summary, indent=2, ensure_ascii=True)
    web_search_text = ""
    if enable_web_search:
        web_search_text = (
            "Use the web_search tool to find model/provider settings and pricing that best achieve the user's goals. "
            "Base recommendations and cost estimate on documented settings for the selected provider/model. "
        )
    provider_hint = explicit_fields.get("provider")
    provider_key, _ = _normalize_provider_and_model(str(provider_hint), None) if provider_hint else ("", None)
    call_path_text = ""
    if provider_key == "openai":
        call_path_text = (
            "For OpenAI gpt-image models, you may recommend use_responses=true/false to switch between "
            "the direct gpt-image endpoint and the Responses API. "
        )
    remaining_rounds = max(0, max_rounds - current_round)
    return (
        "Simulate many runs of this prompt given the image attached with bleeding-edge vision analysis. "
        "Respond with EXACTLY four lines labeled ADH, UNSET, COST, REC, then a <setting_json> block. "
        "No tables, no markdown, no bullet points. "
        "ADH: brief prompt adherence summary (1 sentence), comparing the image to the prompt as written.\n"
        "UNSET: list 2–4 most important unset params, given the user's selected goals.\n"
        "COST: estimated USD cost per 1K images for this provider/model (short).\n"
        "REC: 1–3 unconventional recommendations aligned to user goals. "
        "If speed is a priority, you may suggest unconventional levers (e.g., output format/filetype, "
        "compression, or size tradeoffs) in addition to standard settings. "
        "Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals "
        "(avoid tiny deltas like steps 20→30); think big and unconventional when it helps meet the goals.\n"
        f"You have at most {max_rounds} total rounds. This is round {current_round}; "
        f"{remaining_rounds} round(s) remain after this. "
        "Plan a coherent testing path and avoid flip-flopping settings (e.g., jpeg→png→jpeg) unless there's a strong reason.\n\n"
        f"Target prompt:\n{target_prompt}\n\n"
        f"Explicitly set in the flow:\n{explicit_lines}\n\n"
        f"User goals (multi-select): {goals_line}\n"
        "If the user selected 'maximize quality of render', treat this as an optimization problem: "
        "prioritize maximizing prompt adherence and LLM-rated image quality, even if it increases cost/time. "
        "However, if the user also selected 'minimize cost of render' or 'minimize time to render', "
        "those goals take precedence and quality becomes secondary.\n"
        "If the user selected 'maximize LLM retrieval score', prioritize legibility, captionability, "
        "and retrieval-focused clarity even if aesthetic quality softens, unless cost/time goals are selected.\n"
        f"User notes: {notes_line or '(none)'}\n\n"
        f"{web_search_text}"
        f"{call_path_text}"
        f"{history_block}"
        f"{model_block}"
        f"Allowed settings for recommendations (API settings for this model): {allowed_line}\n"
        "Do NOT recommend or list settings outside the allowed list.\n"
        "Model changes must stay within the same provider and use the listed model options.\n"
        "Use setting_target='provider_options' for provider-specific options, "
        f"and setting_target='request' for top-level settings like {top_level_hint}.\n\n"
        "At the end, output a JSON array (max 3 items) wrapped in <setting_json>...</setting_json> "
        "with objects that include keys: setting_name, setting_value, setting_target, rationale. "
        "If no safe recommendation, output an empty array.\n\n"
        "Receipt summary JSON:\n"
        f"{summary_json}"
    )


def _build_recommendation_only_prompt(
    *,
    summary_json: str,
    allowed_settings: list[str],
    provider: str,
    model: str | None,
    user_goals: list[str] | None,
    user_notes: str | None,
    history_text: str | None = None,
    local_history_text: str | None = None,
    model_options_line: str | None = None,
    enable_web_search: bool = True,
    current_round: int = 1,
    max_rounds: int = MAX_ROUNDS,
) -> str:
    top_level_candidates = ("size", "n", "seed", "output_format", "background", "model")
    top_level_allowed = [key for key in top_level_candidates if key in allowed_settings]
    top_level_hint = ", ".join(top_level_allowed) if top_level_allowed else "size, n, seed, output_format, model"
    allowed_line = ", ".join(allowed_settings) if allowed_settings else "(none)"
    model_label = model or "(default)"
    goals_line = ", ".join(user_goals) if user_goals else "(not specified)"
    notes_line = user_notes.strip() if user_notes else ""
    history_block = ""
    if history_text:
        history_block = f"Session history (previous rounds):\n{history_text}\n"
    if local_history_text:
        history_block = f"{history_block}Local history (previous sessions):\n{local_history_text}\n"
    model_block = ""
    if model_options_line:
        model_block = f"{model_options_line}\n"
    web_search_text = ""
    if enable_web_search:
        web_search_text = (
            "Use the web_search tool to find model/provider settings that best achieve the user's goals. "
            "Base recommendations on documented settings for the selected provider/model.\n"
        )
    provider_key, _ = _normalize_provider_and_model(str(provider), model)
    call_path_text = ""
    if provider_key == "openai":
        call_path_text = (
            "For OpenAI gpt-image models, you may recommend use_responses=true/false to switch between "
            "the direct gpt-image endpoint and the Responses API.\n"
        )
    remaining_rounds = max(0, max_rounds - current_round)
    return (
        "Simulate many runs of this prompt given the image attached with bleeding-edge vision analysis. "
        "Based on the receipt summary, recommend 1–3 API setting changes to improve prompt adherence. "
        "Only choose from the allowed settings list. "
        "Output ONLY a JSON array wrapped in <setting_json>...</setting_json> with objects that include keys: "
        "setting_name, setting_value, setting_target, rationale. If no safe recommendation, output an empty array.\n\n"
        f"Provider: {provider}\nModel: {model_label}\n"
        f"User goals (multi-select): {goals_line}\n"
        "If the user selected 'maximize quality of render', treat this as an optimization problem: "
        "prioritize maximizing prompt adherence and LLM-rated image quality, even if it increases cost/time. "
        "However, if the user also selected 'minimize cost of render' or 'minimize time to render', "
        "those goals take precedence and quality becomes secondary.\n"
        "If the user selected 'maximize LLM retrieval score', prioritize legibility, captionability, "
        "and retrieval-focused clarity even if aesthetic quality softens, unless cost/time goals are selected.\n"
        f"User notes: {notes_line or '(none)'}\n"
        f"{web_search_text}"
        f"{call_path_text}"
        f"{history_block}"
        f"{model_block}"
        "If speed is a priority, consider unconventional levers (e.g., output format/filetype, "
        "compression, or size tradeoffs) but still choose from the allowed list. "
        "Prefer changes likely to result in a 10x improvement to the metrics attached to the user's stated goals "
        "(avoid tiny deltas like steps 20→30); think big and unconventional when it helps meet the goals.\n"
        "If cost/time goals are selected, treat them as primary and only pursue quality improvements "
        "that do not materially worsen cost/time.\n"
        f"You have at most {max_rounds} total rounds. This is round {current_round}; "
        f"{remaining_rounds} round(s) remain after this. "
        "Plan a coherent testing path and avoid flip-flopping settings unless there's a strong reason.\n"
        "Model changes must stay within the same provider and use the listed model options.\n"
        "Use setting_target='provider_options' for provider-specific options, "
        f"and setting_target='request' for top-level settings like {top_level_hint}.\n"
        f"Allowed settings: {allowed_line}\n"
        "Do NOT recommend or list settings outside the allowed list.\n\n"
        f"Receipt summary JSON:\n{summary_json}"
    )


def _analyze_receipt_payload(
    *,
    receipt_path: Path,
    provider: str,
    model: str | None,
    size: str,
    n: int,
    out_dir: str | Path,
    analyzer: str | None = None,
    user_goals: list[str] | None = None,
    user_notes: str | None = None,
    history_text: str | None = None,
    local_history_text: str | None = None,
    history_rounds: int = 0,
) -> tuple[str, list[dict[str, str]], list[dict] | None, str | None, str | None]:
    analyzer_key = _normalize_analyzer(analyzer)
    receipt = _load_receipt_payload(receipt_path)
    image_path = None
    artifacts = receipt.get("artifacts")
    if isinstance(artifacts, dict):
        raw_path = artifacts.get("image_path")
        if isinstance(raw_path, str):
            image_path = Path(raw_path)
    if image_path is not None and not image_path.exists():
        image_path = None
    explicit_fields = {
        "provider": provider,
        "model": model or "(default)",
        "size": size,
        "n": n,
        "prompt": str(receipt.get("request", {}).get("prompt", "")),
        "out_dir": str(out_dir),
    }
    resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else None
    request = receipt.get("request") if isinstance(receipt.get("request"), dict) else None
    provider_options = None
    if isinstance(request, dict):
        provider_options = request.get("provider_options")
    if not (isinstance(provider_options, dict) and provider_options):
        if isinstance(resolved, dict):
            provider_options = resolved.get("provider_params")
    if not isinstance(provider_options, dict):
        provider_options = None
    provider_key, _ = _normalize_provider_and_model(provider, model)
    if provider_key == "openai":
        use_responses = None
        for source in (
            resolved.get("provider_params") if isinstance(resolved, dict) else None,
            request.get("provider_options") if isinstance(request, dict) else None,
        ):
            if isinstance(source, dict) and "use_responses" in source:
                use_responses = bool(source.get("use_responses"))
                break
        if use_responses is None:
            use_responses = False
        explicit_fields["use_responses"] = use_responses
    target_prompt = FIXED_PROMPT
    allowed_settings = _allowed_settings_for_receipt(receipt, provider)
    allowed_models = _allowed_models_for_provider(provider, model)
    model_options_line = _model_options_line(provider, size, model, provider_options)
    summary = {
        "request": receipt.get("request"),
        "resolved": receipt.get("resolved"),
        "provider_request": receipt.get("provider_request"),
        "warnings": receipt.get("warnings"),
        "result_metadata": receipt.get("result_metadata"),
    }
    summary_json = json.dumps(summary, indent=2, ensure_ascii=True)
    allow_web_search = analyzer_key in {"anthropic", "council"}
    current_round = max(1, history_rounds + 1)
    prompt = _build_receipt_analysis_prompt(
        receipt=receipt,
        explicit_fields=explicit_fields,
        target_prompt=target_prompt,
        allowed_settings=allowed_settings,
        user_goals=user_goals,
        user_notes=user_notes,
        history_text=history_text,
        local_history_text=local_history_text,
        model_options_line=model_options_line,
        enable_web_search=allow_web_search,
        current_round=current_round,
        max_rounds=MAX_ROUNDS,
    )
    fallback_prompt = None
    if allow_web_search:
        fallback_prompt = _build_receipt_analysis_prompt(
            receipt=receipt,
            explicit_fields=explicit_fields,
            target_prompt=target_prompt,
            allowed_settings=allowed_settings,
            user_goals=user_goals,
            user_notes=user_notes,
            history_text=history_text,
            local_history_text=local_history_text,
            model_options_line=model_options_line,
            enable_web_search=False,
            current_round=current_round,
            max_rounds=MAX_ROUNDS,
        )
    image_base64 = None
    image_mime = None
    if image_path is not None:
        try:
            image_base64, image_mime = _load_image_for_analyzer(image_path)
        except Exception as exc:
            raise RuntimeError(f"failed to read image for analysis ({exc})") from exc
    analysis_text, citations = _call_analyzer(
        prompt,
        analyzer=analyzer_key,
        enable_web_search=allow_web_search,
        image_base64=image_base64,
        image_mime=image_mime,
        fallback_prompt=fallback_prompt,
    )
    if len(analysis_text) > ANALYSIS_MAX_CHARS:
        analysis_text = _compress_analysis_to_limit(
            analysis_text,
            ANALYSIS_MAX_CHARS,
            analyzer=analyzer_key,
        )
    analysis_text = _normalize_rec_line(analysis_text)
    cleaned_text, recommendation_payload = _extract_setting_json(analysis_text)
    recs_payload, stop_reason, stop_recommended = _parse_recommendation_payload(recommendation_payload)
    stop_reason = None
    stop_recommended = False
    cleaned_text = _normalize_rec_line(cleaned_text)
    rec_text = _rec_line_text(cleaned_text)
    recommendations = _normalize_recommendations(recs_payload)
    recommendations = _filter_noop_recommendations(
        recommendations,
        resolved,
        request,
        provider=provider,
        model=model,
    )
    recommendations = _filter_unsupported_top_level_recommendations(recommendations, provider)
    recommendations = _filter_locked_size_recommendations(recommendations, size)
    recommendations = _filter_model_recommendations(recommendations, allowed_models)
    if rec_text and "no change" in rec_text:
        recommendations = []
    cleaned_text, cost_line = _extract_cost_line(cleaned_text)
    local_cost_line = _estimate_cost_only(
        provider=provider,
        model=model,
        size=size,
        n=n,
        provider_options=provider_options,
    )
    cost_line = local_cost_line
    recommendations = _sanitize_recommendation_rationales(
        recommendations,
        cost_line,
        provider=provider,
        size=size,
        n=n,
        provider_options=provider_options,
    )
    cleaned_text = _rewrite_rec_line(cleaned_text, recommendations)
    if not recommendations:
        fallback_prompt = _build_recommendation_only_prompt(
            summary_json=summary_json,
            allowed_settings=allowed_settings,
            provider=provider,
            model=model,
            user_goals=user_goals,
            user_notes=user_notes,
            history_text=history_text,
            local_history_text=local_history_text,
            model_options_line=model_options_line,
            enable_web_search=allow_web_search,
            current_round=current_round,
            max_rounds=MAX_ROUNDS,
        )
        fallback_prompt_no_search = None
        if allow_web_search:
            fallback_prompt_no_search = _build_recommendation_only_prompt(
                summary_json=summary_json,
                allowed_settings=allowed_settings,
                provider=provider,
                model=model,
                user_goals=user_goals,
                user_notes=user_notes,
                history_text=history_text,
                local_history_text=local_history_text,
                model_options_line=model_options_line,
                enable_web_search=False,
                current_round=current_round,
                max_rounds=MAX_ROUNDS,
            )
        fallback_text, _ = _call_analyzer(
            fallback_prompt,
            analyzer=analyzer_key,
            enable_web_search=allow_web_search,
            fallback_prompt=fallback_prompt_no_search,
        )
        _, fallback_payload = _extract_setting_json(fallback_text)
        recs_payload, fallback_stop_reason, fallback_stop = _parse_recommendation_payload(fallback_payload)
        fallback_stop_reason = None
        fallback_stop = False
        recommendations = _normalize_recommendations(recs_payload)
        recommendations = _filter_noop_recommendations(
            recommendations,
            resolved,
            request,
            provider=provider,
            model=model,
        )
        recommendations = _filter_locked_size_recommendations(recommendations, size)
        recommendations = _filter_model_recommendations(recommendations, allowed_models)
        recommendations = _sanitize_recommendation_rationales(
            recommendations,
            cost_line,
            provider=provider,
            size=size,
            n=n,
            provider_options=provider_options,
        )
        cleaned_text = _rewrite_rec_line(cleaned_text, recommendations)
    return cleaned_text, citations, recommendations or None, cost_line, stop_reason


def _analyze_receipt(
    receipt_path: Path,
    *,
    provider: str,
    model: str | None,
    size: str,
    n: int,
    out_dir: str | Path,
    analyzer: str | None = None,
) -> None:
    analyzer_key = _normalize_analyzer(analyzer)
    print(f"\nAnalyzing receipt with {_analyzer_display_name(analyzer_key)}...")
    if analyzer_key == "council":
        print("Note: Council analysis can take a few minutes.")
    try:
        analysis, citations, recommendation, cost_line, stop_reason = _analyze_receipt_payload(
            receipt_path=receipt_path,
            provider=provider,
            model=model,
            size=size,
            n=n,
            out_dir=str(out_dir),
            analyzer=analyzer_key,
        )
    except Exception as exc:
        print(f"Receipt analysis failed: {exc}")
        return
    try:
        receipt_payload = _load_receipt_payload(receipt_path)
        detail_lines = _build_receipt_detail_lines(
            receipt_payload,
            recommendation,
            max_width=max(40, _term_width() - 2),
            stop_reason=None,
        )
        if not recommendation:
            summary_settings = _settings_from_receipt(
                receipt_payload,
                fallback_provider=provider,
                fallback_model=model,
                fallback_size=size,
                fallback_n=n,
            )
            detail_lines.append("")
            detail_lines.extend(
                [
                    line
                    for line in _build_final_recommendation_lines(
                        summary_settings,
                        None,
                        user_goals=None,
                        max_width=max(40, _term_width() - 2),
                        return_tags=False,
                        last_elapsed=None,
                        cost_line=cost_line,
                        baseline_settings=None,
                        baseline_elapsed=None,
                        baseline_cost_line=None,
                        force_quality_metrics=False,
                        retrieval_baseline=None,
                        retrieval_current=None,
                    )
                    if isinstance(line, str)
                ]
            )
    except Exception:
        detail_lines = []
    print("\nMODEL ANALYSIS (LLM):")
    if analysis:
        print(_display_analysis_text(analysis))
    else:
        print("Receipt analysis returned no content.")
    if detail_lines:
        print("\nReceipt settings & recommendations:")
        for line in detail_lines:
            if isinstance(line, str):
                print(line)


def _open_path(path: Path) -> None:
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
        elif hasattr(os, "startfile"):
            os.startfile(str(path))  # type: ignore[attr-defined]
        else:
            subprocess.run(["xdg-open", str(path)], check=False)
    except Exception:
        pass


_VIEWER_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Param Forge Viewer</title>
    <style>
      :root {
        --ink: #121212;
        --muted: #6b645f;
        --paper: #f6f1e8;
        --paper-2: #fbfaf7;
        --card: #ffffff;
        --accent: #ff6b3d;
        --accent-2: #2aa7a1;
        --accent-3: #f2c14e;
        --shadow: rgba(16, 16, 16, 0.12);
        --border: rgba(18, 18, 18, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Avenir Next", "Futura", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at top, #f9ede2 0%, var(--paper) 45%, #f1f7f4 100%);
      }
      .page {
        max-width: 1400px;
        margin: 0 auto;
        padding: 32px 24px 64px;
      }
      header.hero {
        padding: 24px 28px;
        border-radius: 20px;
        background: linear-gradient(120deg, #fff2e8 0%, #f7fff7 50%, #f1f5ff 100%);
        box-shadow: 0 16px 40px -28px rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 107, 61, 0.12);
      }
      header.hero h1 {
        margin: 0 0 8px;
        font-size: 28px;
        letter-spacing: -0.02em;
      }
      header.hero .meta {
        display: flex;
        flex-wrap: wrap;
        gap: 16px;
        font-size: 14px;
        color: var(--muted);
      }
      .pill {
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(18, 18, 18, 0.06);
        border: 1px solid var(--border);
      }
      .toolbar {
        display: grid;
        grid-template-columns: minmax(220px, 1fr) minmax(240px, 1fr) minmax(220px, 1fr);
        gap: 16px;
        margin: 20px 0 12px;
      }
      .leaderboard {
        margin: 18px 0 24px;
        background: #fff;
        border-radius: 18px;
        border: 1px solid var(--border);
        box-shadow: 0 18px 32px -26px rgba(0, 0, 0, 0.35);
        padding: 16px 18px;
      }
      .leaderboard-header {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        justify-content: space-between;
        gap: 12px;
      }
      .leaderboard-header h2 {
        margin: 0 0 4px;
        font-size: 16px;
      }
      .leaderboard-note {
        margin: 0;
        font-size: 12px;
        color: var(--muted);
      }
      .leaderboard-filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .leaderboard-filters label {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        padding: 6px 10px;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--paper-2);
      }
      .leaderboard-filters input[type="number"] {
        width: 88px;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 4px 6px;
        font-size: 12px;
        background: #fff;
      }
      .leaderboard-active {
        margin-top: 10px;
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        font-size: 12px;
        color: var(--muted);
      }
      .leaderboard-table-wrap {
        margin-top: 12px;
        overflow: auto;
      }
      table.leaderboard-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        min-width: 840px;
      }
      table.leaderboard-table th,
      table.leaderboard-table td {
        border-bottom: 1px solid var(--border);
        padding: 10px 12px;
        text-align: left;
        font-size: 13px;
        vertical-align: top;
      }
      table.leaderboard-table th {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        color: var(--muted);
        background: var(--paper-2);
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .leaderboard-cell {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .leaderboard-sub {
        font-size: 11px;
        color: var(--muted);
      }
      .panel {
        background: var(--paper-2);
        border-radius: 16px;
        border: 1px solid var(--border);
        padding: 12px 14px;
        box-shadow: 0 10px 24px -18px var(--shadow);
      }
      .panel h3 {
        margin: 0 0 8px;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      .panel input[type="text"] {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--border);
        background: #fff;
        font-size: 14px;
      }
      .toggle-row {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        font-size: 13px;
      }
      .toggle-row label {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
      }
      .filter-list {
        max-height: 160px;
        overflow: auto;
        display: grid;
        grid-template-columns: 1fr;
        gap: 6px;
      }
      .filter-list label {
        display: flex;
        gap: 8px;
        align-items: center;
        font-size: 13px;
      }
      .compare {
        margin: 18px 0 24px;
        padding: 16px;
        background: #fff;
        border-radius: 18px;
        border: 1px solid var(--border);
        box-shadow: 0 18px 30px -26px rgba(0, 0, 0, 0.3);
      }
      .compare h2 {
        margin: 0 0 12px;
        font-size: 16px;
      }
      .compare-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 14px;
      }
      .compare-card {
        background: var(--paper-2);
        border-radius: 14px;
        border: 1px solid var(--border);
        padding: 10px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .compare-card img {
        width: 100%;
        border-radius: 10px;
        object-fit: cover;
      }
      .grid-wrap {
        overflow: auto;
        border-radius: 18px;
        border: 1px solid var(--border);
        background: #fff;
        box-shadow: 0 18px 32px -26px rgba(0, 0, 0, 0.35);
      }
      table.grid {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        min-width: 920px;
      }
      table.grid th,
      table.grid td {
        border-bottom: 1px solid var(--border);
        vertical-align: top;
        padding: 12px;
      }
      table.grid thead th {
        position: sticky;
        top: 0;
        background: #fff;
        z-index: 5;
        text-align: left;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: var(--muted);
      }
      table.grid tbody th {
        position: sticky;
        left: 0;
        background: #fff;
        z-index: 4;
        width: 280px;
        max-width: 280px;
      }
      .prompt-text {
        font-size: 13px;
        line-height: 1.4;
      }
      .prompt-meta {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .card {
        background: var(--paper-2);
        border-radius: 14px;
        border: 1px solid var(--border);
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 8px;
        min-height: 240px;
        animation: rise 0.4s ease;
      }
      .card.selected {
        border-color: var(--accent);
        box-shadow: 0 12px 28px -18px rgba(255, 107, 61, 0.7);
      }
      .card.winner {
        border-color: var(--accent-2);
        box-shadow: 0 12px 28px -18px rgba(42, 167, 161, 0.7);
      }
      .card.auto {
        border-color: var(--accent-3);
        box-shadow: 0 12px 28px -18px rgba(242, 193, 78, 0.7);
      }
      .card img {
        width: 100%;
        height: 180px;
        object-fit: cover;
        display: block;
      }
      .card-body {
        padding: 10px 12px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .badge {
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(18, 18, 18, 0.08);
        font-size: 11px;
      }
      .badge.accent { background: rgba(255, 107, 61, 0.18); }
      .badge.teal { background: rgba(42, 167, 161, 0.18); }
      .badge.yellow { background: rgba(242, 193, 78, 0.25); }
      .badge.pareto { background: rgba(42, 167, 161, 0.2); }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .btn {
        border: none;
        padding: 6px 10px;
        border-radius: 8px;
        background: var(--accent);
        color: #fff;
        font-size: 12px;
        cursor: pointer;
      }
      .btn.ghost {
        background: rgba(18, 18, 18, 0.08);
        color: var(--ink);
      }
      .cell-empty {
        font-size: 12px;
        color: var(--muted);
        padding: 16px;
      }
      .nav-row {
        display: flex;
        justify-content: space-between;
        font-size: 11px;
        color: var(--muted);
      }
      .nav-row button {
        background: transparent;
        border: none;
        cursor: pointer;
        font-size: 12px;
      }
      .toast {
        position: fixed;
        right: 20px;
        top: 20px;
        padding: 10px 14px;
        border-radius: 10px;
        background: rgba(18, 18, 18, 0.92);
        color: #fff;
        font-size: 13px;
        opacity: 0;
        transform: translateY(-10px);
        transition: all 0.2s ease;
        pointer-events: none;
        z-index: 99;
      }
      .toast.show {
        opacity: 1;
        transform: translateY(0);
      }
      @keyframes rise {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      @media (max-width: 960px) {
        .toolbar { grid-template-columns: 1fr; }
        table.grid tbody th { width: 220px; max-width: 220px; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="hero">
        <h1 id="run-title">Param Forge Viewer</h1>
        <div class="meta" id="run-meta"></div>
      </header>
      <div class="toolbar">
        <div class="panel">
          <h3>Search</h3>
          <input id="prompt-search" type="text" placeholder="Filter prompts..." />
        </div>
        <div class="panel">
          <h3>Focus</h3>
          <div class="toggle-row">
            <label><input id="toggle-winners" type="checkbox" /> Winners only</label>
            <label><input id="toggle-flags" type="checkbox" /> Flags only</label>
          </div>
        </div>
        <div class="panel">
          <h3>Models</h3>
          <div class="filter-list" id="column-filters"></div>
        </div>
      </div>
      <section class="leaderboard">
        <div class="leaderboard-header">
          <div>
            <h2>Run leaderboard</h2>
            <p class="leaderboard-note" id="leaderboard-note">Auto picks are used until you select winners.</p>
          </div>
          <div class="leaderboard-filters">
            <label><input id="filter-pareto-cost" type="checkbox" /> Pareto frontier (cost)</label>
            <label><input id="filter-pareto-latency" type="checkbox" /> Pareto frontier (latency)</label>
            <label><input id="filter-hide-dominated" type="checkbox" /> Hide dominated (cost)</label>
            <label>Max $/image <input id="filter-max-cost" type="number" step="0.001" min="0" placeholder="0.03" /></label>
            <label>Max sec/image (p95) <input id="filter-max-latency" type="number" step="0.1" min="0" placeholder="4.0" /></label>
          </div>
        </div>
        <div class="leaderboard-active" id="leaderboard-active"></div>
        <div class="leaderboard-table-wrap">
          <table class="leaderboard-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Images (n)</th>
                <th>Avg cost / 1K images</th>
                <th>Latency</th>
                <th>Failure rate</th>
                <th>Flag rate</th>
                <th>Pareto</th>
              </tr>
            </thead>
            <tbody id="leaderboard-body"></tbody>
          </table>
        </div>
      </section>
      <section class="compare">
        <h2>Side-by-side compare</h2>
        <div class="compare-grid" id="compare-grid">
          <div class="cell-empty">Pick up to 4 cards to compare.</div>
        </div>
      </section>
      <section class="grid-wrap">
        <table class="grid">
          <thead id="grid-head"></thead>
          <tbody id="grid-body"></tbody>
        </table>
      </section>
    </div>
    <div class="toast" id="toast"></div>
    <script>
      const PF_DATA = __DATA__;
      const state = {
        search: "",
        winnersOnly: false,
        flagsOnly: false,
        visibleColumns: new Set(),
        compare: [],
        winners: {},
        cellCursor: {},
        autoWinners: {},
        paretoCostOnly: false,
        paretoLatencyOnly: false,
        hideDominated: false,
        maxCost: null,
        maxLatency: null,
        filteredColumns: null
      };
      const variantsById = new Map();
      const cellIndex = {};
      const storageKey = `pf_winners_${PF_DATA.run.id || "default"}`;
      const jobStats = PF_DATA.job_stats || {};

      function loadWinners() {
        try {
          const raw = localStorage.getItem(storageKey);
          if (raw) {
            state.winners = JSON.parse(raw);
          }
        } catch (err) {
          state.winners = {};
        }
      }

      function saveWinners() {
        try {
          localStorage.setItem(storageKey, JSON.stringify(state.winners));
        } catch (err) {
          /* ignore */
        }
      }

      function toast(message) {
        const node = document.getElementById("toast");
        node.textContent = message;
        node.classList.add("show");
        setTimeout(() => node.classList.remove("show"), 1400);
      }

      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(() => toast("Copied."));
          return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
        toast("Copied.");
      }

      function buildIndex() {
        PF_DATA.variants.forEach((variant) => {
          variantsById.set(variant.id, variant);
          if (!cellIndex[variant.prompt_id]) {
            cellIndex[variant.prompt_id] = {};
          }
          if (!cellIndex[variant.prompt_id][variant.column_key]) {
            cellIndex[variant.prompt_id][variant.column_key] = [];
          }
          cellIndex[variant.prompt_id][variant.column_key].push(variant);
        });
      }

      function scoreVariant(variant) {
        const values = [];
        if (Number.isFinite(variant.adherence)) values.push(variant.adherence);
        if (Number.isFinite(variant.quality)) values.push(variant.quality);
        if (Number.isFinite(variant.retrieval_score)) values.push(variant.retrieval_score);
        if (!values.length) return null;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
      }

      function computeAutoWinners() {
        state.autoWinners = {};
        PF_DATA.prompts.forEach((prompt) => {
          const variants = PF_DATA.variants.filter((variant) => variant.prompt_id === prompt.id);
          let best = null;
          variants.forEach((variant) => {
            const score = scoreVariant(variant);
            if (score === null) return;
            const cost = Number.isFinite(variant.cost_usd) ? variant.cost_usd : Infinity;
            const latency = Number.isFinite(variant.render_seconds_per_image)
              ? variant.render_seconds_per_image
              : Infinity;
            if (
              !best ||
              score > best.score ||
              (score === best.score && cost < best.cost) ||
              (score === best.score && cost === best.cost && latency < best.latency)
            ) {
              best = { id: variant.id, score, cost, latency, column_key: variant.column_key };
            }
          });
          if (best) {
            state.autoWinners[prompt.id] = best.id;
            const cellKey = `${prompt.id}::${best.column_key}`;
            const list = (cellIndex[prompt.id] || {})[best.column_key] || [];
            const idx = list.findIndex((item) => item.id === best.id);
            if (idx >= 0) {
              state.cellCursor[cellKey] = idx;
            }
          }
        });
      }

      function formatSeconds(value) {
        if (value === null || value === undefined) return "N/A";
        return `${value.toFixed(1)}s`;
      }

      function formatCost(cost) {
        if (!cost) return "N/A";
        return cost;
      }

      function formatPercent(value) {
        if (value === null || value === undefined) return "N/A";
        return `${(value * 100).toFixed(1)}%`;
      }

      function formatCurrency(value) {
        if (value === null || value === undefined) return "N/A";
        return `$${value.toFixed(4)}`;
      }

      function formatCurrencyPer1k(value) {
        if (value === null || value === undefined) return "N/A";
        const rounded = Math.round(value);
        return `$${rounded}/1K`;
      }

      function renderActiveFilters() {
        const container = document.getElementById("leaderboard-active");
        if (!container) return;
        container.innerHTML = "";
        const pills = [];
        if (state.paretoCostOnly) pills.push("Pareto frontier (cost)");
        if (state.paretoLatencyOnly) pills.push("Pareto frontier (latency)");
        if (state.hideDominated) pills.push("Hide dominated (cost)");
        if (state.maxCost !== null) pills.push(`Max $/image <= ${state.maxCost}`);
        if (state.maxLatency !== null) pills.push(`Max sec/image (p95) <= ${state.maxLatency}`);
        const label = document.createElement("span");
        label.textContent = "Active filters:";
        container.appendChild(label);
        if (!pills.length) {
          const none = document.createElement("span");
          none.textContent = "None";
          container.appendChild(none);
          return;
        }
        pills.forEach((text) => {
          const pill = document.createElement("div");
          pill.className = "pill";
          pill.textContent = text;
          container.appendChild(pill);
        });
      }

      function average(values) {
        if (!values.length) return null;
        const total = values.reduce((sum, item) => sum + item, 0);
        return total / values.length;
      }

      function quantile(values, q) {
        if (!values.length) return null;
        const sorted = [...values].sort((a, b) => a - b);
        const pos = (sorted.length - 1) * q;
        const base = Math.floor(pos);
        const rest = pos - base;
        if (sorted[base + 1] !== undefined) {
          return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
        }
        return sorted[base];
      }

      function colorScale(value, min, max) {
        if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) return "";
        if (max <= min) return "hsl(120, 45%, 92%)";
        const t = Math.min(1, Math.max(0, (value - min) / (max - min)));
        const hue = 120 - 120 * t;
        return `hsl(${hue}, 55%, 90%)`;
      }

      function computeWinStats() {
        const manualTotal = Object.keys(state.winners).length;
        const useManual = manualTotal > 0;
        const source = useManual ? "manual" : "auto";
        const winners = useManual ? state.winners : state.autoWinners;
        const winCounts = {};
        let total = 0;
        Object.entries(winners).forEach(([promptId, variantId]) => {
          const variant = variantsById.get(variantId);
          if (!variant) return;
          total += 1;
          const key = variant.column_key;
          winCounts[key] = (winCounts[key] || 0) + 1;
        });
        return { winCounts, total, source };
      }

      function computeModelStats() {
        const stats = {};
        PF_DATA.variants.forEach((variant) => {
          const key = variant.column_key;
          if (!stats[key]) {
            stats[key] = {
              key,
              label: variant.column_label,
              total: 0,
              costs: [],
              latencies: [],
              scores: [],
              flagged: 0,
              flagCounts: {},
              normalizationCounts: {}
            };
          }
          const entry = stats[key];
          entry.total += 1;
          if (Number.isFinite(variant.cost_usd)) {
            entry.costs.push(variant.cost_usd);
          }
          if (Number.isFinite(variant.render_seconds_per_image)) {
            entry.latencies.push(variant.render_seconds_per_image);
          }
          const score = scoreVariant(variant);
          if (Number.isFinite(score)) {
            entry.scores.push(score);
          }
          if (variant.flags && variant.flags.length) {
            entry.flagged += 1;
            variant.flags.forEach((flag) => {
              entry.flagCounts[flag] = (entry.flagCounts[flag] || 0) + 1;
            });
          }
          if (variant.normalizations && variant.normalizations.length) {
            variant.normalizations.forEach((note) => {
              entry.normalizationCounts[note] = (entry.normalizationCounts[note] || 0) + 1;
            });
          }
        });

        const { winCounts, total: winTotal, source: winSource } = computeWinStats();
        const rows = PF_DATA.columns.map((column) => {
          const entry = stats[column.key] || {
            key: column.key,
            label: column.label,
            total: 0,
            costs: [],
            latencies: [],
            scores: [],
            flagged: 0,
            flagCounts: {}
          };
          const avgCost = average(entry.costs);
          const avgLatency = average(entry.latencies);
          const scoreAvg = average(entry.scores);
          const p50 = quantile(entry.latencies, 0.5);
          const p95 = quantile(entry.latencies, 0.95);
          const winCount = winCounts[entry.key] || 0;
          const winRate = winTotal ? winCount / winTotal : null;
          const flagsRate = entry.total ? entry.flagged / entry.total : null;
          const flagPairs = Object.entries(entry.flagCounts).sort((a, b) => b[1] - a[1]);
          const topFlags = flagPairs.slice(0, 2).map(([name]) => name);
          const normPairs = Object.entries(entry.normalizationCounts).sort((a, b) => b[1] - a[1]);
          const topNormalizations = normPairs.slice(0, 2).map(([name]) => name);
          const job = jobStats[entry.key] || {};
          const jobTotal = Number.isFinite(job.total) ? job.total : null;
          const failed = Number.isFinite(job.failed) ? job.failed : null;
          const failureRate = jobTotal && failed !== null ? failed / jobTotal : null;
          return {
            key: entry.key,
            label: entry.label,
            total: entry.total,
            avgCost,
            avgLatency,
            p50,
            p95,
            quality: scoreAvg,
            winRate,
            winCount,
            winTotal,
            winSource,
            flagsRate,
            topFlags,
            topNormalizations,
            failureRate,
            jobTotal,
            failed
          };
        });
        return { rows, winSource };
      }

      function paretoFront(stats, costKey, qualityKey) {
        return stats.filter((current) => {
          if (!Number.isFinite(current[costKey]) || !Number.isFinite(current[qualityKey])) {
            return false;
          }
          return !stats.some((other) => {
            if (other.key === current.key) return false;
            if (!Number.isFinite(other[costKey]) || !Number.isFinite(other[qualityKey])) {
              return false;
            }
            const betterOrEqualQuality = other[qualityKey] >= current[qualityKey];
            const betterOrEqualCost = other[costKey] <= current[costKey];
            const strictlyBetter = other[qualityKey] > current[qualityKey] || other[costKey] < current[costKey];
            return betterOrEqualQuality && betterOrEqualCost && strictlyBetter;
          });
        });
      }

      function computeLeaderboardData() {
        const { rows, winSource } = computeModelStats();
        const baseRows = rows.filter((row) => state.visibleColumns.has(row.key));
        const paretoCostRows = paretoFront(baseRows, "avgCost", "quality");
        const paretoLatencyRows = paretoFront(baseRows, "avgLatency", "quality");
        const paretoCost = new Set(paretoCostRows.map((row) => row.key));
        const paretoLatency = new Set(paretoLatencyRows.map((row) => row.key));
        const dominatedCost = new Set(baseRows.filter((row) => !paretoCost.has(row.key)).map((row) => row.key));

        const allowed = new Set(baseRows.map((row) => row.key));
        if (state.maxCost !== null) {
          baseRows.forEach((row) => {
            if (!Number.isFinite(row.avgCost) || row.avgCost > state.maxCost) {
              allowed.delete(row.key);
            }
          });
        }
        if (state.maxLatency !== null) {
          baseRows.forEach((row) => {
            if (!Number.isFinite(row.p95) || row.p95 > state.maxLatency) {
              allowed.delete(row.key);
            }
          });
        }
        if (state.hideDominated) {
          dominatedCost.forEach((key) => allowed.delete(key));
        }
        if (state.paretoCostOnly || state.paretoLatencyOnly) {
          const paretoKeys = new Set();
          if (state.paretoCostOnly) {
            paretoCost.forEach((key) => paretoKeys.add(key));
          }
          if (state.paretoLatencyOnly) {
            paretoLatency.forEach((key) => paretoKeys.add(key));
          }
          baseRows.forEach((row) => {
            if (!paretoKeys.has(row.key)) {
              allowed.delete(row.key);
            }
          });
        }

        const withPareto = baseRows.map((row) => ({
          ...row,
          paretoCost: paretoCost.has(row.key),
          paretoLatency: paretoLatency.has(row.key)
        }));

        return { rows: withPareto, allowed, winSource };
      }

      function renderLeaderboard() {
        const body = document.getElementById("leaderboard-body");
        const note = document.getElementById("leaderboard-note");
        body.innerHTML = "";
        const { rows, allowed, winSource } = computeLeaderboardData();
        state.filteredColumns = allowed;
        renderActiveFilters();
        const filtered = rows.filter((row) => allowed.has(row.key));
        const costValues = filtered.map((row) => row.avgCost).filter((value) => Number.isFinite(value));
        const latencyValues = filtered.map((row) => row.p95).filter((value) => Number.isFinite(value));
        const minCost = costValues.length ? Math.min(...costValues) : null;
        const maxCost = costValues.length ? Math.max(...costValues) : null;
        const minLatency = latencyValues.length ? Math.min(...latencyValues) : null;
        const maxLatency = latencyValues.length ? Math.max(...latencyValues) : null;
        note.textContent =
          winSource === "manual"
            ? "Win rate is based on your picked winners."
            : "Auto picks are used until you select winners.";
        if (!filtered.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = 8;
          cell.className = "cell-empty";
          cell.textContent = "No models match the current filters.";
          row.appendChild(cell);
          body.appendChild(row);
          return;
        }
        const sorted = [...filtered].sort((a, b) => {
          if (a.winRate !== null && b.winRate !== null && a.winRate !== b.winRate) {
            return b.winRate - a.winRate;
          }
          if (a.quality !== null && b.quality !== null && a.quality !== b.quality) {
            return b.quality - a.quality;
          }
          if (a.avgCost !== null && b.avgCost !== null && a.avgCost !== b.avgCost) {
            return a.avgCost - b.avgCost;
          }
          return a.label.localeCompare(b.label);
        });
        sorted.forEach((rowData) => {
          const row = document.createElement("tr");
          const modelCell = document.createElement("td");
          const modelWrap = document.createElement("div");
          modelWrap.className = "leaderboard-cell";
          modelWrap.textContent = rowData.label;
          const modelSub = document.createElement("div");
          modelSub.className = "leaderboard-sub";
          modelSub.textContent = `${rowData.total} images`;
          modelCell.appendChild(modelWrap);
          modelCell.appendChild(modelSub);
          row.appendChild(modelCell);

          const totalCell = document.createElement("td");
          totalCell.textContent = rowData.total !== null && rowData.total !== undefined ? rowData.total : "0";
          row.appendChild(totalCell);

          const costCell = document.createElement("td");
          const avgPer1k = rowData.avgCost !== null ? rowData.avgCost * 1000 : null;
          costCell.textContent = avgPer1k !== null ? formatCurrencyPer1k(avgPer1k) : "N/A";
          if (rowData.avgCost !== null && minCost !== null && maxCost !== null) {
            costCell.style.background = colorScale(rowData.avgCost, minCost, maxCost);
          }
          row.appendChild(costCell);

          const latencyCell = document.createElement("td");
          const latencyWrap = document.createElement("div");
          latencyWrap.className = "leaderboard-cell";
          latencyWrap.textContent = rowData.p50 !== null ? `p50 ${rowData.p50.toFixed(1)}s` : "N/A";
          const latencySub = document.createElement("div");
          latencySub.className = "leaderboard-sub";
          latencySub.textContent =
            rowData.p95 !== null ? `p95 ${rowData.p95.toFixed(1)}s` : "p95 N/A";
          latencyCell.appendChild(latencyWrap);
          latencyCell.appendChild(latencySub);
          if (rowData.p95 !== null && minLatency !== null && maxLatency !== null) {
            latencyCell.style.background = colorScale(rowData.p95, minLatency, maxLatency);
          }
          row.appendChild(latencyCell);

          const failureCell = document.createElement("td");
          failureCell.textContent =
            rowData.failureRate !== null ? formatPercent(rowData.failureRate) : "N/A";
          row.appendChild(failureCell);

          const flagCell = document.createElement("td");
          const flagWrap = document.createElement("div");
          flagWrap.className = "leaderboard-cell";
          flagWrap.textContent = rowData.flagsRate !== null ? formatPercent(rowData.flagsRate) : "N/A";
          const flagSub = document.createElement("div");
          flagSub.className = "leaderboard-sub";
          flagSub.textContent = rowData.topFlags.length ? `top flags: ${rowData.topFlags.join(", ")}` : "";
          const normSub = document.createElement("div");
          normSub.className = "leaderboard-sub";
          normSub.textContent = rowData.topNormalizations.length
            ? `top normalization: ${rowData.topNormalizations.join(", ")}`
            : "";
          flagCell.appendChild(flagWrap);
          if (flagSub.textContent) flagCell.appendChild(flagSub);
          if (normSub.textContent) flagCell.appendChild(normSub);
          row.appendChild(flagCell);

          const paretoCell = document.createElement("td");
          const paretoWrap = document.createElement("div");
          paretoWrap.className = "badges";
          if (rowData.paretoCost) {
            paretoWrap.appendChild(buildBadge("cost", "pareto"));
          }
          if (rowData.paretoLatency) {
            paretoWrap.appendChild(buildBadge("latency", "pareto"));
          }
          if (!rowData.paretoCost && !rowData.paretoLatency) {
            paretoWrap.textContent = "—";
          }
          paretoCell.appendChild(paretoWrap);
          row.appendChild(paretoCell);
          body.appendChild(row);
        });
      }

      function renderMeta() {
        const meta = document.getElementById("run-meta");
        meta.innerHTML = "";
        const totalImages = PF_DATA.variants.length;
        const totalCost = PF_DATA.variants.reduce((sum, v) => sum + (v.cost_usd || 0), 0);
        const totalLatency = PF_DATA.variants.reduce((sum, v) => sum + (v.render_seconds_per_image || 0), 0);
        const avgLatency = totalImages ? totalLatency / totalImages : null;
        const items = [
          `Run: ${PF_DATA.run.id || "local"}`,
          `Prompts: ${PF_DATA.prompts.length}`,
          `Models: ${PF_DATA.columns.length}`,
          `Images: ${totalImages}`,
          `Est. cost: $${totalCost.toFixed(2)}`,
          `Avg latency: ${avgLatency ? avgLatency.toFixed(1) + "s" : "N/A"}`
        ];
        items.forEach((item) => {
          const pill = document.createElement("div");
          pill.className = "pill";
          pill.textContent = item;
          meta.appendChild(pill);
        });
        const title = document.getElementById("run-title");
        title.textContent = PF_DATA.run.title || "Param Forge Viewer";
      }

      function renderColumnFilters() {
        const container = document.getElementById("column-filters");
        container.innerHTML = "";
        PF_DATA.columns.forEach((column) => {
          const label = document.createElement("label");
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = state.visibleColumns.has(column.key);
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) {
              state.visibleColumns.add(column.key);
            } else {
              state.visibleColumns.delete(column.key);
            }
            renderLeaderboard();
            renderGrid();
          });
          label.appendChild(checkbox);
          const text = document.createElement("span");
          text.textContent = column.label;
          label.appendChild(text);
          container.appendChild(label);
        });
      }

      function buildBadge(label, className) {
        const badge = document.createElement("span");
        badge.className = `badge ${className || ""}`.trim();
        badge.textContent = label;
        return badge;
      }

      function buildCard(variant, prompt) {
        const card = document.createElement("div");
        card.className = "card";
        if (state.compare.includes(variant.id)) {
          card.classList.add("selected");
        }
        if (state.winners[prompt.id] === variant.id) {
          card.classList.add("winner");
        }
        const isAutoWinner = state.autoWinners[prompt.id] === variant.id;
        if (isAutoWinner) {
          card.classList.add("auto");
        }
        const image = document.createElement("img");
        image.src = variant.image_src;
        image.alt = variant.prompt || "generated image";
        image.loading = "lazy";
        image.addEventListener("click", () => window.open(variant.image_src, "_blank"));
        card.appendChild(image);

        const body = document.createElement("div");
        body.className = "card-body";

        const navRow = document.createElement("div");
        navRow.className = "nav-row";
        if (variant.variant_total && variant.variant_total > 1) {
          const prev = document.createElement("button");
          prev.textContent = "prev";
          prev.addEventListener("click", () => shiftVariant(prompt.id, variant.column_key, -1));
          const next = document.createElement("button");
          next.textContent = "next";
          next.addEventListener("click", () => shiftVariant(prompt.id, variant.column_key, 1));
          const index = document.createElement("span");
          index.textContent = `${variant.variant_index + 1}/${variant.variant_total}`;
          navRow.appendChild(prev);
          navRow.appendChild(index);
          navRow.appendChild(next);
          body.appendChild(navRow);
        }

        const badges = document.createElement("div");
        badges.className = "badges";
        badges.appendChild(buildBadge(`cost ${formatCost(variant.cost_per_1k)}`, "accent"));
        badges.appendChild(buildBadge(`render ${formatSeconds(variant.render_seconds_per_image)}`, "teal"));
        if (variant.adherence !== null && variant.adherence !== undefined) {
          badges.appendChild(buildBadge(`adh ${variant.adherence}`, "yellow"));
        }
        if (variant.quality !== null && variant.quality !== undefined) {
          badges.appendChild(buildBadge(`qual ${variant.quality}`, "yellow"));
        }
        if (variant.retrieval_score !== null && variant.retrieval_score !== undefined) {
          badges.appendChild(buildBadge(`retr ${variant.retrieval_score}`, "yellow"));
        }
        if (variant.flags && variant.flags.length) {
          badges.appendChild(buildBadge("flag", "accent"));
        }
        if (isAutoWinner) {
          badges.appendChild(buildBadge("auto pick", "yellow"));
        }
        body.appendChild(badges);

        const actions = document.createElement("div");
        actions.className = "actions";
        const copyBtn = document.createElement("button");
        copyBtn.className = "btn";
        copyBtn.textContent = "Copy snippet";
        copyBtn.addEventListener("click", () => copyText(variant.snippet));
        const compareBtn = document.createElement("button");
        compareBtn.className = "btn ghost";
        compareBtn.textContent = state.compare.includes(variant.id) ? "Remove" : "Compare";
        compareBtn.addEventListener("click", () => toggleCompare(variant.id));
        const winnerBtn = document.createElement("button");
        winnerBtn.className = "btn ghost";
        winnerBtn.textContent = state.winners[prompt.id] === variant.id ? "Winner" : "Pick winner";
        winnerBtn.addEventListener("click", () => pickWinner(prompt.id, variant.id));
        const receiptBtn = document.createElement("button");
        receiptBtn.className = "btn ghost";
        receiptBtn.textContent = "Receipt";
        receiptBtn.addEventListener("click", () => window.open(variant.receipt_src, "_blank"));
        actions.appendChild(copyBtn);
        actions.appendChild(compareBtn);
        actions.appendChild(winnerBtn);
        actions.appendChild(receiptBtn);
        body.appendChild(actions);

        card.appendChild(body);
        return card;
      }

      function renderGrid() {
        const head = document.getElementById("grid-head");
        const body = document.getElementById("grid-body");
        head.innerHTML = "";
        body.innerHTML = "";
        const allowedKeys = state.filteredColumns || new Set(state.visibleColumns);
        const visibleColumns = PF_DATA.columns.filter(
          (col) => state.visibleColumns.has(col.key) && allowedKeys.has(col.key)
        );

        const headRow = document.createElement("tr");
        const corner = document.createElement("th");
        corner.textContent = "Prompt";
        headRow.appendChild(corner);
        visibleColumns.forEach((col) => {
          const th = document.createElement("th");
          th.textContent = col.label;
          headRow.appendChild(th);
        });
        head.appendChild(headRow);

        PF_DATA.prompts.forEach((prompt) => {
          if (state.search && !prompt.text.toLowerCase().includes(state.search)) {
            return;
          }
          const row = document.createElement("tr");
          const promptCell = document.createElement("th");
          const promptText = document.createElement("div");
          promptText.className = "prompt-text";
          promptText.textContent = prompt.text;
          promptCell.appendChild(promptText);
          const promptMeta = document.createElement("div");
          promptMeta.className = "prompt-meta";
          if (state.winners[prompt.id]) {
            promptMeta.appendChild(buildBadge("winner picked", "teal"));
          }
          promptCell.appendChild(promptMeta);
          row.appendChild(promptCell);

          visibleColumns.forEach((column) => {
            const cell = document.createElement("td");
            const variants = (cellIndex[prompt.id] || {})[column.key] || [];
            if (!variants.length) {
              const empty = document.createElement("div");
              empty.className = "cell-empty";
              empty.textContent = "—";
              cell.appendChild(empty);
              row.appendChild(cell);
              return;
            }
            let filtered = variants;
            if (state.flagsOnly) {
              filtered = variants.filter((variant) => variant.flags && variant.flags.length);
            }
            if (state.winnersOnly) {
              filtered = variants.filter((variant) => state.winners[prompt.id] === variant.id);
            }
            if (!filtered.length) {
              const empty = document.createElement("div");
              empty.className = "cell-empty";
              empty.textContent = "filtered";
              cell.appendChild(empty);
              row.appendChild(cell);
              return;
            }
            const key = `${prompt.id}::${column.key}`;
            let idx = state.cellCursor[key] || 0;
            if (idx >= filtered.length) idx = 0;
            state.cellCursor[key] = idx;
            const variant = filtered[idx];
            variant.variant_index = idx;
            variant.variant_total = filtered.length;
            cell.appendChild(buildCard(variant, prompt));
            row.appendChild(cell);
          });
          body.appendChild(row);
        });
      }

      function renderCompare() {
        const grid = document.getElementById("compare-grid");
        grid.innerHTML = "";
        if (!state.compare.length) {
          const empty = document.createElement("div");
          empty.className = "cell-empty";
          empty.textContent = "Pick up to 4 cards to compare.";
          grid.appendChild(empty);
          return;
        }
        state.compare.forEach((id) => {
          const variant = variantsById.get(id);
          if (!variant) return;
          const card = document.createElement("div");
          card.className = "compare-card";
          const img = document.createElement("img");
          img.src = variant.image_src;
          img.alt = variant.prompt || "comparison image";
          card.appendChild(img);
          const badges = document.createElement("div");
          badges.className = "badges";
          badges.appendChild(buildBadge(variant.column_label, "accent"));
          badges.appendChild(buildBadge(`cost ${formatCost(variant.cost_per_1k)}`, "accent"));
          badges.appendChild(buildBadge(`render ${formatSeconds(variant.render_seconds_per_image)}`, "teal"));
          card.appendChild(badges);
          const actions = document.createElement("div");
          actions.className = "actions";
          const copyBtn = document.createElement("button");
          copyBtn.className = "btn";
          copyBtn.textContent = "Copy snippet";
          copyBtn.addEventListener("click", () => copyText(variant.snippet));
          const removeBtn = document.createElement("button");
          removeBtn.className = "btn ghost";
          removeBtn.textContent = "Remove";
          removeBtn.addEventListener("click", () => toggleCompare(id));
          actions.appendChild(copyBtn);
          actions.appendChild(removeBtn);
          card.appendChild(actions);
          grid.appendChild(card);
        });
      }

      function toggleCompare(id) {
        const idx = state.compare.indexOf(id);
        if (idx >= 0) {
          state.compare.splice(idx, 1);
        } else {
          if (state.compare.length >= 4) {
            toast("Compare tray is full.");
            return;
          }
          state.compare.push(id);
        }
        renderCompare();
        renderGrid();
      }

      function pickWinner(promptId, variantId) {
        if (state.winners[promptId] === variantId) {
          delete state.winners[promptId];
          toast("Winner cleared.");
        } else {
          state.winners[promptId] = variantId;
          toast("Winner saved.");
        }
        saveWinners();
        renderLeaderboard();
        renderGrid();
      }

      function shiftVariant(promptId, columnKey, direction) {
        const key = `${promptId}::${columnKey}`;
        const list = (cellIndex[promptId] || {})[columnKey] || [];
        if (!list.length) return;
        const current = state.cellCursor[key] || 0;
        const next = (current + direction + list.length) % list.length;
        state.cellCursor[key] = next;
        renderGrid();
      }

      function attachHandlers() {
        const search = document.getElementById("prompt-search");
        search.addEventListener("input", (event) => {
          state.search = event.target.value.toLowerCase();
          renderGrid();
        });
        document.getElementById("toggle-winners").addEventListener("change", (event) => {
          state.winnersOnly = event.target.checked;
          renderGrid();
        });
        document.getElementById("toggle-flags").addEventListener("change", (event) => {
          state.flagsOnly = event.target.checked;
          renderGrid();
        });
        document.getElementById("filter-pareto-cost").addEventListener("change", (event) => {
          state.paretoCostOnly = event.target.checked;
          renderLeaderboard();
          renderGrid();
        });
        document.getElementById("filter-pareto-latency").addEventListener("change", (event) => {
          state.paretoLatencyOnly = event.target.checked;
          renderLeaderboard();
          renderGrid();
        });
        document.getElementById("filter-hide-dominated").addEventListener("change", (event) => {
          state.hideDominated = event.target.checked;
          renderLeaderboard();
          renderGrid();
        });
        document.getElementById("filter-max-cost").addEventListener("input", (event) => {
          const raw = event.target.value;
          state.maxCost = raw ? parseFloat(raw) : null;
          if (Number.isNaN(state.maxCost)) state.maxCost = null;
          renderLeaderboard();
          renderGrid();
        });
        document.getElementById("filter-max-latency").addEventListener("input", (event) => {
          const raw = event.target.value;
          state.maxLatency = raw ? parseFloat(raw) : null;
          if (Number.isNaN(state.maxLatency)) state.maxLatency = null;
          renderLeaderboard();
          renderGrid();
        });
      }

      function init() {
        PF_DATA.columns.forEach((column) => state.visibleColumns.add(column.key));
        loadWinners();
        buildIndex();
        computeAutoWinners();
        renderMeta();
        renderColumnFilters();
        renderLeaderboard();
        renderGrid();
        renderCompare();
        attachHandlers();
      }

      init();
    </script>
  </body>
</html>
"""

_RUNS_DASHBOARD_TEMPLATE = """<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Param Forge Run Leaderboards</title>
    <style>
      :root {
        --ink: #121212;
        --muted: #6b645f;
        --paper: #f6f1e8;
        --paper-2: #fbfaf7;
        --card: #ffffff;
        --accent: #ff6b3d;
        --accent-2: #2aa7a1;
        --shadow: rgba(16, 16, 16, 0.12);
        --border: rgba(18, 18, 18, 0.08);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", "Avenir Next", "Futura", sans-serif;
        color: var(--ink);
        background: radial-gradient(circle at top, #f9ede2 0%, var(--paper) 45%, #f1f7f4 100%);
      }
      .page {
        max-width: 1400px;
        margin: 0 auto;
        padding: 32px 24px 64px;
      }
      header.hero {
        padding: 24px 28px;
        border-radius: 20px;
        background: linear-gradient(120deg, #fff2e8 0%, #f7fff7 50%, #f1f5ff 100%);
        box-shadow: 0 16px 40px -28px rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 107, 61, 0.12);
        margin-bottom: 18px;
      }
      header.hero h1 {
        margin: 0 0 8px;
        font-size: 28px;
        letter-spacing: -0.02em;
      }
      header.hero p {
        margin: 0;
        color: var(--muted);
        font-size: 14px;
      }
      .pill {
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(18, 18, 18, 0.06);
        border: 1px solid var(--border);
        font-size: 12px;
      }
      .run-card {
        background: #fff;
        border-radius: 18px;
        border: 1px solid var(--border);
        box-shadow: 0 18px 32px -26px rgba(0, 0, 0, 0.35);
        padding: 16px 18px;
        margin-bottom: 20px;
      }
      .run-header {
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: flex-start;
        flex-wrap: wrap;
      }
      .run-header h2 {
        margin: 0 0 6px;
        font-size: 18px;
      }
      .run-path {
        font-size: 12px;
        color: var(--muted);
        word-break: break-all;
      }
      .run-meta {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 10px 0 12px;
      }
      .btn {
        border: none;
        padding: 8px 12px;
        border-radius: 10px;
        background: var(--accent);
        color: #fff;
        font-size: 12px;
        text-decoration: none;
        display: inline-block;
      }
      .btn.ghost {
        background: rgba(18, 18, 18, 0.08);
        color: var(--ink);
      }
      table.leaderboard-table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        min-width: 840px;
      }
      table.leaderboard-table th,
      table.leaderboard-table td {
        border-bottom: 1px solid var(--border);
        padding: 10px 12px;
        text-align: left;
        font-size: 13px;
        vertical-align: top;
      }
      table.leaderboard-table th {
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 11px;
        color: var(--muted);
        background: var(--paper-2);
        position: sticky;
        top: 0;
        z-index: 2;
      }
      .leaderboard-table-wrap {
        overflow: auto;
      }
      .leaderboard-sub {
        font-size: 11px;
        color: var(--muted);
      }
      .badges {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .badge {
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(18, 18, 18, 0.08);
        font-size: 11px;
      }
      .badge.pareto { background: rgba(42, 167, 161, 0.2); }
      .empty {
        padding: 12px;
        color: var(--muted);
        font-size: 13px;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header class="hero">
        <h1>Param Forge Run Leaderboards</h1>
        <p>Aggregated leaderboards across runs (cost, latency, failure, flags). Generated from run manifests + receipts.</p>
      </header>
      <div class="run-meta">
        __SUMMARY_PILLS__
      </div>
      __GLOBAL_SECTION__
      __RUN_SECTIONS__
    </div>
  </body>
</html>
"""


def _view_parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(text)
    except Exception:
        return None


def _view_seconds_between(start: str | None, end: str | None) -> float | None:
    start_dt = _view_parse_iso(start)
    end_dt = _view_parse_iso(end)
    if not start_dt or not end_dt:
        return None
    try:
        return max(0.0, (end_dt - start_dt).total_seconds())
    except Exception:
        return None


def _view_rel_path(path: Path, base: Path) -> str:
    try:
        rel = os.path.relpath(path, base)
        return Path(rel).as_posix()
    except Exception:
        return Path(path).as_posix()


def _view_build_snippet(receipt: dict) -> str:
    request = receipt.get("request") if isinstance(receipt.get("request"), dict) else {}
    resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else {}
    prompt = str(request.get("prompt") or resolved.get("prompt") or "")
    provider = resolved.get("provider") or request.get("provider") or "openai"
    model = resolved.get("model") or request.get("model")
    size = resolved.get("size") or request.get("size") or "1024x1024"
    n = resolved.get("n") or request.get("n") or 1
    seed = resolved.get("seed") or request.get("seed")
    output_format = resolved.get("output_format") or request.get("output_format")
    background = resolved.get("background") or request.get("background")
    mode = request.get("mode") or "generate"
    inputs = request.get("inputs") if isinstance(request.get("inputs"), dict) else {}
    provider_options = {}
    if isinstance(request.get("provider_options"), dict) and request.get("provider_options"):
        provider_options = dict(request.get("provider_options") or {})
    elif isinstance(resolved.get("provider_params"), dict):
        provider_options = dict(resolved.get("provider_params") or {})
    for key in ("size", "output_format", "background", "n", "seed", "model", "prompt"):
        provider_options.pop(key, None)
    provider_options = {k: provider_options[k] for k in sorted(provider_options) if provider_options[k] is not None}

    args: list[str] = [f"prompt={prompt!r}", f"provider={str(provider)!r}"]
    if model:
        args.append(f"model={str(model)!r}")
    if size and str(size) != "1024x1024":
        args.append(f"size={str(size)!r}")
    if n and int(n) != 1:
        args.append(f"n={int(n)}")
    if seed is not None:
        args.append(f"seed={int(seed)}")
    if output_format:
        args.append(f"output_format={str(output_format)!r}")
    if background:
        args.append(f"background={str(background)!r}")
    if provider_options:
        args.append(f"provider_options={provider_options!r}")
    call_name = "generate"
    if mode == "edit":
        call_name = "edit"
        init_image = inputs.get("init_image")
        if init_image:
            args.append(f"init_image={str(init_image)!r}")
        mask = inputs.get("mask")
        if mask:
            args.append(f"mask={str(mask)!r}")

    lines = [
        f"from forge_image_api import {call_name}",
        "",
        f"result = {call_name}(",
    ]
    lines.extend([f"    {item}," for item in args])
    lines.append(")")
    return "\n".join(lines)


def _view_classify_warning(message: str) -> str:
    text = message.strip().lower()
    if not text:
        return "warning"
    if "size snapped" in text or "snapped to" in text:
        return "normalization"
    if "aspect ratio" in text and ("normalized" in text or "snapped" in text):
        return "normalization"
    if "normalized" in text and ("size" in text or "aspect ratio" in text):
        return "normalization"
    return "warning"


def _view_load_manifest(run_dir: Path) -> dict | None:
    manifest_path = run_dir / "run.json"
    if not manifest_path.exists():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _view_collect_receipts(run_dir: Path, manifest: dict | None) -> tuple[list[Path], dict[Path, dict]]:
    receipts: list[Path] = []
    job_lookup: dict[Path, dict] = {}
    if manifest and isinstance(manifest.get("jobs"), list):
        for job in manifest.get("jobs", []):
            artifacts = job.get("artifacts") if isinstance(job, dict) else None
            if not isinstance(artifacts, dict):
                continue
            receipt_paths = artifacts.get("receipt_paths")
            if not isinstance(receipt_paths, list):
                continue
            for item in receipt_paths:
                if not isinstance(item, str):
                    continue
                path = (run_dir / item).resolve()
                receipts.append(path)
                job_lookup[path] = job
    if not receipts:
        receipts = sorted(run_dir.glob("receipt-*.json"))
    return receipts, job_lookup


def _view_build_index(run_path: Path, view_dir: Path) -> dict:
    run_dir = run_path if run_path.is_dir() else run_path.parent
    manifest = _view_load_manifest(run_dir)
    receipts, job_lookup = _view_collect_receipts(run_dir, manifest)
    job_stats: dict[str, dict[str, int]] = {}
    if manifest and isinstance(manifest.get("jobs"), list):
        for job in manifest.get("jobs", []):
            if not isinstance(job, dict):
                continue
            params = job.get("params") if isinstance(job.get("params"), dict) else {}
            provider = params.get("provider") or job.get("provider") or "unknown"
            model = params.get("model") or job.get("model") or "default"
            column_key = f"{provider}::{model}"
            entry = job_stats.setdefault(
                column_key,
                {"total": 0, "failed": 0, "skipped": 0, "succeeded": 0},
            )
            entry["total"] += 1
            status = job.get("status")
            if status == "failed":
                entry["failed"] += 1
            elif status == "skipped":
                entry["skipped"] += 1
            elif status == "success":
                entry["succeeded"] += 1

    prompts: list[dict[str, str]] = []
    prompt_by_id: dict[str, str] = {}
    prompt_id_by_text: dict[str, str] = {}

    if manifest and isinstance(manifest.get("jobs"), list):
        for job in manifest.get("jobs", []):
            if not isinstance(job, dict):
                continue
            prompt_id = str(job.get("prompt_id") or "")
            prompt_text = str(job.get("prompt") or "")
            if not prompt_id:
                continue
            if prompt_id in prompt_by_id:
                continue
            prompt_by_id[prompt_id] = prompt_text
            if prompt_text:
                prompt_id_by_text.setdefault(prompt_text, prompt_id)
            prompts.append({"id": prompt_id, "text": prompt_text})

    def _fallback_prompt_id(text: str) -> str:
        existing = prompt_id_by_text.get(text)
        if existing:
            return existing
        next_id = f"p-{len(prompts) + 1:04d}"
        prompt_id_by_text[text] = next_id
        prompt_by_id[next_id] = text
        prompts.append({"id": next_id, "text": text})
        return next_id

    columns: list[dict[str, str]] = []
    column_keys: dict[str, dict[str, str]] = {}

    variants: list[dict[str, object]] = []
    for receipt_path in receipts:
        try:
            receipt = _load_receipt_payload(receipt_path)
        except Exception:
            continue
        if not isinstance(receipt, dict):
            continue
        request = receipt.get("request") if isinstance(receipt.get("request"), dict) else {}
        resolved = receipt.get("resolved") if isinstance(receipt.get("resolved"), dict) else {}
        prompt_text = str(request.get("prompt") or resolved.get("prompt") or "")
        prompt_id = None
        job = job_lookup.get(receipt_path)
        if job and isinstance(job, dict):
            job_prompt = job.get("prompt_id")
            if job_prompt:
                prompt_id = str(job_prompt)
        if not prompt_id:
            prompt_id = _fallback_prompt_id(prompt_text)
        provider = resolved.get("provider") or request.get("provider") or "unknown"
        model = resolved.get("model") or request.get("model") or "default"
        column_key = f"{provider}::{model}"
        if column_key not in column_keys:
            column = {"key": column_key, "provider": str(provider), "model": str(model)}
            column["label"] = f"{provider} / {model}"
            column_keys[column_key] = column
            columns.append(column)
        column_label = column_keys[column_key]["label"]
        artifacts = receipt.get("artifacts") if isinstance(receipt.get("artifacts"), dict) else {}
        image_path = artifacts.get("image_path")
        receipt_path_value = artifacts.get("receipt_path")
        image_path_obj = Path(str(image_path)) if image_path else receipt_path.with_suffix(".png")
        if not image_path_obj.is_absolute():
            image_path_obj = (run_dir / image_path_obj).resolve()
        receipt_path_obj = Path(str(receipt_path_value)) if receipt_path_value else receipt_path
        if not receipt_path_obj.is_absolute():
            receipt_path_obj = (run_dir / receipt_path_obj).resolve()
        image_src = _view_rel_path(image_path_obj, view_dir)
        receipt_src = _view_rel_path(receipt_path_obj, view_dir)
        result_meta = receipt.get("result_metadata") if isinstance(receipt.get("result_metadata"), dict) else {}
        render_seconds = result_meta.get("render_seconds")
        if not isinstance(render_seconds, (int, float)):
            render_seconds = None
        if render_seconds is None and job and isinstance(job, dict):
            render_seconds = _view_seconds_between(job.get("started_at"), job.get("completed_at"))
        size = resolved.get("size") or request.get("size") or "1024x1024"
        n_value = resolved.get("n") or request.get("n") or 1
        try:
            n_value = int(n_value)
        except Exception:
            n_value = 1
        provider_options = None
        if isinstance(request.get("provider_options"), dict) and request.get("provider_options"):
            provider_options = request.get("provider_options")
        elif isinstance(resolved.get("provider_params"), dict) and resolved.get("provider_params"):
            provider_options = resolved.get("provider_params")
        render_seconds_per_image = None
        if isinstance(render_seconds, (int, float)):
            render_seconds_per_image = float(render_seconds) / max(1, n_value)
        cost_value = _estimate_cost_value(
            provider=str(provider) if provider else None,
            model=str(model) if model else None,
            size=str(size) if size else None,
            provider_options=provider_options if isinstance(provider_options, dict) else None,
        )
        cost_per_1k = _format_cost_value(cost_value)
        llm_scores = result_meta.get("llm_scores") if isinstance(result_meta.get("llm_scores"), dict) else {}
        adherence = llm_scores.get("adherence")
        quality = llm_scores.get("quality")
        retrieval_payload = result_meta.get("llm_retrieval") if isinstance(result_meta.get("llm_retrieval"), dict) else {}
        retrieval_score = retrieval_payload.get("score")
        quality_metrics = result_meta.get("image_quality_metrics") if isinstance(result_meta.get("image_quality_metrics"), dict) else {}
        quality_gates = quality_metrics.get("gates") if isinstance(quality_metrics.get("gates"), list) else []
        warnings: list[str] = []
        if isinstance(receipt.get("warnings"), list):
            warnings.extend([str(item) for item in receipt.get("warnings") if item])
        if isinstance(resolved.get("warnings"), list):
            warnings.extend([str(item) for item in resolved.get("warnings") if item])
        normalizations: list[str] = []
        warning_flags: list[str] = []
        for item in warnings:
            bucket = _view_classify_warning(item)
            if bucket == "normalization":
                normalizations.append(item)
            else:
                warning_flags.append(item)
        if normalizations:
            normalizations = list(dict.fromkeys(normalizations))
        snippet = _view_build_snippet(receipt)
        variant_id = receipt_path.name
        flags = []
        if isinstance(quality_gates, list):
            flags.extend([str(item) for item in quality_gates if item])
        if warning_flags:
            flags.extend(warning_flags)
        variants.append(
            {
                "id": variant_id,
                "prompt_id": prompt_id,
                "prompt": prompt_text,
                "column_key": column_key,
                "column_label": column_label,
                "provider": provider,
                "model": model,
                "size": size,
                "n": n_value,
                "image_src": image_src,
                "receipt_src": receipt_src,
                "render_seconds": render_seconds,
                "render_seconds_per_image": render_seconds_per_image,
                "cost_usd": cost_value,
                "cost_per_1k": cost_per_1k,
                "adherence": adherence,
                "quality": quality,
                "retrieval_score": retrieval_score,
                "flags": flags,
                "normalizations": normalizations,
                "snippet": snippet,
            }
        )

    run_title = "Param Forge • Model Showdown"
    return {
        "run": {
            "id": manifest.get("run_id") if isinstance(manifest, dict) else run_dir.name,
            "title": run_title,
            "path": str(run_dir),
        },
        "prompts": prompts,
        "columns": columns,
        "variants": variants,
        "job_stats": job_stats,
    }


def _view_html_escape(value: object) -> str:
    return html.escape(str(value), quote=True)


def _view_mean(values: list[float]) -> float | None:
    if not values:
        return None
    return float(sum(values) / len(values))


def _view_percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    sorted_vals = sorted(values)
    pos = (len(sorted_vals) - 1) * quantile
    base = int(math.floor(pos))
    rest = pos - base
    if base + 1 < len(sorted_vals):
        return sorted_vals[base] + rest * (sorted_vals[base + 1] - sorted_vals[base])
    return sorted_vals[base]


def _view_score_variant(variant: dict[str, object]) -> float | None:
    values: list[float] = []
    for key in ("adherence", "quality", "retrieval_score"):
        raw = variant.get(key)
        if isinstance(raw, (int, float)):
            values.append(float(raw))
    if not values:
        return None
    return float(sum(values) / len(values))


def _view_color_scale(value: float | None, min_value: float | None, max_value: float | None) -> str | None:
    if value is None or min_value is None or max_value is None:
        return None
    if max_value <= min_value:
        return "hsl(120, 55%, 90%)"
    t = (value - min_value) / (max_value - min_value)
    t = max(0.0, min(1.0, t))
    hue = 120 - 120 * t
    return f"hsl({hue:.1f}, 55%, 90%)"


def _view_pareto_front(rows: list[dict[str, object]], cost_key: str, quality_key: str) -> set[str]:
    frontier: set[str] = set()
    for row in rows:
        key = str(row.get("key") or "")
        cost = row.get(cost_key)
        quality = row.get(quality_key)
        if not isinstance(cost, (int, float)) or not isinstance(quality, (int, float)):
            continue
        dominated = False
        for other in rows:
            if other is row:
                continue
            other_cost = other.get(cost_key)
            other_quality = other.get(quality_key)
            if not isinstance(other_cost, (int, float)) or not isinstance(other_quality, (int, float)):
                continue
            better_or_equal_quality = other_quality >= quality
            better_or_equal_cost = other_cost <= cost
            strictly_better = other_quality > quality or other_cost < cost
            if better_or_equal_quality and better_or_equal_cost and strictly_better:
                dominated = True
                break
        if not dominated:
            frontier.add(key)
    return frontier


def _view_init_stat_entry(label: str) -> dict[str, object]:
    return {
        "label": label,
        "costs": [],
        "latencies": [],
        "scores": [],
        "total": 0,
        "flagged": 0,
        "flag_counts": {},
        "normalization_counts": {},
    }


def _view_collect_variant_stats(variants: list[dict[str, object]]) -> dict[str, dict[str, object]]:
    stats: dict[str, dict[str, object]] = {}
    for variant in variants:
        if not isinstance(variant, dict):
            continue
        key = str(variant.get("column_key") or "")
        if not key:
            continue
        label = str(variant.get("column_label") or key)
        entry = stats.setdefault(key, _view_init_stat_entry(label))
        entry["label"] = label
        entry["total"] = int(entry.get("total") or 0) + 1
        cost = variant.get("cost_usd")
        if isinstance(cost, (int, float)):
            entry["costs"].append(float(cost))
        latency = variant.get("render_seconds_per_image")
        if isinstance(latency, (int, float)):
            entry["latencies"].append(float(latency))
        score = _view_score_variant(variant)
        if isinstance(score, (int, float)):
            entry["scores"].append(float(score))
        flags = variant.get("flags") if isinstance(variant.get("flags"), list) else []
        if flags:
            entry["flagged"] = int(entry.get("flagged") or 0) + 1
            counts = entry["flag_counts"]
            for flag in flags:
                name = str(flag)
                counts[name] = int(counts.get(name, 0)) + 1
        normalizations = (
            variant.get("normalizations") if isinstance(variant.get("normalizations"), list) else []
        )
        if normalizations:
            counts = entry["normalization_counts"]
            for note in normalizations:
                name = str(note)
                counts[name] = int(counts.get(name, 0)) + 1
    return stats


def _view_rows_from_stats(
    stats: dict[str, dict[str, object]],
    job_stats: dict[str, dict[str, int]] | None = None,
    columns: list[dict[str, str]] | None = None,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    ordered_keys: list[tuple[str, str]] = []
    if columns:
        for column in columns:
            if not isinstance(column, dict):
                continue
            key = str(column.get("key") or "")
            if not key:
                continue
            label = str(column.get("label") or key)
            ordered_keys.append((key, label))
    else:
        for key, entry in stats.items():
            ordered_keys.append((key, str(entry.get("label") or key)))

    for key, label in ordered_keys:
        entry = stats.get(key, _view_init_stat_entry(label))
        costs = entry.get("costs") if isinstance(entry.get("costs"), list) else []
        latencies = entry.get("latencies") if isinstance(entry.get("latencies"), list) else []
        scores = entry.get("scores") if isinstance(entry.get("scores"), list) else []
        avg_cost = _view_mean(costs)
        p50 = _view_percentile(latencies, 0.5)
        p95 = _view_percentile(latencies, 0.95)
        quality = _view_mean(scores)
        total = int(entry.get("total") or 0)
        flagged = int(entry.get("flagged") or 0)
        flag_rate = (flagged / total) if total else None
        flag_counts = entry.get("flag_counts") if isinstance(entry.get("flag_counts"), dict) else {}
        top_flags = [name for name, _ in sorted(flag_counts.items(), key=lambda kv: kv[1], reverse=True)[:2]]
        norm_counts = (
            entry.get("normalization_counts") if isinstance(entry.get("normalization_counts"), dict) else {}
        )
        top_norms = [name for name, _ in sorted(norm_counts.items(), key=lambda kv: kv[1], reverse=True)[:2]]
        failure_rate = None
        if job_stats and isinstance(job_stats.get(key), dict):
            job_entry = job_stats.get(key, {})
            job_total = job_entry.get("total") if isinstance(job_entry.get("total"), int) else None
            failed = job_entry.get("failed") if isinstance(job_entry.get("failed"), int) else None
            if job_total:
                failure_rate = (failed / job_total) if failed is not None else None
        rows.append(
            {
                "key": key,
                "label": label,
                "avg_cost": avg_cost,
                "p50": p50,
                "p95": p95,
                "quality": quality,
                "flag_rate": flag_rate,
                "top_flags": top_flags,
                "top_norms": top_norms,
                "failure_rate": failure_rate,
                "total": total,
            }
        )
    return rows


def _view_decorate_rows(rows: list[dict[str, object]]) -> None:
    pareto_cost = _view_pareto_front(rows, "avg_cost", "quality")
    pareto_latency = _view_pareto_front(rows, "p95", "quality")

    cost_values = [row.get("avg_cost") for row in rows if isinstance(row.get("avg_cost"), (int, float))]
    latency_values = [row.get("p95") for row in rows if isinstance(row.get("p95"), (int, float))]
    min_cost = min(cost_values) if cost_values else None
    max_cost = max(cost_values) if cost_values else None
    min_latency = min(latency_values) if latency_values else None
    max_latency = max(latency_values) if latency_values else None

    for row in rows:
        key = str(row.get("key") or "")
        row["pareto_cost"] = key in pareto_cost
        row["pareto_latency"] = key in pareto_latency
        row["cost_color"] = _view_color_scale(
            row.get("avg_cost") if isinstance(row.get("avg_cost"), (int, float)) else None,
            min_cost,
            max_cost,
        )
        row["latency_color"] = _view_color_scale(
            row.get("p95") if isinstance(row.get("p95"), (int, float)) else None,
            min_latency,
            max_latency,
        )


def _view_collect_run_dirs(root: Path) -> list[Path]:
    run_dirs: list[Path] = []
    if root.is_file():
        return []
    for path in root.rglob("run.json"):
        if ".param_forge_view" in path.parts:
            continue
        run_dirs.append(path.parent)
    if root.joinpath("run.json").exists() and root not in run_dirs:
        run_dirs.insert(0, root)
    run_dirs = list(dict.fromkeys(run_dirs))
    run_dirs.sort(key=lambda p: p.joinpath("run.json").stat().st_mtime, reverse=True)
    return run_dirs


def _view_build_run_leaderboard_from_data(
    run_dir: Path, out_dir: Path, data: dict[str, object]
) -> dict[str, object]:
    columns = data.get("columns") if isinstance(data.get("columns"), list) else []
    variants = data.get("variants") if isinstance(data.get("variants"), list) else []
    prompts = data.get("prompts") if isinstance(data.get("prompts"), list) else []
    job_stats = data.get("job_stats") if isinstance(data.get("job_stats"), dict) else {}
    stats = _view_collect_variant_stats([item for item in variants if isinstance(item, dict)])
    rows = _view_rows_from_stats(stats, job_stats=job_stats, columns=columns)
    _view_decorate_rows(rows)

    run_view_path = run_dir / ".param_forge_view" / "index.html"
    view_href = None
    if run_view_path.exists():
        view_href = _view_rel_path(run_view_path, out_dir)

    total_cost = 0.0
    for variant in variants:
        if isinstance(variant, dict):
            cost = variant.get("cost_usd")
            if isinstance(cost, (int, float)):
                total_cost += float(cost)
    run_id = None
    if isinstance(data.get("run"), dict):
        run_id = data.get("run", {}).get("id")
    return {
        "run_id": run_id or run_dir.name,
        "path": str(run_dir),
        "prompts": len(prompts),
        "models": len(columns),
        "images": len(variants),
        "estimated_cost": total_cost if total_cost > 0 else None,
        "rows": rows,
        "view_href": view_href,
    }


def _view_build_run_leaderboard(run_dir: Path, out_dir: Path) -> dict[str, object]:
    data = _view_build_index(run_dir, run_dir)
    return _view_build_run_leaderboard_from_data(run_dir, out_dir, data)


def _view_build_aggregate_leaderboard(
    runs_data: list[tuple[Path, dict[str, object]]], out_dir: Path
) -> dict[str, object] | None:
    if not runs_data:
        return None
    stats: dict[str, dict[str, object]] = {}
    job_stats: dict[str, dict[str, int]] = {}
    prompt_total = 0
    image_total = 0
    run_count = 0
    for run_dir, data in runs_data:
        run_count += 1
        prompts = data.get("prompts") if isinstance(data.get("prompts"), list) else []
        variants = data.get("variants") if isinstance(data.get("variants"), list) else []
        prompt_total += len(prompts)
        image_total += len(variants)
        run_stats = _view_collect_variant_stats([item for item in variants if isinstance(item, dict)])
        for key, entry in run_stats.items():
            merged = stats.setdefault(key, _view_init_stat_entry(str(entry.get("label") or key)))
            merged["label"] = str(entry.get("label") or merged.get("label") or key)
            merged["total"] = int(merged.get("total") or 0) + int(entry.get("total") or 0)
            merged["flagged"] = int(merged.get("flagged") or 0) + int(entry.get("flagged") or 0)
            for field in ("costs", "latencies", "scores"):
                merged_list = merged.get(field) if isinstance(merged.get(field), list) else []
                entry_list = entry.get(field) if isinstance(entry.get(field), list) else []
                merged_list.extend([item for item in entry_list if isinstance(item, (int, float))])
                merged[field] = merged_list
            for field in ("flag_counts", "normalization_counts"):
                merged_counts = merged.get(field) if isinstance(merged.get(field), dict) else {}
                entry_counts = entry.get(field) if isinstance(entry.get(field), dict) else {}
                for name, count in entry_counts.items():
                    merged_counts[name] = int(merged_counts.get(name, 0)) + int(count)
                merged[field] = merged_counts
        run_job_stats = data.get("job_stats") if isinstance(data.get("job_stats"), dict) else {}
        for key, entry in run_job_stats.items():
            if not isinstance(entry, dict):
                continue
            merged_job = job_stats.setdefault(
                key, {"total": 0, "failed": 0, "skipped": 0, "succeeded": 0}
            )
            for field in ("total", "failed", "skipped", "succeeded"):
                value = entry.get(field)
                if isinstance(value, int):
                    merged_job[field] = int(merged_job.get(field, 0)) + value

    rows = _view_rows_from_stats(stats, job_stats=job_stats, columns=None)
    _view_decorate_rows(rows)

    total_cost = 0.0
    for _, data in runs_data:
        variants = data.get("variants") if isinstance(data.get("variants"), list) else []
        for variant in variants:
            if isinstance(variant, dict):
                cost = variant.get("cost_usd")
                if isinstance(cost, (int, float)):
                    total_cost += float(cost)
    return {
        "run_id": f"All runs ({run_count})",
        "path": str(out_dir),
        "prompts": prompt_total,
        "models": len(rows),
        "images": image_total,
        "estimated_cost": total_cost if total_cost > 0 else None,
        "rows": rows,
        "view_href": None,
    }


def _view_write_runs_dashboard(
    runs: list[dict[str, object]],
    out_path: Path,
    runs_root: Path,
    aggregate: dict[str, object] | None = None,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    run_sections: list[str] = []
    total_runs = len(runs)
    summary_pills = [
        f'<div class="pill">Runs: {total_runs}</div>',
        f'<div class="pill">Root: {_view_html_escape(runs_root)}</div>',
    ]
    if aggregate:
        summary_pills.append(f'<div class="pill">Models: {aggregate.get("models")}</div>')
        summary_pills.append(f'<div class="pill">Images: {aggregate.get("images")}</div>')
    for run in runs:
        run_sections.append(_view_render_run_section(run))

    global_section = ""
    if aggregate:
        global_section = _view_render_run_section(aggregate, title_override="All runs (aggregate)")
    html_text = _RUNS_DASHBOARD_TEMPLATE.replace("__RUN_SECTIONS__", "\n".join(run_sections))
    html_text = html_text.replace("__GLOBAL_SECTION__", global_section or "")
    html_text = html_text.replace("__SUMMARY_PILLS__", "\n".join(summary_pills))
    out_path.write_text(html_text, encoding="utf-8")


def _view_render_run_section(run: dict[str, object], title_override: str | None = None) -> str:
    rows = run.get("rows") if isinstance(run.get("rows"), list) else []
    if rows:
        row_html: list[str] = []
        for row in rows:
            label = _view_html_escape(row.get("label") or row.get("key") or "")
            avg_cost = row.get("avg_cost")
            cost_text = "N/A"
            if isinstance(avg_cost, (int, float)):
                cost_text = f"${int(round(avg_cost * 1000))}/1K"
            cost_style = row.get("cost_color")
            cost_attr = f' style="background: {cost_style};"' if cost_style else ""
            p50 = row.get("p50")
            p95 = row.get("p95")
            latency_text = "N/A"
            if isinstance(p50, (int, float)):
                latency_text = f"p50 {p50:.1f}s"
            latency_sub = f"p95 {p95:.1f}s" if isinstance(p95, (int, float)) else "p95 N/A"
            latency_style = row.get("latency_color")
            latency_attr = f' style="background: {latency_style};"' if latency_style else ""
            failure_rate = row.get("failure_rate")
            failure_text = f"{failure_rate * 100:.1f}%" if isinstance(failure_rate, (int, float)) else "N/A"
            flag_rate = row.get("flag_rate")
            flag_text = f"{flag_rate * 100:.1f}%" if isinstance(flag_rate, (int, float)) else "N/A"
            top_flags = row.get("top_flags") if isinstance(row.get("top_flags"), list) else []
            top_norms = row.get("top_norms") if isinstance(row.get("top_norms"), list) else []
            flag_sub = f"top flags: {', '.join(top_flags)}" if top_flags else ""
            norm_sub = f"top normalization: {', '.join(top_norms)}" if top_norms else ""
            pareto_badges: list[str] = []
            if row.get("pareto_cost"):
                pareto_badges.append('<span class="badge pareto">cost</span>')
            if row.get("pareto_latency"):
                pareto_badges.append('<span class="badge pareto">latency</span>')
            pareto_html = "".join(pareto_badges) if pareto_badges else "—"
            row_html.append(
                "<tr>"
                f"<td>{label}</td>"
                f"<td>{_view_html_escape(row.get('total') or 0)}</td>"
                f"<td{cost_attr}>{_view_html_escape(cost_text)}</td>"
                f"<td{latency_attr}><div>{_view_html_escape(latency_text)}</div>"
                f"<div class=\"leaderboard-sub\">{_view_html_escape(latency_sub)}</div></td>"
                f"<td>{_view_html_escape(failure_text)}</td>"
                f"<td><div>{_view_html_escape(flag_text)}</div>"
                f"<div class=\"leaderboard-sub\">{_view_html_escape(flag_sub)}</div>"
                f"<div class=\"leaderboard-sub\">{_view_html_escape(norm_sub)}</div></td>"
                f"<td><div class=\"badges\">{pareto_html}</div></td>"
                "</tr>"
            )
        table_html = (
            "<div class=\"leaderboard-table-wrap\">"
            "<table class=\"leaderboard-table\">"
            "<thead><tr>"
            "<th>Model</th>"
            "<th>Images (n)</th>"
            "<th>Avg cost / 1K images</th>"
            "<th>Latency</th>"
            "<th>Failure rate</th>"
            "<th>Flag rate</th>"
            "<th>Pareto</th>"
            "</tr></thead>"
            f"<tbody>{''.join(row_html)}</tbody>"
            "</table></div>"
        )
    else:
        table_html = '<div class="empty">No receipts found for this run.</div>'

    view_href = run.get("view_href")
    action_html = ""
    if view_href:
        action_html = f'<a class="btn" href="{_view_html_escape(view_href)}">Open run viewer</a>'
    elif view_href is None and title_override is None:
        action_html = '<span class="pill">Run viewer not generated</span>'

    estimated_cost = run.get("estimated_cost")
    cost_pill = (
        f'<div class="pill">Est. cost: ${estimated_cost:.2f}</div>'
        if isinstance(estimated_cost, (int, float))
        else '<div class="pill">Est. cost: N/A</div>'
    )
    title = title_override or (run.get("run_id") or "")
    return (
        "<section class=\"run-card\">"
        "<div class=\"run-header\">"
        f"<div><h2>{_view_html_escape(title)}</h2>"
        f"<div class=\"run-path\">{_view_html_escape(run.get('path') or '')}</div></div>"
        f"<div>{action_html}</div>"
        "</div>"
        "<div class=\"run-meta\">"
        f"<div class=\"pill\">Prompts: {run.get('prompts')}</div>"
        f"<div class=\"pill\">Models: {run.get('models')}</div>"
        f"<div class=\"pill\">Images: {run.get('images')}</div>"
        f"{cost_pill}"
        "</div>"
        f"{table_html}"
        "</section>"
    )


def _view_write_html(data: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=True).replace("<", "\\u003c")
    html_text = _VIEWER_TEMPLATE.replace("__DATA__", payload)
    out_path.write_text(html_text, encoding="utf-8")


def _has_viewer_artifacts(run_dir: Path) -> bool:
    run_dir = Path(run_dir).expanduser().resolve()
    if not run_dir.exists():
        return False
    has_manifest = (run_dir / "run.json").exists()
    has_receipts = any(run_dir.glob("receipt-*.json"))
    if not has_manifest and not has_receipts:
        return False
    return True


def _print_view_command(run_dir: Path) -> None:
    if not _has_viewer_artifacts(run_dir):
        return
    run_dir = Path(run_dir).expanduser().resolve()
    print(f"View with: python scripts/param_forge.py view {run_dir}")


def _run_view_cli(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="PARAM FORGE: view a receipt run locally.")
    parser.add_argument("path", nargs="?", help="Run folder, run.json, or receipt path")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Build a dashboard across all runs in the provided path (default: ./runs)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Output directory for viewer (default: <run>/.param_forge_view)",
    )
    parser.add_argument("--no-open", action="store_true", help="Do not open the viewer in a browser.")
    args = parser.parse_args(argv)

    if args.all:
        runs_root = None
        if args.path:
            runs_root = Path(args.path).expanduser().resolve()
        else:
            runs_root = (Path.cwd() / "runs").resolve()
        if not runs_root.exists():
            print(f"No runs directory found at {runs_root}")
            return 1
        out_dir = (
            Path(args.out).expanduser().resolve() if args.out else (runs_root / ".param_forge_view_all")
        )
        out_path = out_dir / "index.html"
        run_dirs = _view_collect_run_dirs(runs_root)
        runs_data = [(run_dir, _view_build_index(run_dir, run_dir)) for run_dir in run_dirs]
        runs = [_view_build_run_leaderboard_from_data(run_dir, out_dir, data) for run_dir, data in runs_data]
        aggregate = _view_build_aggregate_leaderboard(runs_data, out_dir)
        _view_write_runs_dashboard(runs, out_path, runs_root, aggregate=aggregate)
        if not args.no_open:
            _open_path(out_path)
        print(f"Run dashboard written to {out_path}")
        return 0

    if not args.path:
        parser.error("path is required unless --all is set")

    target = Path(args.path).expanduser().resolve()
    run_dir = target if target.is_dir() else target.parent
    out_dir = Path(args.out).expanduser().resolve() if args.out else (run_dir / ".param_forge_view")
    out_path = out_dir / "index.html"
    data = _view_build_index(run_dir, out_dir)
    _view_write_html(data, out_path)
    if not args.no_open:
        _open_path(out_path)
    print(f"Viewer written to {out_path}")
    return 0


def _utc_iso_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _experiment_relpath(path: Path, base: Path) -> str:
    try:
        rel = os.path.relpath(path, base)
        return Path(rel).as_posix()
    except Exception:
        return str(path)


def _write_manifest_atomic(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(path.name + ".tmp")
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    tmp_path.replace(path)


def _normalize_to_list(value: object) -> list[object]:
    if isinstance(value, list):
        return value
    if isinstance(value, tuple):
        return list(value)
    if value is None:
        return [None]
    return [value]


def _parse_prompt_txt(path: Path) -> list[dict[str, object]]:
    prompts: list[dict[str, object]] = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        prompt_id = f"p-{len(prompts) + 1:04d}"
        prompts.append({"id": prompt_id, "prompt": line, "metadata": {}})
    return prompts


def _parse_prompt_csv(path: Path) -> list[dict[str, object]]:
    prompts: list[dict[str, object]] = []
    seen_ids: set[str] = set()
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or "prompt" not in reader.fieldnames:
            raise RuntimeError("CSV prompts must include a 'prompt' column.")
        for row in reader:
            if row is None:
                continue
            prompt_raw = (row.get("prompt") or "").strip()
            if not prompt_raw:
                continue
            prompt_id = (row.get("id") or "").strip()
            if not prompt_id or prompt_id in seen_ids:
                prompt_id = f"p-{len(prompts) + 1:04d}"
            seen_ids.add(prompt_id)
            metadata: dict[str, object] = {}
            metadata_raw = (row.get("metadata") or "").strip()
            if metadata_raw:
                try:
                    parsed = json.loads(metadata_raw)
                    if isinstance(parsed, dict):
                        metadata.update(parsed)
                except Exception:
                    metadata["metadata_raw"] = metadata_raw
            for key, value in row.items():
                if key in {"prompt", "id", "metadata"}:
                    continue
                if value is None or str(value).strip() == "":
                    continue
                metadata[str(key)] = value
            prompts.append({"id": prompt_id, "prompt": prompt_raw, "metadata": metadata})
    return prompts


def _load_prompts_file(path: Path) -> list[dict[str, object]]:
    suffix = path.suffix.lower()
    if suffix == ".txt":
        return _parse_prompt_txt(path)
    if suffix == ".csv":
        return _parse_prompt_csv(path)
    raise RuntimeError("Prompt file must be .txt or .csv.")


def _load_matrix_file(path: Path) -> dict:
    text = path.read_text(encoding="utf-8")
    suffix = path.suffix.lower()
    payload: object
    if suffix in {".yaml", ".yml"}:
        try:
            import yaml  # type: ignore
        except Exception as exc:
            raise RuntimeError("PyYAML is required for .yaml matrix files. Install with: pip install pyyaml") from exc
        payload = yaml.safe_load(text)
    else:
        payload = json.loads(text)
    if isinstance(payload, list):
        return {"matrix": payload}
    if not isinstance(payload, dict):
        raise RuntimeError("Matrix file must be a JSON/YAML object or list.")
    return payload


def _normalize_matrix_payload(payload: dict) -> tuple[dict, list[dict], list[dict], list[dict], dict]:
    defaults = payload.get("defaults") if isinstance(payload.get("defaults"), dict) else {}
    matrix = payload.get("matrix")
    if matrix is None:
        matrix_list: list[dict] = []
    elif isinstance(matrix, list):
        matrix_list = [block for block in matrix if isinstance(block, dict)]
    elif isinstance(matrix, dict):
        matrix_list = [matrix]
    else:
        raise RuntimeError("Matrix 'matrix' must be a list of objects.")
    include = payload.get("include")
    if include is None:
        include_list: list[dict] = []
    elif isinstance(include, list):
        include_list = [block for block in include if isinstance(block, dict)]
    elif isinstance(include, dict):
        include_list = [include]
    else:
        raise RuntimeError("Matrix 'include' must be a list of objects.")
    exclude = payload.get("exclude")
    if exclude is None:
        exclude_list: list[dict] = []
    elif isinstance(exclude, list):
        exclude_list = [block for block in exclude if isinstance(block, dict)]
    elif isinstance(exclude, dict):
        exclude_list = [exclude]
    else:
        raise RuntimeError("Matrix 'exclude' must be a list of objects.")
    limits = payload.get("limits") if isinstance(payload.get("limits"), dict) else {}
    return defaults, matrix_list, include_list, exclude_list, limits


def _normalize_provider_options(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        return {}
    return {str(k): v for k, v in value.items()}


def _normalize_job_params(raw: dict[str, object], defaults: dict[str, object] | None = None) -> dict[str, object]:
    defaults = defaults or {}
    params: dict[str, object] = {}
    provider = raw.get("provider")
    if provider is None or str(provider).strip() == "":
        provider = defaults.get("provider", "openai")
    model = raw.get("model")
    if model is None or str(model).strip() == "":
        model = defaults.get("model")
    provider_key, model_key = _normalize_provider_and_model(str(provider), str(model) if model else None)
    params["provider"] = provider_key
    params["model"] = model_key
    size = raw.get("size")
    if size is None or str(size).strip() == "":
        size = defaults.get("size", "1024x1024")
    params["size"] = _normalize_size(str(size))
    n_value = raw.get("n")
    if n_value is None or (isinstance(n_value, str) and not n_value.strip()):
        n_value = defaults.get("n", 1)
    try:
        params["n"] = max(1, int(n_value))
    except Exception:
        params["n"] = 1
    seed = raw.get("seed")
    if seed is None or (isinstance(seed, str) and not seed.strip()):
        seed = defaults.get("seed")
    if seed is None:
        params["seed"] = None
    else:
        try:
            params["seed"] = int(seed)
        except Exception:
            params["seed"] = seed
    output_format = raw.get("output_format")
    if output_format is None or (isinstance(output_format, str) and not output_format.strip()):
        output_format = defaults.get("output_format")
    params["output_format"] = output_format
    background = raw.get("background")
    if background is None or (isinstance(background, str) and not background.strip()):
        background = defaults.get("background")
    params["background"] = background
    options = {}
    options.update(_normalize_provider_options(defaults.get("provider_options")))
    options.update(_normalize_provider_options(raw.get("provider_options")))
    params["provider_options"] = options
    return params


def _expand_provider_options(options: dict[str, object]) -> list[dict[str, object]]:
    if not options:
        return [{}]
    keys = sorted(options.keys())
    values = [_normalize_to_list(options[key]) for key in keys]
    combos: list[dict[str, object]] = []
    for item in itertools.product(*values):
        combo = {key: item[idx] for idx, key in enumerate(keys)}
        combos.append(combo)
    return combos


def _expand_matrix_blocks(blocks: list[dict], defaults: dict[str, object]) -> list[dict[str, object]]:
    expanded: list[dict[str, object]] = []
    for block in blocks:
        params_base: dict[str, object] = {}
        for key in _EXPERIMENT_PARAM_KEYS:
            if key in defaults:
                params_base[key] = defaults[key]
            if key in block:
                params_base[key] = block[key]
        options = {}
        options.update(_normalize_provider_options(defaults.get("provider_options")))
        options.update(_normalize_provider_options(block.get("provider_options")))
        option_combos = _expand_provider_options(options)
        keys = sorted(params_base.keys())
        values = [_normalize_to_list(params_base[key]) for key in keys]
        if not keys:
            keys = []
            values = []
        for combo in itertools.product(*values):
            params = {key: combo[idx] for idx, key in enumerate(keys)}
            for opt in option_combos:
                combined = dict(params)
                combined["provider_options"] = opt
                expanded.append(_normalize_job_params(combined, defaults))
    return expanded


def _match_filter_value(value: object, expected: object) -> bool:
    if isinstance(expected, dict):
        if not isinstance(value, dict):
            return False
        for key, exp in expected.items():
            if key not in value:
                return False
            if not _match_filter_value(value.get(key), exp):
                return False
        return True
    if isinstance(expected, (list, tuple, set)):
        return value in expected
    if isinstance(value, str) and isinstance(expected, str):
        return value.strip().lower() == expected.strip().lower()
    return value == expected


def _apply_excludes(params_list: list[dict[str, object]], excludes: list[dict]) -> list[dict[str, object]]:
    if not excludes:
        return params_list
    filtered: list[dict[str, object]] = []
    for params in params_list:
        matched = False
        for rule in excludes:
            if _match_filter_value(params, rule):
                matched = True
                break
        if not matched:
            filtered.append(params)
    return filtered


def _build_experiment_jobs(
    *,
    prompts: list[dict[str, object]],
    params_list: list[dict[str, object]],
) -> list[dict[str, object]]:
    jobs: list[dict[str, object]] = []
    job_index = 0
    for prompt in prompts:
        prompt_text = str(prompt.get("prompt") or "")
        prompt_id = str(prompt.get("id") or "")
        prompt_metadata = prompt.get("metadata") if isinstance(prompt.get("metadata"), dict) else {}
        for params in params_list:
            job_index += 1
            job_id = f"j-{job_index:06d}"
            provider_options = params.get("provider_options")
            cost_value = _estimate_cost_value(
                provider=str(params.get("provider") or ""),
                model=str(params.get("model") or "") if params.get("model") else None,
                size=str(params.get("size") or ""),
                provider_options=provider_options if isinstance(provider_options, dict) else None,
            )
            n_value = params.get("n", 1)
            try:
                n_count = int(n_value)
            except Exception:
                n_count = 1
            estimated_cost = float(cost_value) * max(1, n_count) if cost_value is not None else None
            job_entry: dict[str, object] = {
                "job_id": job_id,
                "prompt_id": prompt_id,
                "prompt": prompt_text,
                "params": params,
                "status": "pending",
                "attempts": 0,
                "started_at": None,
                "completed_at": None,
                "estimated_cost_usd": estimated_cost,
                "actual_cost_usd": None,
                "artifacts": {"image_paths": [], "receipt_paths": []},
                "warnings": [],
                "error": None,
            }
            if prompt_metadata:
                job_entry["prompt_metadata"] = prompt_metadata
            jobs.append(job_entry)
    return jobs


def _recompute_experiment_summary(manifest: dict) -> dict[str, object]:
    jobs = manifest.get("jobs")
    summary: dict[str, object] = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    succeeded = failed = skipped = 0
    estimated_total = 0.0
    actual_total: float | None = None
    if isinstance(jobs, list):
        for job in jobs:
            if not isinstance(job, dict):
                continue
            status = job.get("status")
            if status == "success":
                succeeded += 1
            elif status == "failed":
                failed += 1
            elif status == "skipped":
                skipped += 1
            estimated_cost = job.get("estimated_cost_usd")
            if status != "skipped" and isinstance(estimated_cost, (int, float)):
                estimated_total += float(estimated_cost)
            actual_cost = job.get("actual_cost_usd")
            if status != "skipped" and isinstance(actual_cost, (int, float)):
                if actual_total is None:
                    actual_total = 0.0
                actual_total += float(actual_cost)
    summary["succeeded"] = succeeded
    summary["failed"] = failed
    summary["skipped"] = skipped
    summary["estimated_cost_usd"] = round(estimated_total, 6)
    summary["actual_cost_usd"] = actual_total
    manifest["summary"] = summary
    return summary


def _parse_provider_concurrency(value: str | None) -> dict[str, int]:
    if not value:
        return {}
    parsed: dict[str, int] = {}
    for raw in value.split(","):
        if not raw or "=" not in raw:
            continue
        key, count_raw = raw.split("=", 1)
        key = key.strip()
        try:
            count = int(count_raw.strip())
        except Exception:
            continue
        if count <= 0:
            continue
        provider_key, _ = _normalize_provider_and_model(key, None)
        parsed[provider_key] = count
    return parsed


def _normalize_provider_concurrency(value: object) -> dict[str, int]:
    if isinstance(value, dict):
        parsed: dict[str, int] = {}
        for key, count_raw in value.items():
            try:
                count = int(count_raw)
            except Exception:
                continue
            if count <= 0:
                continue
            provider_key, _ = _normalize_provider_and_model(str(key), None)
            parsed[provider_key] = count
        return parsed
    return {}


def _apply_budget_limits(
    *,
    manifest: dict,
    budget_usd: float | None,
    budget_mode: str,
    resume: bool,
) -> None:
    if budget_usd is None or budget_mode == "off":
        return
    jobs = manifest.get("jobs")
    if not isinstance(jobs, list):
        return
    running_total = 0.0
    budget_exhausted = False
    for job in jobs:
        if not isinstance(job, dict):
            continue
        status = job.get("status")
        if resume and status == "success":
            estimated_cost = job.get("estimated_cost_usd")
            if isinstance(estimated_cost, (int, float)):
                running_total += float(estimated_cost)
            continue
        if status == "skipped":
            continue
        if budget_exhausted:
            job["status"] = "skipped"
            job["error"] = "budget exceeded"
            continue
        estimated_cost = job.get("estimated_cost_usd")
        if estimated_cost is None:
            if budget_mode == "strict":
                job["status"] = "skipped"
                job["error"] = "unknown cost in strict budget mode"
            continue
        try:
            estimated_cost_value = float(estimated_cost)
        except Exception:
            estimated_cost_value = None
        if estimated_cost_value is None:
            if budget_mode == "strict":
                job["status"] = "skipped"
                job["error"] = "unknown cost in strict budget mode"
            continue
        if running_total + estimated_cost_value > budget_usd:
            job["status"] = "skipped"
            job["error"] = "budget exceeded"
            budget_exhausted = True
            continue
        running_total += estimated_cost_value


def _run_experiment_jobs(
    *,
    manifest: dict,
    run_dir: Path,
    concurrency: int,
    provider_concurrency: dict[str, int],
    resume: bool,
    cancel_event: threading.Event | None = None,
) -> int:
    manifest_path = run_dir / "run.json"
    lock = threading.Lock()
    provider_semaphores = {
        provider: threading.Semaphore(limit)
        for provider, limit in provider_concurrency.items()
        if limit > 0
    }
    jobs = manifest.get("jobs")
    if not isinstance(jobs, list):
        return 1

    def _write_manifest() -> None:
        _recompute_experiment_summary(manifest)
        _write_manifest_atomic(manifest_path, manifest)

    def _update_job(index: int, updates: dict[str, object]) -> None:
        with lock:
            job = jobs[index]
            if isinstance(job, dict):
                job.update(updates)
            _write_manifest()

    def _should_run(job: dict) -> bool:
        status = job.get("status")
        if resume:
            return status in {"pending", "failed", "running"}
        return status == "pending"

    run_indexes = [idx for idx, job in enumerate(jobs) if isinstance(job, dict) and _should_run(job)]
    if not run_indexes:
        print("No jobs to run.")
        return 0

    def _execute_job(index: int) -> tuple[int, bool]:
        job = jobs[index]
        if not isinstance(job, dict):
            return index, False
        if cancel_event and cancel_event.is_set():
            _update_job(
                index,
                {
                    "status": "skipped",
                    "completed_at": _utc_iso_now(),
                    "error": "cancelled",
                },
            )
            return index, False
        params = job.get("params") if isinstance(job.get("params"), dict) else {}
        provider = str(params.get("provider") or "openai")
        semaphore = provider_semaphores.get(provider)
        if semaphore is not None:
            semaphore.acquire()
        try:
            attempts = int(job.get("attempts") or 0)
            success = False
            last_error: str | None = None
            for attempt in range(attempts, attempts + _EXPERIMENT_MAX_RETRIES + 1):
                if cancel_event and cancel_event.is_set():
                    _update_job(
                        index,
                        {
                            "status": "skipped",
                            "completed_at": _utc_iso_now(),
                            "error": "cancelled",
                        },
                    )
                    return index, False
                updates = {
                    "status": "running",
                    "attempts": attempt + 1,
                    "started_at": _utc_iso_now(),
                }
                _update_job(index, updates)
                try:
                    from forge_image_api import generate

                    results = generate(
                        prompt=str(job.get("prompt") or ""),
                        provider=provider,
                        size=str(params.get("size") or "1024x1024"),
                        n=int(params.get("n") or 1),
                        out_dir=run_dir,
                        model=str(params.get("model") or "") or None,
                        provider_options=params.get("provider_options") if isinstance(params.get("provider_options"), dict) else {},
                        seed=params.get("seed"),
                        output_format=params.get("output_format"),
                        background=params.get("background"),
                    )
                    image_paths = [_experiment_relpath(Path(result.image_path), run_dir) for result in results]
                    receipt_paths = [_experiment_relpath(Path(result.receipt_path), run_dir) for result in results]
                    _update_job(
                        index,
                        {
                            "status": "success",
                            "completed_at": _utc_iso_now(),
                            "artifacts": {"image_paths": image_paths, "receipt_paths": receipt_paths},
                            "error": None,
                        },
                    )
                    success = True
                    break
                except Exception as exc:
                    last_error = str(exc)
                    if attempt < attempts + _EXPERIMENT_MAX_RETRIES:
                        continue
            if not success:
                job_id = job.get("job_id") if isinstance(job, dict) else None
                model = params.get("model") if isinstance(params, dict) else None
                _update_job(
                    index,
                    {
                        "status": "failed",
                        "completed_at": _utc_iso_now(),
                        "error": last_error or "unknown error",
                    },
                )
                label = f"{provider}/{model}" if model else provider
                if job_id:
                    print(f"Job {job_id} failed ({label}): {last_error or 'unknown error'}")
                else:
                    print(f"Job failed ({label}): {last_error or 'unknown error'}")
            return index, success
        finally:
            if semaphore is not None:
                semaphore.release()

    print(f"Running {len(run_indexes)} jobs with concurrency={concurrency}...")
    exit_code = 0
    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = [executor.submit(_execute_job, idx) for idx in run_indexes]
        for future in as_completed(futures):
            try:
                _, ok = future.result()
                if not ok:
                    exit_code = 1
            except Exception:
                exit_code = 1
    if cancel_event and cancel_event.is_set():
        with lock:
            for job in jobs:
                if not isinstance(job, dict):
                    continue
                if job.get("status") == "pending":
                    job["status"] = "skipped"
                    job["completed_at"] = _utc_iso_now()
                    job["error"] = "cancelled"
            _write_manifest()
    return exit_code


def _run_experiment_cli(argv: list[str], *, cancel_event: threading.Event | None = None) -> int:
    parser = argparse.ArgumentParser(description="PARAM FORGE: run batch prompts across a matrix.")
    parser.add_argument("--prompts", help="Prompt file (.txt or .csv)")
    parser.add_argument("--matrix", help="Matrix file (.yaml or .json)")
    parser.add_argument("--out", required=True, help="Output run directory")
    parser.add_argument("--concurrency", type=int, default=None, help="Global concurrency (default: 3)")
    parser.add_argument(
        "--provider-concurrency",
        default=None,
        help="Per-provider concurrency (e.g., openai=1,gemini=2)",
    )
    parser.add_argument("--budget", type=float, default=None, help="Budget cap in USD")
    parser.add_argument(
        "--budget-mode",
        default=None,
        choices=_EXPERIMENT_BUDGET_MODES,
        help="Budget mode: estimate, strict, off",
    )
    parser.add_argument("--dry-run", action="store_true", help="Plan and exit without running")
    parser.add_argument("--resume", action="store_true", help="Resume an existing run.json")
    args = parser.parse_args(argv)

    run_dir = Path(args.out).expanduser().resolve()
    manifest_path = run_dir / "run.json"
    _load_repo_dotenv()

    if args.resume:
        if not manifest_path.exists():
            print(f"No run.json found at {manifest_path}.")
            return 1
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception as exc:
            print(f"Failed to read manifest: {exc}")
            return 1
        if not isinstance(manifest, dict):
            print("Run manifest is invalid.")
            return 1
        limits = manifest.get("limits") if isinstance(manifest.get("limits"), dict) else {}
        concurrency = args.concurrency if args.concurrency is not None else limits.get("concurrency")
        provider_concurrency = (
            _parse_provider_concurrency(args.provider_concurrency)
            if args.provider_concurrency
            else _normalize_provider_concurrency(limits.get("provider_concurrency"))
        )
        budget_mode = args.budget_mode or limits.get("budget_mode") or "estimate"
        budget = args.budget if args.budget is not None else limits.get("budget_usd")
    else:
        if not args.prompts or not args.matrix:
            print("Batch run requires --prompts and --matrix (or use --resume).")
            return 1
        if manifest_path.exists():
            print(f"run.json already exists in {run_dir}. Use --resume or choose a new --out.")
            return 1
        run_dir.mkdir(parents=True, exist_ok=True)
        prompt_path = Path(args.prompts).expanduser().resolve()
        matrix_path = Path(args.matrix).expanduser().resolve()
        try:
            prompts = _load_prompts_file(prompt_path)
        except Exception as exc:
            print(f"Failed to load prompts: {exc}")
            return 1
        if not prompts:
            print("No prompts found.")
            return 1
        try:
            matrix_payload = _load_matrix_file(matrix_path)
        except Exception as exc:
            print(f"Failed to load matrix: {exc}")
            return 1
        defaults, matrix_blocks, include_blocks, exclude_blocks, limits = _normalize_matrix_payload(matrix_payload)
        params_list = _expand_matrix_blocks(matrix_blocks, defaults)
        if include_blocks:
            params_list.extend(_expand_matrix_blocks(include_blocks, defaults))
        params_list = _apply_excludes(params_list, exclude_blocks)
        if not params_list:
            print("No matrix jobs found after applying include/exclude.")
            return 1
        jobs = _build_experiment_jobs(prompts=prompts, params_list=params_list)
        planned_images = 0
        for job in jobs:
            params = job.get("params") if isinstance(job.get("params"), dict) else {}
            try:
                planned_images += int(params.get("n") or 1)
            except Exception:
                planned_images += 1
        concurrency = args.concurrency if args.concurrency is not None else limits.get("concurrency")
        provider_concurrency = (
            _parse_provider_concurrency(args.provider_concurrency)
            if args.provider_concurrency
            else _normalize_provider_concurrency(limits.get("provider_concurrency"))
        )
        budget_mode = args.budget_mode or limits.get("budget_mode") or "estimate"
        budget = args.budget if args.budget is not None else limits.get("budget_usd")
        manifest = {
            "schema_version": _EXPERIMENT_SCHEMA_VERSION,
            "run_id": run_dir.name,
            "created_at": _utc_iso_now(),
            "started_at": None,
            "completed_at": None,
            "status": "planned",
            "inputs": {
                "prompts_path": _experiment_relpath(prompt_path, run_dir),
                "matrix_path": _experiment_relpath(matrix_path, run_dir),
                "prompt_count": len(prompts),
                "matrix_blocks": len(matrix_blocks),
                "expanded_jobs": len(jobs),
                "planned_images": planned_images,
            },
            "limits": {
                "concurrency": concurrency or _EXPERIMENT_DEFAULT_CONCURRENCY,
                "provider_concurrency": provider_concurrency,
                "budget_usd": budget,
                "budget_mode": budget_mode,
            },
            "summary": {
                "succeeded": 0,
                "failed": 0,
                "skipped": 0,
                "estimated_cost_usd": 0.0,
                "actual_cost_usd": None,
            },
            "jobs": jobs,
        }

    if concurrency is None:
        concurrency = _EXPERIMENT_DEFAULT_CONCURRENCY
    if concurrency <= 0:
        concurrency = _EXPERIMENT_DEFAULT_CONCURRENCY
    budget_mode = str(budget_mode or "estimate").lower()
    if budget_mode not in _EXPERIMENT_BUDGET_MODES:
        print(f"Unsupported budget mode '{budget_mode}'.")
        return 1

    if not isinstance(manifest.get("limits"), dict):
        manifest["limits"] = {}

    manifest["limits"]["concurrency"] = concurrency
    manifest["limits"]["provider_concurrency"] = provider_concurrency
    manifest["limits"]["budget_usd"] = budget
    manifest["limits"]["budget_mode"] = budget_mode

    _apply_budget_limits(manifest=manifest, budget_usd=budget, budget_mode=budget_mode, resume=args.resume)
    _recompute_experiment_summary(manifest)
    _write_manifest_atomic(manifest_path, manifest)

    inputs = manifest.get("inputs") if isinstance(manifest.get("inputs"), dict) else {}
    prompt_count = inputs.get("prompt_count")
    expanded_jobs = inputs.get("expanded_jobs")
    planned_images = inputs.get("planned_images")
    summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    print("Batch run plan:")
    print(f"  prompts={prompt_count} jobs={expanded_jobs} images={planned_images}")
    print(f"  concurrency={concurrency} budget={budget} mode={budget_mode}")
    print(f"  estimated_cost_usd={summary.get('estimated_cost_usd')}")

    if args.dry_run:
        print("Dry run complete. Manifest written.")
        return 0

    providers: set[str] = set()
    jobs = manifest.get("jobs")
    if isinstance(jobs, list):
        for job in jobs:
            if not isinstance(job, dict):
                continue
            if job.get("status") == "skipped":
                continue
            params = job.get("params") if isinstance(job.get("params"), dict) else {}
            providers.add(str(params.get("provider") or "openai"))
    for provider in sorted(providers):
        try:
            _ensure_api_keys(provider, _find_repo_dotenv(), allow_prompt=True)
        except RuntimeError as exc:
            print(f"Setup failed for {provider}: {exc}")
            return 1

    manifest["status"] = "running"
    if not manifest.get("started_at"):
        manifest["started_at"] = _utc_iso_now()
    _write_manifest_atomic(manifest_path, manifest)

    try:
        exit_code = _run_experiment_jobs(
            manifest=manifest,
            run_dir=run_dir,
            concurrency=concurrency,
            provider_concurrency=provider_concurrency,
            resume=args.resume,
            cancel_event=cancel_event,
        )
    except KeyboardInterrupt:
        manifest["completed_at"] = _utc_iso_now()
        manifest["status"] = "cancelled"
        _recompute_experiment_summary(manifest)
        _write_manifest_atomic(manifest_path, manifest)
        print("Cancelled.")
        return 1

    manifest["completed_at"] = _utc_iso_now()
    if cancel_event and cancel_event.is_set():
        manifest["status"] = "cancelled"
    else:
        manifest["status"] = "completed"
    _recompute_experiment_summary(manifest)
    _write_manifest_atomic(manifest_path, manifest)
    summary = manifest.get("summary") if isinstance(manifest.get("summary"), dict) else {}
    if cancel_event and cancel_event.is_set():
        print(
            "Run cancelled: "
            f"{summary.get('succeeded')} succeeded, {summary.get('failed')} failed, {summary.get('skipped')} skipped."
        )
    else:
        print(
            "Run complete: "
            f"{summary.get('succeeded')} succeeded, {summary.get('failed')} failed, {summary.get('skipped')} skipped."
        )
    print(f"Manifest: {manifest_path}")
    return exit_code


def _run_generation(args: argparse.Namespace) -> int:
    _load_repo_dotenv()
    args.analyzer = _resolve_receipt_analyzer(getattr(args, "analyzer", None))
    from forge_image_api import generate, stream

    normalized_provider, normalized_model = _normalize_provider_and_model(args.provider, args.model)
    args.provider = normalized_provider
    args.model = normalized_model
    args.size = _normalize_size(str(args.size))
    if not hasattr(args, "provider_options") or not isinstance(args.provider_options, dict):
        args.provider_options = {}
    if not hasattr(args, "seed"):
        args.seed = None
    if not hasattr(args, "output_format"):
        args.output_format = None
    if not hasattr(args, "background"):
        args.background = None
    if not hasattr(args, "openai_stream"):
        args.openai_stream = _env_flag(OPENAI_STREAM_ENV)
    if not hasattr(args, "openai_responses"):
        args.openai_responses = _env_flag(OPENAI_RESPONSES_ENV)
    openai_stream, openai_responses = _apply_openai_provider_flags(args)
    use_stream = bool(openai_stream and _is_openai_gpt_image(args.provider, args.model))
    allow_prompt = not bool(getattr(args, "defaults", False))
    try:
        _ensure_api_keys(args.provider, _find_repo_dotenv(), allow_prompt=allow_prompt)
    except RuntimeError as exc:
        if not allow_prompt:
            print(f"Setup failed: {exc}")
            print(f"Tip: set {_provider_key_hint(args.provider)} in your environment or .env, then rerun.")
            return 1
        raise
    retrieval_enabled = _retrieval_score_enabled(args)
    prompts = args.prompt or list(DEFAULT_PROMPTS)
    out_dir = Path(args.out).expanduser().resolve()

    if args.defaults:
        print("Running with defaults:")
        print(f"  provider={args.provider} size={args.size} n={args.n} out={out_dir}")
        print(f"  prompts={len(prompts)} (use --interactive to customize)")

    all_receipts: list[Path] = []
    last_image_path: Path | None = None
    for idx, prompt in enumerate(prompts, start=1):
        label = f"Generating ({idx}/{len(prompts)})"
        print(f"{label}: {prompt}")
        spinner = _Spinner(f"{label} in progress", show_elapsed=True)
        start_time = time.monotonic()
        spinner.start()
        stopped = False
        try:
            if use_stream:
                results = []
                for event in stream(
                    prompt=prompt,
                    provider=args.provider,
                    size=args.size,
                    n=args.n,
                    out_dir=out_dir,
                    model=args.model,
                    provider_options=args.provider_options,
                    seed=args.seed,
                    output_format=args.output_format,
                    background=args.background,
                ):
                    if event.type == "error":
                        raise RuntimeError(event.message or "Streaming failed.")
                    if event.type == "final" and event.result is not None:
                        results.append(event.result)
            else:
                results = generate(
                    prompt=prompt,
                    provider=args.provider,
                    size=args.size,
                    n=args.n,
                    out_dir=out_dir,
                    model=args.model,
                    provider_options=args.provider_options,
                    seed=args.seed,
                    output_format=args.output_format,
                    background=args.background,
                )
        except Exception as exc:
            spinner.stop()
            stopped = True
            print(f"Generation failed: {exc}")
            if args.provider == "gemini":
                print(
                    "Tip: Gemini image generation often requires specific model access. "
                    "Try --model gemini-2.5-flash-image or gemini-3-pro-image-preview, "
                    "or switch to --provider openai."
                )
            if args.defaults:
                return 1
            raise
        finally:
            if not stopped:
                spinner.stop()
        elapsed = time.monotonic() - start_time
        for result in results:
            print(result.image_path)
            print(result.receipt_path)
            all_receipts.append(Path(result.receipt_path))
            last_image_path = Path(result.image_path)
            scoring_label = "Council scoring"
            if retrieval_enabled:
                scoring_label = "Council scoring + retrieval"
            print(f"Stamping snapshot ({scoring_label})...")
            _apply_snapshot_for_result(
                image_path=Path(result.image_path),
                receipt_path=Path(result.receipt_path),
                prompt=prompt,
                elapsed=elapsed,
                fallback_settings=_capture_call_settings(args),
                retrieval_enabled=retrieval_enabled,
            )

    if last_image_path and sys.stdin.isatty():
        _open_path(last_image_path)
    if all_receipts and sys.stdin.isatty():
        choice = input("Open last receipt now? [y/N]: ").strip().lower()
        if choice in {"y", "yes"}:
            _open_path(all_receipts[-1])
            _analyze_receipt(
                all_receipts[-1],
                provider=args.provider,
                model=args.model,
                size=args.size,
                n=args.n,
                out_dir=str(out_dir),
                analyzer=args.analyzer,
            )
            input("\nPress Enter to exit.")
    return 0


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] in {"batch-run", "experiment", "runner"}:
        if sys.argv[1] in {"experiment", "runner"}:
            print("Note: 'experiment' is now 'batch-run'.")
        return _run_experiment_cli(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "view":
        return _run_view_cli(sys.argv[2:])
    parser = argparse.ArgumentParser(
        description="PARAM FORGE: interactive terminal UI for multi-provider image generation + receipts."
    )
    parser.add_argument("--prompt", action="append", help="Prompt text (repeatable)")
    parser.add_argument("--provider", default="openai", help="Provider name")
    parser.add_argument(
        "--analyzer",
        default=None,
        choices=ANALYZER_CHOICES,
        help="Receipt analyzer provider (default: $RECEIPT_ANALYZER or anthropic)",
    )
    parser.add_argument("--size", default="portrait", help="Size (e.g., portrait, 1024x1024, 16:9)")
    parser.add_argument("--n", type=int, default=1, help="Number of images per prompt")
    parser.add_argument(
        "--output-format",
        dest="output_format",
        default=None,
        help="Optional output format (e.g., jpeg, png, webp)",
    )
    parser.add_argument(
        "--background",
        default=None,
        help="Optional background (e.g., transparent or opaque)",
    )
    parser.add_argument(
        "--out",
        default="outputs/param_forge",
        help="Output directory (default: outputs/param_forge)",
    )
    parser.add_argument("--model", default=None, help="Optional model override")
    parser.add_argument(
        "--interactive",
        action="store_true",
        help="Use interactive selector (arrow keys).",
    )
    parser.add_argument(
        "--defaults",
        action="store_true",
        help="Run with defaults without prompting.",
    )
    parser.add_argument(
        "--no-color",
        action="store_true",
        help="Disable ANSI colors in interactive mode.",
    )
    parser.add_argument(
        "--openai-stream",
        action="store_true",
        help="Use OpenAI streaming for gpt-image models.",
    )
    parser.add_argument(
        "--openai-responses",
        action="store_true",
        help="Use OpenAI Responses API for gpt-image models.",
    )
    args = parser.parse_args()
    if args.analyzer:
        os.environ[RECEIPT_ANALYZER_ENV] = args.analyzer
    if args.openai_stream:
        os.environ[OPENAI_STREAM_ENV] = "1"
    if args.openai_responses:
        os.environ[OPENAI_RESPONSES_ENV] = "1"
    if args.interactive or (len(sys.argv) == 1 and not args.defaults):
        color_override = False if args.no_color else None
        try:
            return _run_curses_flow(color_override=color_override)
        except KeyboardInterrupt:
            print("\nCancelled.")
            return 1
    # When using the interactive flow, avoid Gemini by default unless explicitly chosen.
    if getattr(args, "interactive", False) and args.provider == "gemini":
        print("Gemini provider selected; ensure your model + permissions support image generation.")

    return _run_generation(args)


if __name__ == "__main__":
    raise SystemExit(main())
