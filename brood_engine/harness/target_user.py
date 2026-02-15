"""Target user usability harness runtime.

This module provides a practical v0 harness for running scenario packs against
`brood chat` and collecting explicit usability evidence:
- transcript + events tail
- pre/post screenshots at key points
- reaction + pain-point reflections
- aggregate scorecard for each persona/scenario
"""

from __future__ import annotations

import base64
import json
import errno
import os
import platform
import queue
import socket
import shlex
import subprocess
import threading
import time
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from typing import Any
from urllib.error import HTTPError
from urllib.request import Request, urlopen

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover - optional dependency fallback
    Image = ImageDraw = ImageFont = None  # type: ignore[assignment]


TARGET_USER_HARNESS_SCHEMA = "brood.target_user_harness"
TARGET_USER_HARNESS_SCHEMA_VERSION = 1
CHAT_PROCESS_STARTUP_TIMEOUT_S = 20
DEFAULT_DESKTOP_BRIDGE_SOCKET = "/tmp/brood_desktop_bridge.sock"
DEFAULT_SCREENSHOT_CAPTURE_MODE = "auto"
DEFAULT_SCREENSHOT_APP_NAMES = ["Brood", "brood", "brood-desktop"]
ALLOWED_REASONING_EFFORT = {"none", "minimal", "low", "medium", "high", "xhigh"}
ALLOWED_SCREENSHOT_CAPTURE_MODES = {"auto", "source_dir", "synthetic"}
SUPPORTED_UI_ACTION_OPS = {
    "focus_app",
    "click",
    "double_click",
    "drag",
    "keypress",
    "type_text",
    "wait",
    "click_button",
    "mother_next_proposal",
    "mother_confirm_suggestion",
    "mother_reject_suggestion",
    "select_canvas_image",
    "set_canvas_mode",
    "canvas_pan",
    "canvas_zoom",
    "canvas_fit_all",
    "action_grid",
}

AUTOMATION_UI_ACTION_OPS = {
    "mother_next_proposal",
    "mother_confirm_suggestion",
    "mother_reject_suggestion",
    "select_canvas_image",
    "set_canvas_mode",
    "canvas_pan",
    "canvas_zoom",
    "canvas_fit_all",
    "action_grid",
}

AUTOMATION_UI_DEFAULTS = {
    "mother_next_proposal": {
        "settle_ms": 1100,
        "animation_settle_ms": 300,
        "wait_timeout_ms": 8000,
        "pre_wait_timeout_ms": 1800,
        "wait_markers": ["mother_next_proposal_completed"],
        "wait_for_markers": ["mother_next_proposal_completed", "mother_state"],
        "wait_events": ["mother_next_proposal", "mother_state"],
        "wait_for_events": ["mother_next_proposal", "mother_state"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
        "expect_mother_phases": ["intent_hypothesizing", "offering", "drafting", "watching", "observing"],
    },
    "mother_confirm_suggestion": {
        "settle_ms": 1800,
        "animation_settle_ms": 500,
        "wait_timeout_ms": 30000,
        "pre_wait_timeout_ms": 2600,
        "wait_markers": ["mother_confirm_suggestion_completed"],
        "wait_for_markers": ["mother_confirm_suggestion_completed", "mother_state"],
        "wait_events": ["mother_confirm", "mother_state"],
        "wait_for_events": ["mother_confirm", "mother_state"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
        "expect_mother_phases": ["generation_dispatched", "waiting_for_user", "drafting", "intent_hypothesizing"],
    },
    "mother_reject_suggestion": {
        "settle_ms": 1100,
        "animation_settle_ms": 500,
        "wait_timeout_ms": 8000,
        "pre_wait_timeout_ms": 2000,
        "wait_markers": ["mother_reject_suggestion_completed"],
        "wait_for_markers": ["mother_reject_suggestion_completed", "mother_state"],
        "wait_events": ["mother_reject", "mother_state"],
        "wait_for_events": ["mother_reject", "mother_state"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
        "expect_mother_phases": ["cooldown", "intent_hypothesizing", "watching", "observing"],
    },
    "select_canvas_image": {
        "settle_ms": 450,
        "animation_settle_ms": 120,
        "wait_timeout_ms": 2500,
        "pre_wait_timeout_ms": 1200,
        "wait_markers": ["canvas_selection_updated"],
        "wait_for_markers": ["canvas_selection_updated"],
        "wait_events": ["selection_change"],
        "wait_for_events": ["selection_change"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
    },
    "set_canvas_mode": {
        "settle_ms": 260,
        "animation_settle_ms": 80,
        "wait_timeout_ms": 2500,
        "pre_wait_timeout_ms": 1200,
        "wait_markers": ["canvas_mode_changed"],
        "wait_for_markers": ["canvas_mode_changed"],
        "wait_events": ["canvas_mode_set"],
        "wait_for_events": ["canvas_mode_set"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
        "expect_canvas_mode": ["multi", "single"],
    },
    "canvas_pan": {
        "settle_ms": 420,
        "animation_settle_ms": 140,
        "wait_timeout_ms": 2500,
        "pre_wait_timeout_ms": 1200,
        "wait_markers": ["canvas_view_updated"],
        "wait_for_markers": ["canvas_view_updated"],
        "wait_events": ["canvas_view_updated"],
        "wait_for_events": ["canvas_view_updated"],
        "expect_canvas_mode": ["single", "multi"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
    },
    "canvas_zoom": {
        "settle_ms": 420,
        "animation_settle_ms": 140,
        "wait_timeout_ms": 2500,
        "pre_wait_timeout_ms": 1200,
        "wait_markers": ["canvas_view_updated"],
        "wait_for_markers": ["canvas_view_updated"],
        "wait_events": ["canvas_view_updated"],
        "wait_for_events": ["canvas_view_updated"],
        "expect_canvas_mode": ["single", "multi"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
    },
    "canvas_fit_all": {
        "settle_ms": 320,
        "animation_settle_ms": 120,
        "wait_timeout_ms": 2500,
        "pre_wait_timeout_ms": 1200,
        "wait_markers": ["canvas_view_fitted"],
        "wait_for_markers": ["canvas_view_fitted"],
        "wait_events": ["canvas_view_fitted"],
        "wait_for_events": ["canvas_view_fitted"],
        "expect_canvas_mode": ["single", "multi"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
    },
    "action_grid": {
        "settle_ms": 900,
        "animation_settle_ms": 150,
        "wait_timeout_ms": 8000,
        "pre_wait_timeout_ms": 1600,
        "wait_markers": ["action_grid_invoked"],
        "wait_for_markers": ["action_grid_invoked"],
        "wait_events": ["action_grid_press"],
        "wait_for_events": ["action_grid_press"],
        "pre_wait_markers": [],
        "pre_wait_events": [],
    },
}

def _coerce_int_seconds(value: Any, *, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _coerce_float_seconds(value: Any, *, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _as_seq_list(value: Any) -> list[str]:
    out: list[str] = []
    for raw in _safe_list(value):
        try:
            text = str(raw).strip()
        except Exception:
            continue
        if text:
            out.append(text)
    return out


def _normalize_mother_phase(value: str) -> str:
    raw = _safe_str(value).strip().lower()
    if not raw:
        return ""
    return {
        "waiting_for_user": "offering",
        "generation_dispatched": "drafting",
    }.get(raw, raw)


def _safe_wait_ms(value: Any, *, fallback: int) -> int:
    candidate = _safe_int(value, fallback)
    if candidate < 0:
        return fallback
    return candidate

DEFAULT_PAIN_TAXONOMY = [
    "discoverability",
    "intent_ambiguity",
    "setup_friction",
    "error_recovery",
    "control_confidence",
    "speed_timing",
    "sequence_break",
    "output_quality_gap",
    "handoff_confusion",
]

PAIN_IMPROVEMENT_PLAYBOOK: dict[str, dict[str, str]] = {
    "discoverability": {
        "title": "Add contextual next-step guidance",
        "proposal": "Show suggested next commands and recipes after each turn based on latest events and screenshot state.",
        "metric": "Decrease turns with no-op or wrong command attempts.",
    },
    "intent_ambiguity": {
        "title": "Provide intent templates at input time",
        "proposal": "Offer inline prompt/command templates for common tasks (diagnose, compare, blend, extract) with concrete examples.",
        "metric": "Increase first-try successful actions per scenario.",
    },
    "setup_friction": {
        "title": "Reduce setup overhead",
        "proposal": "Auto-detect likely primary input and prefill /use context; add clearer setup checkpoints.",
        "metric": "Reduce time-to-first-valid-artifact.",
    },
    "error_recovery": {
        "title": "Improve error recovery paths",
        "proposal": "After failure events, show explicit recovery actions and one-click retry variants with safer defaults.",
        "metric": "Reduce consecutive failure streaks and abandonment.",
    },
    "control_confidence": {
        "title": "Strengthen output confidence signals",
        "proposal": "Add side-by-side comparisons and acceptance checks for identity, quality, and fidelity.",
        "metric": "Improve selection confidence in reflection records.",
    },
    "speed_timing": {
        "title": "Tighten latency feedback",
        "proposal": "Surface progress stages and expected duration bands; provide quick-mode alternatives when latency spikes.",
        "metric": "Reduce frustration notes tied to wait time.",
    },
    "sequence_break": {
        "title": "Introduce guided multi-step flows",
        "proposal": "Provide optional guided flow states for common sequences like diagnose -> generate -> compare.",
        "metric": "Increase completion rate for scenarios requiring multiple abilities.",
    },
    "output_quality_gap": {
        "title": "Add quality guardrails",
        "proposal": "Preflight prompt/context quality checks and suggest better references before expensive generation.",
        "metric": "Increase artifact acceptance rate and reduce retries.",
    },
    "handoff_confusion": {
        "title": "Improve completion handoff clarity",
        "proposal": "Generate explicit end-of-run summaries with recommended next actions and selected output rationale.",
        "metric": "Reduce unresolved open questions at scenario end.",
    },
}

TEN_X_PLAYBOOK: dict[str, dict[str, str]] = {
    "discoverability": {
        "feature": "Context-aware next-step copilot",
        "problem": "Users lose momentum deciding which action to run next.",
        "ten_x": "Removes trial-and-error loops and makes complex flows feel guided, not guessy.",
    },
    "intent_ambiguity": {
        "feature": "Task-to-command translator with reusable templates",
        "problem": "Users cannot reliably convert goals into high-quality commands/prompts.",
        "ten_x": "Improves first-attempt success and lowers skill barrier for advanced capabilities.",
    },
    "setup_friction": {
        "feature": "Zero-friction setup bootstrap",
        "problem": "Import and context setup overhead delays useful output.",
        "ten_x": "Cuts time-to-first-result dramatically for repeated production workflows.",
    },
    "error_recovery": {
        "feature": "Failure-aware guided recovery paths",
        "problem": "Failures require manual debugging and expensive retries.",
        "ten_x": "Turns failures into deterministic next actions and minimizes wasted runs.",
    },
    "control_confidence": {
        "feature": "Automated quality acceptance checks",
        "problem": "Users are uncertain whether outputs are safe to ship.",
        "ten_x": "Provides confidence gates that reduce subjective review churn.",
    },
    "speed_timing": {
        "feature": "Latency-adaptive execution modes",
        "problem": "Slow or variable turn times break flow and trust.",
        "ten_x": "Maintains flow via explicit ETA, fallback quality tiers, and quicker alternatives.",
    },
    "sequence_break": {
        "feature": "Composable workflow recipes",
        "problem": "Multi-step tasks fail when users miss required sequence constraints.",
        "ten_x": "Packages expert flows into reusable recipes with fewer dead-end turns.",
    },
    "output_quality_gap": {
        "feature": "Preflight quality guardrails and reference fitness checks",
        "problem": "Generated outputs miss quality bar, causing repetitive retries.",
        "ten_x": "Improves output hit rate while reducing generation cost and time.",
    },
    "handoff_confusion": {
        "feature": "Decision-ready run handoff summaries",
        "problem": "Teams do not know what to ship next after exploration.",
        "ten_x": "Converts exploration into actionable decisions for product and design stakeholders.",
    },
}

BROOD_DEFENSIBLE_FEATURES = [
    "Reproducible run artifacts (events, receipts, manifests) that make failures auditable.",
    "Screenshot-coupled usability evidence per turn instead of hidden rationale.",
    "Multi-provider execution with cost/latency observability for production tradeoff decisions.",
    "Ability-driven workflow model that can be standardized into team recipes.",
]

ALLOWED_ACTION_ABILITIES = {
    "diagnose",
    "describe",
    "canvas_context",
    "recast",
    "blend",
    "argue",
    "extract_rule",
    "odd_one_out",
    "triforce",
    "bridge",
    "swap_dna",
    "quality",
    "fast",
    "cheaper",
    "better",
    "use",
}

ARTIFACT_GENERATION_VERBS = {
    "/recast",
    "/blend",
    "/swap_dna",
    "/bridge",
    "/triforce",
}

REQUIRED_COMMAND_ARGS = {
    "describe": 1,
    "canvas_context": 1,
    "diagnose": 1,
    "recast": 1,
    "blend": 2,
    "swap_dna": 2,
    "argue": 2,
    "bridge": 2,
    "odd_one_out": 3,
    "extract_rule": 3,
    "triforce": 3,
    "use": 1,
}

SUCCESS_EVENT_BY_VERB: dict[str, set[str]] = {
    "describe": {"image_description"},
    "canvas_context": {"canvas_context"},
    "diagnose": {"image_diagnosis"},
    "argue": {"image_argument"},
    "extract_rule": {"triplet_rule"},
    "odd_one_out": {"triplet_odd_one_out"},
    "recast": {"artifact_created"},
    "blend": {"artifact_created"},
    "swap_dna": {"artifact_created"},
    "bridge": {"artifact_created"},
    "triforce": {"artifact_created"},
}

FAIL_EVENT_BY_VERB: dict[str, set[str]] = {
    "describe": {"image_description_failed"},
    "canvas_context": {"canvas_context_failed"},
    "diagnose": {"image_diagnosis_failed"},
    "argue": {"image_argument_failed"},
    "extract_rule": {"triplet_rule_failed"},
    "odd_one_out": {"triplet_odd_one_out_failed"},
    "recast": {"generation_failed"},
    "blend": {"generation_failed"},
    "swap_dna": {"generation_failed"},
    "bridge": {"generation_failed"},
    "triforce": {"generation_failed"},
}


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def _slug(value: str, fallback: str = "run") -> str:
    import re

    base = re.sub(r"[^a-z0-9]+", "-", str(value).strip().lower())
    base = "-".join(part for part in base.split("-") if part)
    return base[:64] or fallback


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _safe_bool(value: Any, default: bool = False) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "y", "on"}
    return default


def _safe_str(value: Any, default: str = "") -> str:
    text = "" if value is None else str(value)
    return text if text else default


def _safe_list(value: Any) -> list[Any]:
    if not isinstance(value, list):
        return []
    return [v for v in value if v is not None]


def _safe_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _normalize_screenshot_capture_mode(value: Any) -> str:
    mode = _safe_str(value, DEFAULT_SCREENSHOT_CAPTURE_MODE).strip().lower()
    return mode if mode in ALLOWED_SCREENSHOT_CAPTURE_MODES else DEFAULT_SCREENSHOT_CAPTURE_MODE


def _normalize_reasoning_effort(value: Any, default: str | None = None) -> str | None:
    candidate = _safe_str(value, "").strip().lower()
    if candidate in ALLOWED_REASONING_EFFORT:
        return candidate
    return _safe_str(default, None) if _safe_str(default, "").strip().lower() in ALLOWED_REASONING_EFFORT else None


def _resolve_panel_model_alias(model: str | None) -> tuple[str | None, str | None]:
    raw_model = _safe_str(model, "").strip()
    if not raw_model:
        return None, None
    lowered = raw_model.lower()
    if lowered.endswith("-thinking") and len(raw_model) > len("-thinking"):
        return raw_model[: -len("-thinking")], "high"
    return raw_model, None


def _effective_reasoning_effort_for_model(
    model: str | None,
    effort: str | None,
    *,
    default: str | None = "low",
) -> str | None:
    candidate = _normalize_reasoning_effort(effort, default)
    if not candidate:
        return None
    normalized = candidate.strip().lower()
    if normalized == "minimal":
        normalized = "low"
    supported = {"none", "low", "medium", "high", "xhigh"}
    if normalized not in supported:
        return "low"
    return normalized


def _is_reasoning_effort_unsupported_error(status: int, response: dict[str, Any]) -> bool:
    if int(status) != 400:
        return False
    error_obj = _safe_dict(response.get("error"))
    param = _safe_str(error_obj.get("param"), "").strip().lower()
    if param == "reasoning.effort":
        return True
    message = _safe_str(error_obj.get("message"), "").strip().lower()
    if not message:
        message = _safe_str(response.get("_http_error_body"), "").strip().lower()
    if "reasoning.effort" in message:
        return True
    return "unsupported value" in message and "reasoning" in message and "effort" in message


def _normalize_app_names(value: Any) -> list[str]:
    if isinstance(value, str):
        names = [part.strip() for part in value.split(",")]
        return [name for name in names if name]
    names = [str(item).strip() for item in _safe_list(value) if str(item).strip()]
    return names or list(DEFAULT_SCREENSHOT_APP_NAMES)


def _resolve_file_path(raw: str, *, base_dir: Path | None = None) -> Path:
    path = Path(raw).expanduser()
    if path.exists():
        return path
    if path.is_absolute() or base_dir is None:
        return path
    candidate = base_dir / path
    if candidate.exists():
        return candidate
    return path


def _read_text_file(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8").strip()
    except Exception:
        return None


def _append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _read_events_delta(path: Path, offset: int) -> tuple[list[dict[str, Any]], int]:
    if not path.exists():
        return [], offset
    with path.open("rb") as handle:
        handle.seek(offset)
        payload = handle.read()
    if not payload:
        return [], offset
    raw = payload.decode("utf-8", errors="ignore")
    events: list[dict[str, Any]] = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue
        if isinstance(event, dict):
            events.append(event)
    return events, offset + len(payload)


def _extract_event_types(events: list[dict[str, Any]]) -> list[str]:
    return [str(event.get("type") or "") for event in events if isinstance(event, dict)]


def _extract_artifacts_from_events(events: list[dict[str, Any]]) -> list[str]:
    out: list[str] = []
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("type") or "")
        if event_type == "artifact_created":
            path = event.get("image_path")
            if isinstance(path, str) and path.strip():
                out.append(path.strip())
    return out


def _extract_cost_updates(events: list[dict[str, Any]]) -> float:
    total = 0.0
    for event in events:
        if not isinstance(event, dict):
            continue
        if event.get("type") != "cost_latency_update":
            continue
        value = event.get("cost_total_usd")
        if isinstance(value, (int, float)):
            total += float(value)
    return total


def _normalize_scene_inputs(inputs: Any) -> list[Path]:
    paths: list[Path] = []
    for item in _safe_list(inputs):
        if isinstance(item, str):
            candidate = str(item)
        elif isinstance(item, dict):
            candidate = str(item.get("path") or "")
        else:
            continue
        candidate = candidate.strip()
        if candidate:
            paths.append(Path(candidate).expanduser())
    return paths


def _action_to_cli(action: dict[str, Any], default_paths: list[Path]) -> str:
    kind = str(action.get("kind") or "").strip().lower()
    if kind == "utterance":
        return str(action.get("text") or "").strip()

    if kind != "command":
        return ""

    command = _safe_dict(action.get("command"))
    name = _safe_str(command.get("name"), "").strip()
    if not name:
        return ""
    if name not in ALLOWED_ACTION_ABILITIES:
        return ""
    if name in {"quality", "fast", "cheaper", "better", "use"}:
        if name == "use":
            paths = _normalize_scene_inputs(command.get("paths") or [])
            if not paths:
                paths = default_paths[:1]
            if not paths:
                return ""
            return f"/use {shlex.quote(str(paths[0]))}"
        return f"/{name}"

    paths = _normalize_scene_inputs(command.get("paths") or [])
    if not paths:
        paths = default_paths[:]

    required = REQUIRED_COMMAND_ARGS.get(name, 0)
    if required and not paths:
        return ""
    selected = [shlex.quote(str(item)) for item in paths[: max(0, required)]]
    args = command.get("args")
    extra: list[str] = []
    if isinstance(args, dict):
        for key, value in args.items():
            if value is None:
                continue
            if isinstance(value, list):
                for entry in value:
                    extra.append(f"--{str(key)} {shlex.quote(str(entry))}")
            else:
                extra.append(f"--{str(key)} {shlex.quote(str(value))}")
    if required > len(selected):
        return ""
    return f"/{name} " + " ".join(selected[:required] + extra)


def _action_to_queue_item(action: dict[str, Any], default_paths: list[Path]) -> dict[str, Any] | None:
    kind = str(action.get("kind") or "").strip().lower()
    if kind in {"utterance", "command"}:
        line = _action_to_cli(action, default_paths)
        if not line:
            return None
        return {"kind": "chat", "input": line}
    if kind != "ui":
        return None

    payload = action.get("ui")
    if not isinstance(payload, dict):
        payload = dict(action)
        payload.pop("kind", None)
        payload.pop("reason", None)
        payload.pop("expects", None)
    op = _safe_str(_safe_dict(payload).get("op"), "").strip().lower()
    if not op or op not in SUPPORTED_UI_ACTION_OPS:
        return None
    return {"kind": "ui", "ui": _safe_dict(payload)}


def _ui_action_label(payload: dict[str, Any]) -> str:
    op = _safe_str(payload.get("op"), "ui").strip().lower() or "ui"
    def _fmt_num(value: Any) -> str:
        if isinstance(value, (int, float)):
            try:
                number = float(value)
            except Exception:
                return str(value)
            if number.is_integer():
                return str(int(number))
            return str(round(number, 4))
        return str(value)

    if op in {"mother_next_proposal", "mother_confirm_suggestion", "mother_reject_suggestion"}:
        return f"[ui:{op}]"
    if op == "select_canvas_image":
        image_id = _safe_str(payload.get("image_id"), "").strip()
        image_index = _safe_int(payload.get("image_index"), -1)
        if image_id:
            return f"[ui:{op}] {image_id}"
        if image_index >= 0:
            return f"[ui:{op}] index={image_index}"
        return f"[ui:{op}]"
    if op == "set_canvas_mode":
        mode = _safe_str(payload.get("mode"), "").strip().lower()
        if mode:
            return f"[ui:{op}] {mode}"
        return f"[ui:{op}]"
    if op == "canvas_pan":
        dx = payload.get("dx")
        dy = payload.get("dy")
        if isinstance(dx, (int, float)) and isinstance(dy, (int, float)):
            return f"[ui:{op}] ({_fmt_num(dx)}, {_fmt_num(dy)})"
        return f"[ui:{op}]"
    if op == "canvas_zoom":
        scale = payload.get("scale")
        factor = payload.get("factor")
        if isinstance(scale, (int, float)):
            return f"[ui:{op}] scale={_fmt_num(scale)}"
        if isinstance(factor, (int, float)):
            return f"[ui:{op}] factor={_fmt_num(factor)}"
        return f"[ui:{op}]"
    if op == "canvas_fit_all":
        mode = _safe_str(payload.get("mode"), "").strip().lower()
        if mode:
            return f"[ui:{op}] {mode}"
        return f"[ui:{op}]"
    if op == "action_grid":
        key = _safe_str(payload.get("key"), "").strip().lower()
        hotkey = _safe_str(payload.get("hotkey"), "").strip()
        if key:
            return f"[ui:{op}] {key}"
        if hotkey:
            return f"[ui:{op}] hotkey={hotkey}"
    if op in {"click", "double_click"}:
        x = payload.get("x")
        y = payload.get("y")
        if isinstance(x, (int, float)) and isinstance(y, (int, float)):
            return f"[ui:{op}] ({round(float(x), 4)}, {round(float(y), 4)})"
    if op == "drag":
        x = payload.get("x")
        y = payload.get("y")
        x2 = payload.get("x2")
        y2 = payload.get("y2")
        if all(isinstance(value, (int, float)) for value in (x, y, x2, y2)):
            return (
                f"[ui:drag] ({round(float(x), 4)}, {round(float(y), 4)}) -> "
                f"({round(float(x2), 4)}, {round(float(y2), 4)})"
            )
    if op == "click_button":
        name = _safe_str(payload.get("name"), "")
        if name:
            return f"[ui:click_button] {name}"
    if op == "keypress":
        keys = payload.get("keys")
        if isinstance(keys, list):
            joined = "+".join(str(value).strip() for value in keys if str(value).strip())
            if joined:
                return f"[ui:keypress] {joined}"
    return f"[ui:{op}]"


def _ui_automation_wait_plan(op: str, payload: dict[str, Any]) -> dict[str, Any]:
    defaults = _safe_dict(AUTOMATION_UI_DEFAULTS.get(op, {}))
    settle_ms = _safe_int(
        payload.get("settle_ms"),
        _safe_int(defaults.get("settle_ms"), 0),
    )
    animation_settle_ms = _safe_int(
        payload.get("animation_settle_ms"),
        _safe_int(defaults.get("animation_settle_ms"), 0),
    )
    pre_wait_timeout_ms = _safe_int(
        payload.get("pre_wait_timeout_ms"),
        _safe_int(defaults.get("pre_wait_timeout_ms"), 1600),
    )
    wait_timeout_ms = _safe_int(
        payload.get("wait_timeout_ms"),
        _safe_int(defaults.get("wait_timeout_ms"), _safe_int(defaults.get("wait_for_timeout_ms"), 5000)),
    )
    raw_wait_markers = _as_seq_list(payload.get("wait_markers"))
    raw_wait_markers.extend(_as_seq_list(defaults.get("wait_markers")))
    raw_wait_markers.extend(_as_seq_list(payload.get("wait_for_markers")))
    raw_wait_markers.extend(_as_seq_list(defaults.get("wait_for_markers")))
    wait_markers = [
        _safe_str(value).strip().lower()
        for value in raw_wait_markers
        if _safe_str(value).strip()
    ]
    wait_markers = list(dict.fromkeys(wait_markers))

    raw_wait_events = _as_seq_list(payload.get("wait_events"))
    raw_wait_events.extend(_as_seq_list(defaults.get("wait_events")))
    raw_wait_events.extend(_as_seq_list(payload.get("wait_for_events")))
    raw_wait_events.extend(_as_seq_list(defaults.get("wait_for_events")))
    wait_events = [
        _safe_str(value).strip().lower()
        for value in raw_wait_events
        if _safe_str(value).strip()
    ]
    wait_events = list(dict.fromkeys(wait_events))

    raw_pre_wait_markers = _as_seq_list(payload.get("pre_wait_markers"))
    raw_pre_wait_markers.extend(_as_seq_list(payload.get("pre_wait_for_markers")))
    raw_pre_wait_markers.extend(_as_seq_list(defaults.get("pre_wait_markers")))
    raw_pre_wait_markers.extend(_as_seq_list(defaults.get("pre_wait_for_markers")))
    pre_wait_markers = [
        _safe_str(value).strip().lower()
        for value in raw_pre_wait_markers
        if _safe_str(value).strip()
    ]
    pre_wait_markers = list(dict.fromkeys(pre_wait_markers))

    raw_pre_wait_events = _as_seq_list(payload.get("pre_wait_events"))
    raw_pre_wait_events.extend(_as_seq_list(payload.get("pre_wait_for_events")))
    raw_pre_wait_events.extend(_as_seq_list(defaults.get("pre_wait_events")))
    raw_pre_wait_events.extend(_as_seq_list(defaults.get("pre_wait_for_events")))
    pre_wait_events = [
        _safe_str(value).strip().lower()
        for value in raw_pre_wait_events
        if _safe_str(value).strip()
    ]
    pre_wait_events = list(dict.fromkeys(pre_wait_events))

    raw_expect_mother_phases = _as_seq_list(defaults.get("expect_mother_phases"))
    raw_expect_mother_phases.extend(_as_seq_list(payload.get("expect_mother_phases")))
    expect_mother_phases = [
        _safe_str(value).strip().lower()
        for value in raw_expect_mother_phases
        if _safe_str(value).strip()
    ]
    expect_mother_phases = [
        _normalize_mother_phase(value)
        for value in expect_mother_phases
        if _normalize_mother_phase(value)
    ]

    raw_expect_canvas_mode = _as_seq_list(defaults.get("expect_canvas_mode"))
    raw_expect_canvas_mode.extend(_as_seq_list(payload.get("expect_canvas_mode")))
    expect_canvas_mode = [
        _safe_str(value).strip().lower()
        for value in raw_expect_canvas_mode
        if _safe_str(value).strip()
    ]

    return {
        "settle_ms": max(0, settle_ms),
        "animation_settle_ms": max(0, animation_settle_ms),
        "pre_wait_timeout_ms": max(200, pre_wait_timeout_ms),
        "wait_timeout_ms": max(200, wait_timeout_ms),
        "wait_markers": wait_markers,
        "wait_events": wait_events,
        "pre_wait_markers": pre_wait_markers,
        "pre_wait_events": pre_wait_events,
        "expect_mother_phases": expect_mother_phases,
        "expect_canvas_mode": expect_canvas_mode,
    }


def _action_for_required_ability(
    ability: str,
    input_paths: list[Path],
) -> str:
    name = str(ability).strip().lower()
    if not name:
        return ""
    if name in {"quality", "fast", "cheaper", "better"}:
        return f"/{name}"
    if name == "use":
        return f"/use {shlex.quote(str(input_paths[0]))}" if input_paths else ""

    required = REQUIRED_COMMAND_ARGS.get(name, 1)
    if required > len(input_paths):
        return ""
    if required == 1:
        return f"/{name} {shlex.quote(str(input_paths[0]))}"
    if required == 2:
        return f"/{name} {shlex.quote(str(input_paths[0]))} {shlex.quote(str(input_paths[1]))}"
    return (
        f"/{name} "
        f"{shlex.quote(str(input_paths[0]))} "
        f"{shlex.quote(str(input_paths[1]))} "
        f"{shlex.quote(str(input_paths[2]))}"
    )


def _expected_fail_event_names(command: str) -> set[str]:
    normalized = command.strip().lower()
    if not normalized.startswith("/"):
        return set()
    verb = normalized.split(maxsplit=1)[0].lstrip("/")
    if not verb:
        return set()
    mapped = FAIL_EVENT_BY_VERB.get(verb)
    if mapped:
        return set(mapped)
    return {f"{verb}_failed", "generation_failed"}


def _expected_success_event_names(command: str) -> set[str]:
    normalized = command.strip().lower()
    if not normalized.startswith("/"):
        return set()
    verb = normalized.split(maxsplit=1)[0].lstrip("/")
    if not verb:
        return set()
    mapped = SUCCESS_EVENT_BY_VERB.get(verb)
    return set(mapped) if mapped else set()


LOW_SIGNAL_COMMAND_VERBS = {"fast", "quality", "better", "cheaper", "argue"}


def _command_verb(action: str) -> str:
    normalized = action.strip().lower()
    if not normalized.startswith("/"):
        return ""
    return normalized.split(maxsplit=1)[0].lstrip("/")


def _build_pain_points(
    *,
    action: str,
    events: list[dict[str, Any]],
    duration_s: float,
    consecutive_failures: int,
) -> list[dict[str, Any]]:
    event_types = set(_extract_event_types(events))
    artifacts = _extract_artifacts_from_events(events)
    pain: list[dict[str, Any]] = []

    verb = _command_verb(action)
    if not event_types and action.startswith("/") and verb not in LOW_SIGNAL_COMMAND_VERBS:
        pain.append(
            {
                "category": "intent_ambiguity",
                "severity": 0.64,
                "symptom": "No events came back from the app after this action.",
                "evidence": [action],
                "likely_cause": "unclear command path or tool-state mismatch",
            }
        )
    if any(et.endswith("_failed") for et in event_types):
        pain.append(
            {
                "category": "error_recovery",
                "severity": 0.82,
                "symptom": "Command hit a hard failure and returned an error event.",
                "evidence": sorted(event_types),
                "likely_cause": "provider/tooling mismatch or unavailable input state",
            }
        )
    if action.startswith("/") and action.split(maxsplit=1)[0] in ARTIFACT_GENERATION_VERBS and not artifacts:
        pain.append(
            {
                "category": "output_quality_gap",
                "severity": 0.68,
                "symptom": "Action produced no image output event.",
                "evidence": sorted(event_types),
                "likely_cause": "source imagery may not be set or model could not return an artifact",
            }
        )
    if duration_s > 45:
        pain.append(
            {
                "category": "speed_timing",
                "severity": min(1.0, duration_s / 180.0),
                "symptom": "The turn is taking long relative to expectation.",
                "evidence": [f"duration_s={round(duration_s, 2)}"],
                "likely_cause": "provider queueing or heavy model latency",
            }
        )
    if consecutive_failures >= 2:
        pain.append(
            {
                "category": "sequence_break",
                "severity": 0.6,
                "symptom": "Repeated failures indicate the workflow got stuck.",
                "evidence": [f"consecutive_failures={consecutive_failures}"],
                "likely_cause": "stateful workflow assumptions were not satisfied",
            }
        )
    return pain


class ChatCLIAdapter:
    """Adapter that drives a long-running `python -m brood_engine.cli chat` process."""

    def __init__(
        self,
        *,
        run_dir: Path,
        text_model: str,
        image_model: str,
        events_path: Path,
        startup_timeout_s: int = CHAT_PROCESS_STARTUP_TIMEOUT_S,
        command_timeout_s: int = 120,
    ) -> None:
        self.run_dir = run_dir
        self.text_model = text_model
        self.image_model = image_model
        self.events_path = events_path
        self.startup_timeout_s = startup_timeout_s
        self.command_timeout_s = command_timeout_s
        self.events_offset = 0
        self._proc: subprocess.Popen[str] | None = None
        self._out_queue: queue.Queue[str | None] = queue.Queue()
        self._drainer: threading.Thread | None = None

    def start(self) -> None:
        self.run_dir.mkdir(parents=True, exist_ok=True)
        command = [
            "python",
            "-m",
            "brood_engine.cli",
            "chat",
            "--out",
            str(self.run_dir),
            "--events",
            str(self.events_path),
            "--text-model",
            self.text_model,
            "--image-model",
            self.image_model,
        ]
        self._proc = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        if self._proc.stdout is None:
            raise RuntimeError("Chat subprocess started without stdout pipe.")
        self._drainer = threading.Thread(target=self._drain_stdout, daemon=True)
        self._drainer.start()
        if not self._wait_for_prompt(timeout_s=self.startup_timeout_s):
            if self._proc.poll() is not None:
                raise RuntimeError("Chat subprocess exited before becoming ready.")
            # In non-tty subprocess mode the interactive prompt is not always visible.
            # If the process is alive, continue and use event/output activity to detect turn completion.

    def stop(self) -> None:
        if self._proc is None:
            return
        if self._proc.stdin:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
        try:
            self._proc.terminate()
        except Exception:
            pass
        try:
            self._proc.wait(timeout=5)
        except Exception:
            try:
                self._proc.kill()
            except Exception:
                pass
        self._proc = None

    def prepare_inputs(self, input_paths: list[Path], *, base_dir: Path | None = None) -> list[str]:
        del input_paths, base_dir
        return []

    def run_ui_action(self, action: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]], float, bool, bool]:
        event = {
            "type": "ui_action_failed",
            "reason": "ui actions require --adapter desktop_ui",
            "action": _safe_dict(action),
            "source": "target_user_harness",
            "ts": _utc_now_iso(),
        }
        return [], [event], 0.0, True, False

    def run_turn(self, user_input: str) -> tuple[list[str], list[dict[str, Any]], float, bool, bool]:
        if self._proc is None or self._proc.stdin is None:
            raise RuntimeError("Chat adapter not running.")

        pre_events: list[dict[str, Any]] = []
        pre_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
        del pre_events

        if not user_input.endswith("\n"):
            user_input = f"{user_input}\n"
        started = time.monotonic()
        self._proc.stdin.write(user_input)
        self._proc.stdin.flush()

        assistant_lines: list[str] = []
        collected_events: list[dict[str, Any]] = []
        timed_out = False
        prompt_returned = False
        synthetic_complete = False
        process_ended = False
        terminal_event_seen = False
        terminal_event_types = {
            "artifact_created",
            "generation_failed",
            "image_description",
            "image_description_failed",
            "image_diagnosis",
            "image_diagnosis_failed",
            "canvas_context",
            "canvas_context_failed",
            "triplet_rule",
            "triplet_rule_failed",
        }
        last_signal_ts = started
        deadline = started + self.command_timeout_s
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                line = self._out_queue.get(timeout=min(0.5, max(0.01, remaining)))
            except queue.Empty:
                line = None
            if line is None:
                if self._proc.poll() is not None:
                    process_ended = True
                    break
            else:
                assistant_lines.append(line)
                last_signal_ts = time.monotonic()
                if line.startswith("> "):
                    prompt_returned = True
                    break

            delta_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
            if delta_events:
                collected_events.extend(delta_events)
                last_signal_ts = time.monotonic()
                for event in delta_events:
                    if not isinstance(event, dict):
                        continue
                    event_type = _safe_str(event.get("type"), "").strip().lower()
                    if event_type in terminal_event_types or event_type.endswith("_failed"):
                        terminal_event_seen = True

            idle_window_s = time.monotonic() - last_signal_ts
            if terminal_event_seen and idle_window_s >= 2.5 and self._proc.poll() is None:
                synthetic_complete = True
                break

        duration_s = time.monotonic() - started
        if not prompt_returned and not synthetic_complete:
            timed_out = True
        post_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
        if collected_events:
            post_events = [*collected_events, *post_events]
        if process_ended and not post_events and not assistant_lines:
            timed_out = True
        prompt_returned = prompt_returned or synthetic_complete
        return assistant_lines, post_events, duration_s, prompt_returned, timed_out

    def _drain_stdout(self) -> None:
        if self._proc is None or self._proc.stdout is None:
            return
        for raw in self._proc.stdout:
            self._out_queue.put(raw.rstrip("\n"))
        self._out_queue.put(None)

    def _wait_for_prompt(self, timeout_s: int) -> bool:
        if self._proc is None:
            return False
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._proc.poll() is not None:
                return False
            timeout = max(0.0, deadline - time.monotonic())
            try:
                line = self._out_queue.get(timeout=min(0.5, timeout))
            except queue.Empty:
                continue
            if line is None:
                return False
            if line.startswith("> "):
                return True
        return False


class DesktopUIAdapter:
    """Adapter that writes commands into a running Brood desktop PTY via local socket bridge."""

    def __init__(
        self,
        *,
        bridge_socket: str | None = None,
        events_path: Path | None = None,
        app_names: list[str] | None = None,
        startup_timeout_s: int = CHAT_PROCESS_STARTUP_TIMEOUT_S,
        command_timeout_s: int = 120,
    ) -> None:
        self.bridge_socket = Path(
            _safe_str(
                bridge_socket,
                os.getenv("BROOD_DESKTOP_BRIDGE_SOCKET") or DEFAULT_DESKTOP_BRIDGE_SOCKET,
            )
        ).expanduser()
        self.events_path = events_path
        self.app_names = _normalize_app_names(app_names)
        self.run_dir: Path | None = None
        self.startup_timeout_s = startup_timeout_s
        self.command_timeout_s = command_timeout_s
        self.events_offset = 0

    def _bridge_path_validation_error(self) -> str | None:
        socket_path = str(self.bridge_socket)
        if not self.bridge_socket.exists():
            return (
                f"socket not found at {socket_path}. "
                "Start Brood desktop and wait for the bridge to bind."
            )
        try:
            is_socket = self.bridge_socket.is_socket()
        except Exception as exc:  # pragma: no cover - environment-level IO failure
            return f"unable to validate bridge socket path {socket_path}: {exc}"
        if not is_socket:
            return (
                f"path exists at {socket_path} but is not a unix socket. "
                "Remove any stale file at this path and relaunch Brood."
            )
        return None

    def start(self) -> None:
        socket_path = str(self.bridge_socket)
        validation_error = self._bridge_path_validation_error()
        if validation_error:
            raise RuntimeError(f"Desktop bridge is not ready: {validation_error} (socket={socket_path})")
        deadline = time.monotonic() + max(1, self.startup_timeout_s)
        last_error = ""
        last_state = ""
        ready_cycles = 0
        started_at = time.monotonic()
        while time.monotonic() < deadline:
            if not self.bridge_socket.exists():
                last_error = f"socket missing: {socket_path}"
                last_state = "socket_not_found"
                time.sleep(0.25)
                continue
            validation_error = self._bridge_path_validation_error()
            if validation_error:
                last_error = validation_error
                last_state = "socket_invalid"
                break

            try:
                status = self._status(request_timeout_ms=900)
            except Exception as exc:
                last_error = str(exc)
                ready_cycles = 0
                time.sleep(0.25)
                continue

            running = _safe_bool(status.get("running"), False)
            run_dir = _safe_str(status.get("run_dir"), "").strip()
            events_path = _safe_str(status.get("events_path"), "").strip()
            automation_ready = _safe_bool(status.get("automation_frontend_ready"), False)
            last_state = (
                f"status.running={running}; run_dir={run_dir or '<missing>'}; "
                f"events_path={events_path or '<missing>'}; "
                f"automation_frontend_ready={automation_ready}; "
                f"ready_cycles={ready_cycles}"
            )
            ready_cycles = ready_cycles + 1 if running else 0

            if running:
                if not automation_ready:
                    last_error = (
                        "desktop automation frontend handler not ready yet; waiting for ready handshake"
                    )
                    last_state = (
                        f"status.running={running}; run_dir={run_dir or '<missing>'}; "
                        f"events_path={events_path or '<missing>'}; "
                        f"automation_frontend_ready={automation_ready}; "
                        f"ready_cycles={ready_cycles}"
                    )
                    time.sleep(0.25)
                    continue
                raw_run_dir = _safe_str(status.get("run_dir"), "").strip()
                if raw_run_dir:
                    self.run_dir = Path(raw_run_dir).expanduser()
                raw_events = _safe_str(status.get("events_path"), "").strip()
                if self.events_path is None and raw_events:
                    self.events_path = Path(raw_events).expanduser()
                elif self.events_path is None and self.run_dir is not None:
                    self.events_path = self.run_dir / "events.jsonl"

                if self.events_path is not None and self._ensure_events_path(self.events_path):
                    return
                last_error = (
                    "running bridge did not expose a usable events stream; "
                    f"socket={socket_path} run_dir={raw_run_dir or '<missing>'} events_path={raw_events or '<missing>'}"
                )
                last_state = (
                    "running but events stream unavailable; "
                    f"socket={socket_path} run_dir={raw_run_dir or '<missing>'} "
                    f"events_path={raw_events or '<missing>'}"
                )
            else:
                if not running:
                    last_error = "bridge status indicates process not running yet"
                    last_state = (
                        f"status.running={running}; run_dir={run_dir or '<missing>'}; "
                        f"events_path={events_path or '<missing>'}; ready_cycles={ready_cycles}"
                    )
            time.sleep(0.25)
        if not self.bridge_socket.exists():
            raise RuntimeError(
                "Desktop bridge socket not found. "
                f"Expected: {socket_path}. "
                "Start Brood desktop and keep the bridge running before launching the harness."
            )
        elapsed_s = round(time.monotonic() - started_at, 1)
        detail = f"last_error={last_error}; last_state={last_state}" if last_error else f"last_state={last_state}"
        raise RuntimeError(
            "Desktop bridge is not ready for automation. "
            f"Socket: {socket_path}. "
            f"Waited {elapsed_s}s. "
            f"{detail}. "
            "Ensure Brood desktop is running, the PTY is connected, and you can see 'Engine: ready' in-app."
        )

    def _ensure_events_path(self, events_path: Path) -> bool:
        try:
            events_path.parent.mkdir(parents=True, exist_ok=True)
            with events_path.open("a", encoding="utf-8"):
                pass
            return True
        except Exception:
            return False

    def stop(self) -> None:
        return

    def prepare_inputs(self, input_paths: list[Path], *, base_dir: Path | None = None) -> list[str]:
        if self.events_path is None:
            return []
        seeded: list[str] = []
        ts = _utc_now_iso()
        nonce = int(time.time() * 1000)
        try:
            self.events_path.parent.mkdir(parents=True, exist_ok=True)
            with self.events_path.open("a", encoding="utf-8") as handle:
                for idx, raw_path in enumerate(input_paths):
                    resolved = _resolve_file_path(str(raw_path), base_dir=base_dir)
                    try:
                        exists = resolved.exists()
                        is_file = resolved.is_file()
                    except Exception:
                        exists = False
                        is_file = False
                    if not exists or not is_file:
                        continue
                    try:
                        image_path = str(resolved.resolve())
                    except Exception:
                        image_path = str(resolved)
                    event = {
                        "type": "artifact_created",
                        "artifact_id": f"harness-input-{nonce}-{idx:02d}",
                        "image_path": image_path,
                        "ts": ts,
                        "source": "target_user_harness",
                    }
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
                    seeded.append(image_path)
        except Exception:
            return []
        if seeded:
            # Desktop polls events every ~250ms; give it a brief window to ingest seeds.
            time.sleep(0.6)
        return seeded

    def run_ui_action(self, action: dict[str, Any]) -> tuple[list[str], list[dict[str, Any]], float, bool, bool]:
        action_payload = _safe_dict(action)
        if self.events_path is not None:
            _, self.events_offset = _read_events_delta(self.events_path, self.events_offset)

        started = time.monotonic()
        op = _safe_str(action_payload.get("op"), "").strip().lower()
        is_automation_op = op in AUTOMATION_UI_ACTION_OPS
        animation_settle_ms = 0
        wait_timeout_ms = 0
        wait_markers: list[str] = []
        wait_events: list[str] = []
        expect_mother_phases: list[str] = []
        expect_canvas_mode: list[str] = []
        pre_wait_markers: list[str] = []
        pre_wait_events: list[str] = []
        if is_automation_op:
            wait_plan = _ui_automation_wait_plan(op, action_payload)
            settle_ms = wait_plan["settle_ms"]
            animation_settle_ms = wait_plan["animation_settle_ms"]
            pre_wait_timeout_ms = wait_plan["pre_wait_timeout_ms"]
            wait_timeout_ms = wait_plan["wait_timeout_ms"]
            wait_markers = wait_plan["wait_markers"]
            wait_events = wait_plan["wait_events"]
            pre_wait_markers = wait_plan["pre_wait_markers"]
            pre_wait_events = wait_plan["pre_wait_events"]
            expect_mother_phases = wait_plan["expect_mother_phases"]
            expect_canvas_mode = wait_plan["expect_canvas_mode"]

            pre_wait_needed = bool(pre_wait_markers or pre_wait_events)
            collected_events: list[dict[str, Any]] = []
            pre_wait_failed = False
            pre_wait_detail: str | None = None
            if pre_wait_needed and self.events_path is not None:
                pre_wait_ok, pre_wait_delta = self._wait_for_automation_state(
                    wait_ms=pre_wait_timeout_ms,
                    state={},
                    wait_markers=pre_wait_markers,
                    wait_events=pre_wait_events,
                    expect_mother_phases=[],
                    expect_canvas_mode=[],
                )
                collected_events.extend(pre_wait_delta)
                if not pre_wait_ok:
                    pre_wait_failed = True
                    pre_wait_detail = (
                        "pre-action automation wait timed out for mother/canvas readiness before dispatch."
                    )
                    collected_events.append({
                        "type": "automation_pre_wait",
                        "ui_op": op,
                        "ui_detail": pre_wait_detail,
                        "action": action_payload,
                        "source": "target_user_harness",
                        "ts": _utc_now_iso(),
                        "state": {},
                        "markers": ["automation_pre_wait_timeout"],
                    })

            automation_payload = dict(action_payload)
            # Forward computed wait expectations to frontend automation handlers so default
            # phase/mode targets are preserved even when the caller omits explicit fields.
            if "expect_mother_phases" not in automation_payload and expect_mother_phases:
                automation_payload["expect_mother_phases"] = list(expect_mother_phases)
            if "expect_canvas_mode" not in automation_payload and expect_canvas_mode:
                automation_payload["expect_canvas_mode"] = list(expect_canvas_mode)
            if "wait_timeout_ms" not in automation_payload and wait_timeout_ms > 0:
                automation_payload["wait_timeout_ms"] = int(wait_timeout_ms)

            request_payload = {
                "op": "automation",
                "action": op,
                "payload": automation_payload,
                "timeout_ms": wait_timeout_ms,
            }
            try:
                response = self._request(request_payload)
            except Exception as exc:
                detail = f"automation request failed for {self.bridge_socket}: {exc}"
                if pre_wait_detail:
                    detail = f"{detail}; {pre_wait_detail}"
                if settle_ms > 0:
                    time.sleep(min(5.0, settle_ms / 1000.0))
                synthetic_event = {
                    "type": "ui_action_failed",
                    "ui_op": op,
                    "ui_detail": detail,
                    "action": action_payload,
                    "source": "target_user_harness",
                    "ts": _utc_now_iso(),
                    "state": {},
                    "markers": ["automation_request_failed"],
                }
                collected_events.append(synthetic_event)
                if self.events_path is not None:
                    post_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
                    collected_events.extend(post_events)
                duration_s = time.monotonic() - started
                return [], collected_events, duration_s, True, False

            ok = _safe_bool(response.get("ok"), False)
            if not response:
                # If transport returns no payload, surface a helpful synthetic result.
                response = {"ok": False, "error": "automation request returned empty payload"}
            detail = _safe_str(response.get("detail"), _safe_str(response.get("error"), "automation request failed"))
            if pre_wait_detail:
                if pre_wait_failed and "pre-action automation wait timed out" not in detail:
                    detail = f"{detail}; {pre_wait_detail}"
            if settle_ms > 0:
                time.sleep(min(5.0, settle_ms / 1000.0))

            response_events: list[dict[str, Any]] = []
            for item in _safe_list(response.get("events")):
                event_payload = _safe_dict(item)
                if event_payload:
                    response_events.append(event_payload)
                    collected_events.append(event_payload)

            post_state = _safe_dict(response.get("state"))
            if ok and self.events_path is not None and (wait_markers or wait_events or expect_mother_phases or expect_canvas_mode):
                seen_response_markers: set[str] = set()
                seen_response_events: set[str] = set()
                for event_payload in response_events:
                    marker = _safe_str(event_payload.get("marker"), "").strip().lower()
                    if marker:
                        seen_response_markers.add(marker)
                    event_type = _safe_str(event_payload.get("type"), "").strip().lower()
                    if event_type:
                        seen_response_events.add(event_type)
                pending_wait_markers = [
                    marker
                    for marker in wait_markers
                    if str(marker).strip().lower() not in seen_response_markers
                ]
                pending_wait_events = [
                    event_name
                    for event_name in wait_events
                    if str(event_name).strip().lower() not in seen_response_events
                ]
                post_wait_ok, post_wait_delta = self._wait_for_automation_state(
                    wait_ms=wait_timeout_ms,
                    state=post_state,
                    wait_markers=pending_wait_markers,
                    wait_events=pending_wait_events,
                    expect_mother_phases=expect_mother_phases,
                    expect_canvas_mode=expect_canvas_mode,
                )
                if post_wait_delta:
                    collected_events.extend(post_wait_delta)
                if not post_wait_ok:
                    # Keep failure explicit so callers and artifacts can show the stall.
                    ok = False
                    detail = f"{detail}; automation post-wait did not observe configured markers/events before timeout."
            if ok and animation_settle_ms > 0:
                # Give UI affordance a short chance to animate.
                time.sleep(min(5.0, animation_settle_ms / 1000.0))
            markers = _as_seq_list(response.get("markers"))
            if pre_wait_failed and "automation_pre_wait_timeout" not in markers:
                markers.append("automation_pre_wait_timeout")
            synthetic_event = {
                "type": "ui_action_performed" if ok else "ui_action_failed",
                "ui_op": op,
                "ui_detail": detail,
                "action": action_payload,
                "source": "target_user_harness",
                "ts": _utc_now_iso(),
                "state": post_state if post_state else _safe_dict(response.get("state")),
                "markers": markers,
            }
            collected_events.append(synthetic_event)
            if self.events_path is not None:
                post_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
                collected_events.extend(post_events)
            duration_s = time.monotonic() - started
            return [], collected_events, duration_s, True, False

        ok, detail, op = self._perform_ui_action(action_payload)
        if op == "wait":
            default_settle_ms = 0
        elif op in {"mother_next_proposal", "mother_confirm_suggestion", "mother_reject_suggestion"}:
            default_settle_ms = 1200
        elif op == "drag":
            default_settle_ms = 700
        else:
            default_settle_ms = 450
        settle_ms = max(0, _safe_int(action_payload.get("settle_ms"), default_settle_ms))
        if settle_ms > 0:
            time.sleep(min(5.0, settle_ms / 1000.0))

        collected_events: list[dict[str, Any]] = []
        if self.events_path is not None:
            collected_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
        synthetic_event = {
            "type": "ui_action_performed" if ok else "ui_action_failed",
            "ui_op": op,
            "ui_detail": detail,
            "action": action_payload,
            "source": "target_user_harness",
            "ts": _utc_now_iso(),
        }
        collected_events.append(synthetic_event)
        duration_s = time.monotonic() - started
        return [], collected_events, duration_s, True, False

    def _wait_for_automation_state(
        self,
        *,
        wait_ms: int,
        state: dict[str, Any],
        wait_markers: list[str],
        wait_events: list[str],
        expect_mother_phases: list[str],
        expect_canvas_mode: list[str],
    ) -> tuple[bool, list[dict[str, Any]]]:
        if self.events_path is None:
            return True, []
        target_markers = {str(raw).strip().lower() for raw in _safe_list(wait_markers)}
        target_events = {str(raw).strip().lower() for raw in _safe_list(wait_events)}
        required_mother = {_normalize_mother_phase(value) for value in _safe_list(expect_mother_phases)}
        required_canvas_mode = {str(raw).strip().lower() for raw in _safe_list(expect_canvas_mode)}
        if not target_markers and not target_events and not required_mother and not required_canvas_mode:
            return True, []
        seen_markers: set[str] = set()
        seen_events: set[str] = set()
        observed_state = _safe_dict(state)
        observed_state = {
            key: value
            for key, value in observed_state.items()
            if value is not None
        }
        observed_events: list[dict[str, Any]] = []
        if self._automation_state_match(
            observed_state,
            seen_markers,
            seen_events,
            target_markers,
            target_events,
            required_mother,
            required_canvas_mode,
        ):
            return True, []

        deadline = time.monotonic() + max(0.25, wait_ms / 1000.0)
        while time.monotonic() < deadline:
            delta_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
            if delta_events:
                observed_events.extend(delta_events)
                for event in delta_events:
                    event_payload = _safe_dict(event)
                    event_type = _safe_str(event_payload.get("type"), "").strip().lower()
                    if event_type:
                        seen_events.add(event_type)
                    marker = _safe_str(event_payload.get("marker"), "").strip().lower()
                    if marker:
                        seen_markers.add(marker)
                    if event_type in {"mother_state", "canvas_state"}:
                        latest_state = {
                            key: value
                            for key, value in _safe_dict(event_payload.get("state")).items()
                            if value is not None
                        }
                        if latest_state:
                            observed_state.update(latest_state)
                if self._automation_state_match(
                    observed_state,
                    seen_markers,
                    seen_events,
                    target_markers,
                    target_events,
                    required_mother,
                    required_canvas_mode,
                ):
                    return True, observed_events

            if self._automation_state_match(
                observed_state,
                seen_markers,
                seen_events,
                target_markers,
                target_events,
                required_mother,
                required_canvas_mode,
            ):
                return True, observed_events

            time.sleep(0.08)
        return False, observed_events

    def _automation_state_match(
        self,
        state: dict[str, Any],
        seen_markers: set[str],
        seen_events: set[str],
        required_markers: set[str],
        required_events: set[str],
        require_mother_phases: set[str],
        require_canvas_modes: set[str],
    ) -> bool:
        if required_markers and not required_markers.issubset(seen_markers):
            return False
        if required_events and not required_events.issubset(seen_events):
            return False
        if require_mother_phases:
            phase = _normalize_mother_phase(
                _safe_str(state.get("mother_phase"), _safe_str(state.get("phase"), ""))
            )
            if not phase or phase not in require_mother_phases:
                return False
        if require_canvas_modes:
            canvas_mode = _safe_str(state.get("canvas_mode"), "").strip().lower()
            if not canvas_mode or canvas_mode not in require_canvas_modes:
                return False
        return True

    def run_turn(self, user_input: str) -> tuple[list[str], list[dict[str, Any]], float, bool, bool]:
        if self.events_path is not None:
            _, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
        if not user_input.endswith("\n"):
            user_input = f"{user_input}\n"

        started = time.monotonic()
        response = self._request({"op": "write", "data": user_input})
        if not _safe_bool(response.get("ok"), False):
            err = _safe_str(response.get("error"), "desktop bridge write failed")
            raise RuntimeError(err)

        assistant_lines: list[str] = []
        collected_events: list[dict[str, Any]] = []
        timed_out = False
        prompt_returned = False
        last_signal_ts = started
        saw_events = False
        command_mode = user_input.strip().startswith("/")
        expected_success = _expected_success_event_names(user_input)
        expected_fail = _expected_fail_event_names(user_input)
        expected_events = expected_success | expected_fail
        # Generation turns can take materially longer before the first artifact/failure signal.
        waiting_for_artifact = "artifact_created" in expected_success
        if waiting_for_artifact:
            no_event_grace_s = min(float(self.command_timeout_s), 75.0)
        else:
            no_event_grace_s = 8.0 if command_mode else 3.0
        last_relevant_ts: float | None = None
        deadline = started + self.command_timeout_s
        while time.monotonic() < deadline:
            if self.events_path is not None:
                delta_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
            else:
                delta_events = []
            if delta_events:
                collected_events.extend(delta_events)
                saw_events = True
                last_signal_ts = time.monotonic()
                if expected_events:
                    for event in delta_events:
                        event_type = _safe_str(_safe_dict(event).get("type"), "")
                        if not event_type:
                            continue
                        if event_type in expected_events:
                            last_relevant_ts = time.monotonic()
                            break

            idle_window_s = time.monotonic() - last_signal_ts
            elapsed_s = time.monotonic() - started
            if expected_events:
                if last_relevant_ts is not None and (time.monotonic() - last_relevant_ts) >= 0.6:
                    prompt_returned = True
                    break
                if last_relevant_ts is None and elapsed_s >= no_event_grace_s:
                    # Some command paths can fail silently; cap waiting even without relevant events.
                    prompt_returned = True
                    break
            else:
                if saw_events and idle_window_s >= 1.0:
                    prompt_returned = True
                    break
                if not saw_events and elapsed_s >= no_event_grace_s:
                    # Some commands do not emit structured events; cap no-event waiting.
                    prompt_returned = True
                    break
            time.sleep(0.2)

        duration_s = time.monotonic() - started
        if self.events_path is not None:
            post_events, self.events_offset = _read_events_delta(self.events_path, self.events_offset)
            if post_events:
                collected_events.extend(post_events)

        if not prompt_returned and collected_events:
            prompt_returned = True
        if not prompt_returned:
            timed_out = True
        return assistant_lines, collected_events, duration_s, prompt_returned, timed_out

    def _perform_ui_action(self, action: dict[str, Any]) -> tuple[bool, str, str]:
        op = _safe_str(action.get("op"), "").strip().lower()
        if not op:
            return False, "missing op", "unknown"
        if op not in SUPPORTED_UI_ACTION_OPS:
            return False, f"unsupported op: {op}", op
        if platform.system() != "Darwin":
            return False, "ui automation currently supports macOS only", op

        if op == "wait":
            wait_ms = max(0, _safe_int(action.get("ms"), _safe_int(action.get("duration_ms"), 600)))
            wait_s = max(0.0, _safe_float(action.get("seconds"), wait_ms / 1000.0))
            time.sleep(min(wait_s, 10.0))
            return True, f"waited {round(min(wait_s, 10.0), 3)}s", op

        self._activate_macos_app()
        if op == "focus_app":
            return True, "app focused", op
        if op == "mother_next_proposal":
            ok, detail = self._click_button_candidates(
                [
                    "next proposal",
                    "cycle to next proposal",
                    "next",
                ],
            )
            if ok:
                return True, detail, op
            ratio_point = self._resolve_ui_point(action, x_key="x", y_key="y")
            if ratio_point is None:
                ratio_point = self._default_mother_control_point("next")
            return self._click_point_with_detail(
                ratio_point,
                op=op,
                fallback_reason=detail or "mother next button lookup failed",
            )
        if op == "mother_confirm_suggestion":
            ok, detail = self._click_button_candidates(
                [
                    "confirm proposal and start draft",
                    "commit selected draft",
                    "draft",
                    "mother confirm",
                ],
            )
            if ok:
                return True, detail, op
            ratio_point = self._resolve_ui_point(action, x_key="x", y_key="y")
            if ratio_point is None:
                ratio_point = self._default_mother_control_point("confirm")
            return self._click_point_with_detail(
                ratio_point,
                op=op,
                fallback_reason=detail or "mother confirm button lookup failed",
            )
        if op == "mother_reject_suggestion":
            ok, detail = self._click_button_candidates(
                [
                    "reject or dismiss proposal",
                    "dismiss",
                    "stop",
                    "undo commit",
                ],
            )
            if ok:
                return True, detail, op
            ratio_point = self._resolve_ui_point(action, x_key="x", y_key="y")
            if ratio_point is None:
                ratio_point = self._default_mother_control_point("reject")
            return self._click_point_with_detail(
                ratio_point,
                op=op,
                fallback_reason=detail or "mother reject button lookup failed",
            )
        if op in {"click", "double_click"}:
            point = self._resolve_ui_point(action, x_key="x", y_key="y")
            if point is None:
                return False, "missing or invalid x/y", op
            count = 2 if op == "double_click" else 1
            for _ in range(count):
                ok, err, _ = self._run_osascript(
                    'tell application "System Events"\n'
                    f"  click at {{{point[0]}, {point[1]}}}\n"
                    "end tell\n",
                    timeout_s=1.8,
                )
                if not ok:
                    return False, err or "click failed", op
                if count > 1:
                    time.sleep(0.08)
            return True, f"clicked at {point[0]},{point[1]}", op
        if op == "drag":
            start_point = self._resolve_drag_point(action, start=True)
            end_point = self._resolve_drag_point(action, start=False)
            if start_point is None or end_point is None:
                return False, "missing or invalid drag points", op
            ok, err, _ = self._run_osascript(
                'tell application "System Events"\n'
                f"  drag from {{{start_point[0]}, {start_point[1]}}} "
                f"to {{{end_point[0]}, {end_point[1]}}}\n"
                "end tell\n",
                timeout_s=2.4,
            )
            if not ok:
                return False, err or "drag failed", op
            return True, f"dragged {start_point[0]},{start_point[1]} -> {end_point[0]},{end_point[1]}", op
        if op == "type_text":
            text = _safe_str(action.get("text"), "")
            if not text:
                return False, "missing text", op
            escaped = self._escape_applescript_text(text)
            ok, err, _ = self._run_osascript(
                'tell application "System Events"\n'
                f'  keystroke "{escaped}"\n'
                "end tell\n",
                timeout_s=2.5,
            )
            if not ok:
                return False, err or "type_text failed", op
            return True, "typed text", op
        if op == "keypress":
            raw_keys = action.get("keys")
            keys = [str(v).strip().lower() for v in _safe_list(raw_keys) if str(v).strip()]
            if isinstance(raw_keys, str):
                keys = [part.strip().lower() for part in raw_keys.split("+") if part.strip()]
            if not keys:
                return False, "missing keys", op
            key = _safe_str(action.get("key"), "")
            modifiers = keys[:]
            if not key:
                key = modifiers.pop() if modifiers else ""
            if not key:
                return False, "missing terminal key", op
            key_code = self._special_key_code(key)
            using = self._modifier_clause(modifiers)
            if key_code is not None:
                command = f"key code {key_code}{using}"
            else:
                escaped_key = self._escape_applescript_text(key)
                command = f'keystroke "{escaped_key}"{using}'
            ok, err, _ = self._run_osascript(
                'tell application "System Events"\n'
                f"  {command}\n"
                "end tell\n",
                timeout_s=2.2,
            )
            if not ok:
                return False, err or "keypress failed", op
            return True, f"sent keypress {key}", op
        if op == "click_button":
            label = _safe_str(action.get("name"), "").strip()
            if not label:
                return False, "missing button name", op
            ok, detail = self._click_button_candidates([label])
            if not ok:
                return False, detail or "button not found or not clickable", op
            return True, detail, op

        return False, f"unimplemented op: {op}", op

    def _click_button_candidates(self, labels: list[str]) -> tuple[bool, str]:
        cleaned = [self._escape_applescript_text(str(label).strip().lower()) for label in labels if str(label).strip()]
        if not cleaned:
            return False, "missing button labels"
        names_literal = ", ".join(f'"{name.replace(chr(34), "")}"' for name in _normalize_app_names(self.app_names) if name)
        labels_literal = ", ".join(f'"{label}"' for label in cleaned)
        script = (
            'tell application "System Events"\n'
            f"  repeat with pname in {{{names_literal}}}\n"
            "    if exists process (pname as text) then\n"
            "      tell process (pname as text)\n"
            "        if (count of windows) > 0 then\n"
            f"          repeat with bname in {{{labels_literal}}}\n"
            "            repeat with b in (buttons of front window)\n"
            "              set nm to \"\"\n"
            "              set ds to \"\"\n"
            "              try\n"
            "                set nm to (name of b as text)\n"
            "              end try\n"
            "              try\n"
            "                set ds to (description of b as text)\n"
            "              end try\n"
            "              set nml to (nm as text)\n"
            "              set dsl to (ds as text)\n"
            "              if (nml is not \"\") then set nml to (do shell script \"printf %s \" & quoted form of nml & \" | tr '[:upper:]' '[:lower:]'\")\n"
            "              if (dsl is not \"\") then set dsl to (do shell script \"printf %s \" & quoted form of dsl & \" | tr '[:upper:]' '[:lower:]'\")\n"
            "              if ((nml contains (bname as text)) or (dsl contains (bname as text))) then\n"
            "                click b\n"
            "                return (bname as text)\n"
            "              end if\n"
            "            end repeat\n"
            "          end repeat\n"
            "        end if\n"
            "      end tell\n"
            "    end if\n"
            "  end repeat\n"
            "end tell\n"
            'return ""\n'
        )
        ok, err, stdout = self._run_osascript(script, timeout_s=2.8, include_stdout=True)
        if not ok:
            return False, err or "button lookup failed"
        clicked = stdout.strip()
        if not clicked:
            return False, "button not found"
        return True, f"clicked button {clicked}"

    def _resolve_drag_point(self, action: dict[str, Any], *, start: bool) -> tuple[int, int] | None:
        pair_key = "from" if start else "to"
        pair = action.get(pair_key)
        if isinstance(pair, list) and len(pair) >= 2:
            candidate = dict(action)
            candidate["x"] = pair[0]
            candidate["y"] = pair[1]
            return self._resolve_ui_point(candidate, x_key="x", y_key="y")
        if isinstance(pair, dict):
            candidate = dict(action)
            candidate["x"] = pair.get("x")
            candidate["y"] = pair.get("y")
            if pair.get("coord") is not None:
                candidate["coord"] = pair.get("coord")
            return self._resolve_ui_point(candidate, x_key="x", y_key="y")
        if start:
            return self._resolve_ui_point(action, x_key="x", y_key="y")
        return self._resolve_ui_point(action, x_key="x2", y_key="y2")

    def _resolve_ui_point(
        self,
        action: dict[str, Any],
        *,
        x_key: str,
        y_key: str,
    ) -> tuple[int, int] | None:
        x_val = action.get(x_key)
        y_val = action.get(y_key)
        if not isinstance(x_val, (int, float)) or not isinstance(y_val, (int, float)):
            return None
        x = float(x_val)
        y = float(y_val)
        coord = _safe_str(action.get("coord"), "").strip().lower()
        if not coord:
            coord = "window_ratio" if 0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 else "screen_px"
        if coord == "screen_px":
            return int(round(x)), int(round(y))
        if coord != "window_ratio":
            return None
        bounds = self._macos_front_window_bounds()
        if bounds is None:
            return None
        bx, by, bw, bh = bounds
        sx = bx + int(round(min(1.0, max(0.0, x)) * bw))
        sy = by + int(round(min(1.0, max(0.0, y)) * bh))
        return sx, sy

    def _default_mother_control_point(self, control: str) -> tuple[int, int] | None:
        bounds = self._macos_front_window_bounds()
        if bounds is None:
            return None
        bx, by, bw, bh = bounds
        # Mother floating controls are near the right-top quadrant; these ratios
        # provide a pragmatic fallback when accessibility label lookup is brittle.
        ratios = {
            "next": (0.828, 0.285),
            "confirm": (0.857, 0.285),
            "reject": (0.885, 0.285),
        }
        rx, ry = ratios.get(control, ratios["next"])
        return bx + int(round(rx * bw)), by + int(round(ry * bh))

    def _click_point_with_detail(
        self,
        point: tuple[int, int] | None,
        *,
        op: str,
        fallback_reason: str,
    ) -> tuple[bool, str, str]:
        if point is None:
            return False, fallback_reason, op
        ok, err, _ = self._run_osascript(
            'tell application "System Events"\n'
            f"  click at {{{point[0]}, {point[1]}}}\n"
            "end tell\n",
            timeout_s=1.9,
        )
        if not ok:
            return False, f"{fallback_reason}; fallback click failed: {err or 'unknown'}", op
        return True, f"{fallback_reason}; fallback clicked at {point[0]},{point[1]}", op

    def _activate_macos_app(self) -> None:
        if platform.system() != "Darwin":
            return
        app_names = _normalize_app_names(self.app_names)
        names_literal = ", ".join(f'"{name.replace(chr(34), "")}"' for name in app_names if name)
        if names_literal:
            script = (
                'tell application "System Events"\n'
                f"  repeat with pname in {{{names_literal}}}\n"
                "    if exists process (pname as text) then\n"
                "      set frontmost of process (pname as text) to true\n"
                '      return "ok"\n'
                "    end if\n"
                "  end repeat\n"
                "end tell\n"
                'return ""\n'
            )
            ok, _, stdout = self._run_osascript(script, timeout_s=1.8, include_stdout=True)
            if ok and stdout.strip() == "ok":
                time.sleep(0.1)
                return
        for app_name in app_names:
            safe_name = app_name.replace('"', "").strip()
            if not safe_name:
                continue
            try:
                subprocess.run(
                    ["open", "-a", safe_name],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1.6,
                )
                time.sleep(0.1)
                return
            except Exception:
                continue

    def _macos_front_window_bounds(self) -> tuple[int, int, int, int] | None:
        app_names = _normalize_app_names(self.app_names)
        names_literal = ", ".join(f'"{name.replace(chr(34), "")}"' for name in app_names if name)
        script = (
            'tell application "System Events"\n'
            f"  repeat with pname in {{{names_literal}}}\n"
            "    if exists process (pname as text) then\n"
            "      tell process (pname as text)\n"
            "        if (count of windows) > 0 then\n"
            "          set {xPos, yPos} to position of front window\n"
            "          set {wSize, hSize} to size of front window\n"
            "          return (xPos as string) & \",\" & (yPos as string) & \",\" & (wSize as string) & \",\" & (hSize as string)\n"
            "        end if\n"
            "      end tell\n"
            "    end if\n"
            "  end repeat\n"
            "end tell\n"
            'return ""\n'
        )
        ok, _, stdout = self._run_osascript(script, timeout_s=2.4, include_stdout=True)
        if not ok:
            return None
        raw = stdout.strip()
        if not raw or "," not in raw:
            return None
        try:
            x_str, y_str, w_str, h_str = [part.strip() for part in raw.split(",", 3)]
            return int(float(x_str)), int(float(y_str)), int(float(w_str)), int(float(h_str))
        except Exception:
            return None

    @staticmethod
    def _escape_applescript_text(text: str) -> str:
        return text.replace("\\", "\\\\").replace('"', '\\"')

    @staticmethod
    def _special_key_code(key: str) -> int | None:
        lookup = {
            "return": 36,
            "enter": 36,
            "tab": 48,
            "space": 49,
            "delete": 51,
            "backspace": 51,
            "escape": 53,
            "esc": 53,
            "left": 123,
            "right": 124,
            "down": 125,
            "up": 126,
        }
        return lookup.get(key.strip().lower())

    @staticmethod
    def _modifier_clause(keys: list[str]) -> str:
        mapping = {
            "command": "command down",
            "cmd": "command down",
            "shift": "shift down",
            "option": "option down",
            "alt": "option down",
            "control": "control down",
            "ctrl": "control down",
            "fn": "fn down",
        }
        modifiers: list[str] = []
        seen: set[str] = set()
        for raw in keys:
            key = raw.strip().lower()
            mapped = mapping.get(key)
            if not mapped or mapped in seen:
                continue
            seen.add(mapped)
            modifiers.append(mapped)
        if not modifiers:
            return ""
        return " using {" + ", ".join(modifiers) + "}"

    @staticmethod
    def _run_osascript(
        script: str,
        *,
        timeout_s: float = 2.0,
        include_stdout: bool = False,
    ) -> tuple[bool, str, str]:
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_s,
            )
        except Exception as exc:
            return False, str(exc), ""
        stderr = (result.stderr or "").strip()
        stdout = (result.stdout or "").strip()
        if result.returncode == 0:
            return True, "", stdout if include_stdout else ""
        detail = stderr or stdout or f"osascript_exit_{result.returncode}"
        return False, detail, stdout if include_stdout else ""

    def _status(self, *, request_timeout_ms: int | None = None) -> dict[str, Any]:
        payload = {"op": "status"}
        if request_timeout_ms is not None:
            payload["timeout_ms"] = request_timeout_ms
        payload = self._request(payload)
        if not _safe_bool(payload.get("ok"), False):
            err = _safe_str(payload.get("error"), "desktop bridge status failed")
            raise RuntimeError(err)
        return _safe_dict(payload.get("status"))

    def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        sock_path = str(self.bridge_socket)
        validation_error = self._bridge_path_validation_error()
        if validation_error:
            raise RuntimeError(
                "Desktop bridge socket is invalid. "
                f"{validation_error} socket={sock_path}"
            )
        if not self.bridge_socket.exists():
            raise RuntimeError(
                "Desktop bridge socket not found: "
                f"{sock_path}. "
                "Start Brood desktop and wait for the local bridge to bind before running the harness."
            )
        op = _safe_str(payload.get("op"), "").strip() or "unknown"
        request_timeout_ms = _safe_int(payload.get("timeout_ms"), 3000)
        request_timeout_s = request_timeout_ms / 1000.0
        if op == "automation":
            # automation ops need enough time for Rust->frontend handshake + app-side completion response
            max_attempts = max(2, min(5, int(max(1.0, request_timeout_s / 2.0)) + 1))
            op_timeout_s = max(0.8, request_timeout_s + 1.0)
        else:
            max_attempts = max(3, min(12, int(max(1.0, request_timeout_s) / 0.25) + 1))
            op_timeout_s = max(0.8, min(6.0, request_timeout_s))
        backoff = 0.25
        last_error = ""
        request_start = time.monotonic()
        for attempt in range(1, max_attempts + 1):
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(op_timeout_s)
                    client.connect(sock_path)
                    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") + b"\n"
                    client.sendall(body)
                    chunks: list[bytes] = []
                    while True:
                        chunk = client.recv(8192)
                        if not chunk:
                            break
                        chunks.append(chunk)
                        if b"\n" in chunk:
                            break
                raw = b"".join(chunks).decode("utf-8", errors="ignore").strip()
                if not raw:
                    raise RuntimeError(
                        f"desktop bridge returned an empty response for {op}; "
                        f"socket={sock_path}; timeout_ms={request_timeout_ms}"
                    )
                line = raw.splitlines()[0].strip()
                if not line:
                    raise RuntimeError(
                        f"desktop bridge returned whitespace-only response for {op}; "
                        f"socket={sock_path}"
                    )
                try:
                    return _safe_dict(json.loads(line))
                except Exception as exc:
                    raise RuntimeError(f"desktop bridge returned non-json payload: {line}") from exc
            except (ConnectionRefusedError, OSError, socket.timeout) as exc:
                errno_code = getattr(exc, "errno", None)
                if isinstance(exc, ConnectionRefusedError) or errno_code == errno.ECONNREFUSED:
                    last_error = "connection refused while connecting to bridge socket"
                elif errno_code == errno.ENOENT:
                    last_error = "bridge socket file disappeared during request"
                elif isinstance(exc, socket.timeout):
                    last_error = f"bridge socket request timed out after {request_timeout_ms}ms"
                else:
                    last_error = str(exc)
                # Automation requests are non-idempotent; never replay after a socket timeout.
                allow_retry = not (op == "automation" and isinstance(exc, socket.timeout))
                if attempt < max_attempts and allow_retry:
                    time.sleep(backoff * attempt)
                    continue
                elapsed_ms = int((time.monotonic() - request_start) * 1000)
                raise RuntimeError(
                    "Desktop bridge request failed.\n"
                    f"- socket: {sock_path}\n"
                    f"- attempts: {attempt}/{max_attempts}\n"
                    f"- elapsed_ms: {elapsed_ms}\n"
                    f"- op: {op}\n"
                    f"- last_error: {last_error}"
                )
            except RuntimeError:
                raise
            except Exception as exc:
                elapsed_ms = int((time.monotonic() - request_start) * 1000)
                raise RuntimeError(
                    "Desktop bridge request failed.\n"
                    f"- socket: {sock_path}\n"
                    f"- elapsed_ms: {elapsed_ms}\n"
                    f"- op: {op}\n"
                    f"- error: {exc}"
                )


class ScreenshotCapture:
    """Create or copy screenshots for each key turn."""

    def __init__(
        self,
        *,
        run_dir: Path,
        source_dir: Path | None = None,
        capture_mode: str = DEFAULT_SCREENSHOT_CAPTURE_MODE,
        app_names: list[str] | None = None,
    ) -> None:
        self.run_dir = run_dir
        self.source_dir = source_dir
        self.capture_mode = _normalize_screenshot_capture_mode(capture_mode)
        self.app_names = app_names or list(DEFAULT_SCREENSHOT_APP_NAMES)
        self._last_mtime = 0.0

    def capture(
        self,
        *,
        scenario_id: str,
        persona_id: str,
        turn: int,
        phase: str,
        action: str,
        reason: str,
        events: list[dict[str, Any]],
        artifacts: list[str],
        source_images: list[Path],
    ) -> Path:
        out_dir = self.run_dir / "screenshots"
        out_dir.mkdir(parents=True, exist_ok=True)
        path = out_dir / f"{_slug(scenario_id)}__{_slug(persona_id)}__t{turn:02d}-{phase}.png"

        if self.capture_mode in {"auto", "source_dir"} and self.source_dir is not None:
            captured = self._copy_latest_source_image(path)
            if captured is not None:
                return captured

        if self.capture_mode == "auto":
            self._activate_macos_app()
            captured = self._capture_macos_window(path)
            if captured is not None:
                return captured

        if Image is None:
            # Fallback: still emit an empty marker file for deterministic artifact
            # structure even if Pillow is not available.
            marker = _slug(path.stem)
            path.write_text(
                "\n".join(
                    [
                        f"screenshot: {marker}",
                        f"action: {action}",
                        f"reason: {reason}",
                        f"turn: {turn}",
                        f"phase: {phase}",
                        f"events: {', '.join(_extract_event_types(events))}",
                    ]
                ),
                encoding="utf-8",
            )
            return path

        width = 1320
        height = 820
        canvas = Image.new("RGB", (width, height), (20, 22, 30))
        draw = ImageDraw.Draw(canvas)
        try:
            title_font = ImageFont.truetype("Arial.ttf", 24)
            body_font = ImageFont.truetype("Arial.ttf", 16)
        except Exception:
            title_font = ImageFont.load_default()
            body_font = ImageFont.load_default()

        header = (
            f"Target User Harness Screenshot | scenario={scenario_id} | persona={persona_id} | "
            f"turn={turn} | phase={phase} | {reason}"
        )
        draw.text((24, 16), _truncate_text(header, 130), fill=(226, 230, 241), font=title_font)
        draw.text((24, 56), f"Action: {_truncate_text(action, 150)}", fill=(190, 196, 212), font=body_font)
        y = 92
        for line in _build_screenshot_lines(events=events, artifacts=artifacts):
            draw.text((24, y), line, fill=(196, 203, 220), font=body_font)
            y += 20
            if y > 280:
                break
        if source_images:
            y = 300
            draw.text((24, y), "Source & artifact previews:", fill=(226, 230, 241), font=body_font)
            y += 24
            x = 24
            thumb_w, thumb_h = 260, 150
            for img_path in source_images[:4]:
                thumb = self._build_thumb(img_path, (thumb_w, thumb_h))
                if thumb is None:
                    continue
                canvas.paste(thumb, (x, y))
                x += thumb_w + 16
                if x + thumb_w > width:
                    break
        else:
            draw.text((24, 300), "No image inputs available for preview.", fill=(152, 158, 176), font=body_font)
        canvas.save(path, format="PNG")
        return path

    def _copy_latest_source_image(self, out_path: Path) -> Path | None:
        source_dir = self.source_dir
        if source_dir is None or not source_dir.exists():
            return None
        candidates = [p for p in source_dir.rglob("*") if p.is_file() and p.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"}]
        if not candidates:
            return None
        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        for candidate in candidates:
            try:
                mtime = candidate.stat().st_mtime
            except OSError:
                continue
            if mtime <= self._last_mtime:
                continue
            try:
                out_path.write_bytes(candidate.read_bytes())
            except Exception:
                return None
            self._last_mtime = mtime
            return out_path
        return None

    def _build_thumb(self, path: Path, size: tuple[int, int]) -> Any:
        try:
            img = Image.open(path).convert("RGB")
        except Exception:
            return None
        img = img.resize(size)
        return img

    def _capture_macos_window(self, out_path: Path) -> Path | None:
        if platform.system() != "Darwin":
            return None
        bounds = self._macos_front_window_bounds()
        if bounds is None:
            return self._capture_macos_fullscreen(out_path)
        x, y, w, h = bounds
        if w <= 0 or h <= 0:
            return self._capture_macos_fullscreen(out_path)
        try:
            subprocess.run(
                [
                    "screencapture",
                    "-x",
                    "-R",
                    f"{x},{y},{w},{h}",
                    str(out_path),
                ],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=4,
            )
        except Exception:
            return self._capture_macos_fullscreen(out_path)
        return out_path if out_path.exists() and out_path.stat().st_size > 0 else None

    def _capture_macos_fullscreen(self, out_path: Path) -> Path | None:
        self._activate_macos_app()
        try:
            subprocess.run(
                ["screencapture", "-x", str(out_path)],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=4,
            )
        except Exception:
            return None
        return out_path if out_path.exists() and out_path.stat().st_size > 0 else None

    def _activate_macos_app(self) -> None:
        if platform.system() != "Darwin":
            return
        app_names = _normalize_app_names(self.app_names)
        names_literal = ", ".join(f'"{name.replace(chr(34), "")}"' for name in app_names if name)
        if names_literal:
            script = (
                'tell application "System Events"\n'
                f"  repeat with pname in {{{names_literal}}}\n"
                "    if exists process (pname as text) then\n"
                "      set frontmost of process (pname as text) to true\n"
                "      return \"ok\"\n"
                "    end if\n"
                "  end repeat\n"
                "end tell\n"
                "return \"\"\n"
            )
            try:
                result = subprocess.run(
                    ["osascript", "-e", script],
                    check=False,
                    capture_output=True,
                    text=True,
                    timeout=1.8,
                )
                if (result.stdout or "").strip() == "ok":
                    time.sleep(0.1)
                    return
            except Exception:
                pass
        # Fallback for packaged app names.
        for app_name in app_names:
            safe_name = app_name.replace('"', "").strip()
            if not safe_name:
                continue
            try:
                subprocess.run(
                    ["open", "-a", safe_name],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=1.6,
                )
                time.sleep(0.1)
                return
            except Exception:
                continue

    def _macos_front_window_bounds(self) -> tuple[int, int, int, int] | None:
        app_names = _normalize_app_names(self.app_names)
        names_literal = ", ".join(f'"{name.replace(chr(34), "")}"' for name in app_names)
        script = (
            "tell application \"System Events\"\n"
            f"  repeat with pname in {{{names_literal}}}\n"
            "    if exists process (pname as text) then\n"
            "      tell process (pname as text)\n"
            "        if (count of windows) > 0 then\n"
            "          set {xPos, yPos} to position of front window\n"
            "          set {wSize, hSize} to size of front window\n"
            "          return (xPos as string) & \",\" & (yPos as string) & \",\" & (wSize as string) & \",\" & (hSize as string)\n"
            "        end if\n"
            "      end tell\n"
            "    end if\n"
            "  end repeat\n"
            "end tell\n"
            "return \"\"\n"
        )
        try:
            result = subprocess.run(
                ["osascript", "-e", script],
                check=False,
                capture_output=True,
                text=True,
                timeout=3,
            )
        except Exception:
            return None
        raw = (result.stdout or "").strip()
        if not raw or "," not in raw:
            return None
        try:
            x_str, y_str, w_str, h_str = [part.strip() for part in raw.split(",", 3)]
            return int(float(x_str)), int(float(y_str)), int(float(w_str)), int(float(h_str))
        except Exception:
            return None


def _truncate_text(value: str, max_len: int) -> str:
    if len(value) <= max_len:
        return value
    return f"{value[: max_len - 1]}…"


def _build_screenshot_lines(*, events: list[dict[str, Any]], artifacts: list[str]) -> list[str]:
    lines: list[str] = []
    event_types = _extract_event_types(events)
    lines.append(f"Events: {', '.join(event_types) if event_types else '(none)'}")
    if artifacts:
        lines.append("Artifacts:")
        for artifact in artifacts[:6]:
            lines.append(f"- {artifact}")
    else:
        lines.append("Artifacts: (none)")
    return lines


class PanelReviewer:
    """Optional reviewer that calls the OpenAI Responses API with screenshot + context."""

    def __init__(
        self,
        *,
        model: str | None,
        panel_prompt: str | None,
        reasoning_effort: str | None = None,
        temperature: float = 0.5,
        timeout_s: float = 45.0,
    ) -> None:
        self.requested_model = _safe_str(model).strip() or None
        self.model, inferred_reasoning_effort = _resolve_panel_model_alias(self.requested_model)
        self.reasoning_effort = _normalize_reasoning_effort(reasoning_effort, inferred_reasoning_effort)
        self.panel_prompt = _safe_str(panel_prompt).strip()
        self.temperature = temperature
        self.timeout_s = timeout_s
        self.api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_TOKEN")
        api_base = os.getenv("OPENAI_API_BASE") or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
        self.api_base = api_base.rstrip("/")
        self.enabled = bool(self.model and self.panel_prompt and self.api_key)

    def review(
        self,
        *,
        persona: dict[str, Any],
        scenario: dict[str, Any],
        action: str,
        screenshot_path: Path,
        turn: int,
        events: list[dict[str, Any]],
        artifacts: list[str],
        screenshot_summary: list[str],
        consecutive_failures: int,
    ) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        request_record: dict[str, Any] = {
            "timestamp": _utc_now_iso(),
            "turn": turn,
            "action": action,
            "model": self.model,
            "requested_model": self.requested_model,
            "reasoning_effort": self.reasoning_effort,
            "temperature": _safe_float(self.temperature, 0.5),
            "screenshot_path": str(screenshot_path),
            "event_types": _extract_event_types(events),
            "artifact_paths": [str(path) for path in artifacts if str(path).strip()],
            "consecutive_failures": consecutive_failures,
        }
        if not self.enabled:
            return None, {
                "status": "disabled",
                "error": "panel reviewer is disabled (missing model/prompt/API key)",
                "request": request_record,
                "response": {"timestamp": _utc_now_iso(), "status": "disabled"},
            }

        prompt = self._build_prompt(
            persona=persona,
            scenario=scenario,
            action=action,
            turn=turn,
            events=events,
            artifacts=artifacts,
            screenshot_summary=screenshot_summary,
            consecutive_failures=consecutive_failures,
        )
        request_record["prompt"] = prompt
        request_record["prompt_chars"] = len(prompt)
        image_url = self._encode_image(screenshot_path)
        if image_url is None:
            return None, {
                "status": "image_encode_failed",
                "error": f"failed to encode screenshot at {screenshot_path}",
                "request": request_record,
                "response": {"timestamp": _utc_now_iso(), "status": "image_encode_failed"},
            }
        request_record["image_included"] = True
        effective_reasoning_effort = _effective_reasoning_effort_for_model(
            self.model,
            self.reasoning_effort,
            default="low",
        )
        request_record["reasoning_effort_applied"] = effective_reasoning_effort
        payload: dict[str, Any] = {
            "model": self.model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": prompt},
                        {"type": "input_image", "image_url": image_url},
                    ],
                }
            ],
            "max_output_tokens": 900,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "target_user_panel_review",
                    "strict": True,
                    "schema": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["reaction", "pain_points", "next_hypothesis", "simulated_user_quotes"],
                        "properties": {
                            "reaction": {"type": "string"},
                            "next_hypothesis": {"type": "string"},
                            "pain_points": {
                                "type": "array",
                                "maxItems": 3,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["category", "severity", "symptom", "evidence", "likely_cause"],
                                    "properties": {
                                        "category": {"type": "string", "enum": DEFAULT_PAIN_TAXONOMY},
                                        "severity": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                                        "symptom": {"type": "string"},
                                        "evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                                        "likely_cause": {"type": "string"},
                                    },
                                },
                            },
                            "simulated_user_quotes": {
                                "type": "array",
                                "maxItems": 3,
                                "items": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "required": ["quote", "sentiment", "confidence", "evidence"],
                                    "properties": {
                                        "quote": {"type": "string"},
                                        "sentiment": {
                                            "type": "string",
                                            "enum": ["positive", "neutral", "negative", "mixed", "uncertain"],
                                        },
                                        "confidence": {"type": "number", "minimum": 0.0, "maximum": 1.0},
                                        "evidence": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                                    },
                                },
                            },
                        },
                    },
                }
            },
        }
        if effective_reasoning_effort:
            payload["reasoning"] = {"effort": effective_reasoning_effort}
        endpoint = f"{self.api_base}/responses"
        try:
            status, response = self._post_json(endpoint, payload, self.api_key, timeout_s=self.timeout_s)  # type: ignore[arg-type]
        except Exception as exc:
            return None, {
                "status": "request_error",
                "error": str(exc),
                "request": request_record,
                "response": {"timestamp": _utc_now_iso(), "status": "request_error"},
            }
        retry_attempted = False
        if _is_reasoning_effort_unsupported_error(status, _safe_dict(response)) and "reasoning" in payload:
            retry_payload = dict(payload)
            retry_payload.pop("reasoning", None)
            try:
                retry_status, retry_response = self._post_json(
                    endpoint,
                    retry_payload,
                    self.api_key,
                    timeout_s=self.timeout_s,
                )  # type: ignore[arg-type]
                retry_attempted = True
                request_record["reasoning_retry_without_param"] = True
                status, response = retry_status, retry_response
            except Exception:
                pass
        if status >= 500:
            retry_payload = dict(payload)
            retry_payload["max_output_tokens"] = max(1200, _safe_int(payload.get("max_output_tokens"), 900))
            retry_payload["reasoning"] = {"effort": "low"}
            try:
                retry_status, retry_response = self._post_json(
                    endpoint,
                    retry_payload,
                    self.api_key,
                    timeout_s=self.timeout_s,
                )  # type: ignore[arg-type]
                retry_attempted = True
                status, response = retry_status, retry_response
            except Exception:
                pass
        response_record: dict[str, Any] = {
            "timestamp": _utc_now_iso(),
            "status": "http_response",
            "http_status": status,
            "response_id": _safe_str(_safe_dict(response).get("id"), None),
        }
        if retry_attempted:
            response_record["retry_attempted"] = True
        if status < 200 or status >= 300:
            response_record["raw_response"] = response
            return None, {
                "status": "http_error",
                "error": f"unexpected HTTP status: {status}",
                "request": request_record,
                "response": response_record,
            }

        parsed = self._extract_output_json(response)
        text = ""
        if parsed is None:
            text = self._extract_output_text(response)
            if text:
                parsed = self._parse_json_block(text)
        if parsed is None and self._response_incomplete_due_to_tokens(response):
            retry_payload = dict(payload)
            retry_payload["max_output_tokens"] = max(1600, _safe_int(payload.get("max_output_tokens"), 900) * 2)
            retry_payload["reasoning"] = {"effort": "low"}
            try:
                retry_status, retry_response = self._post_json(
                    endpoint,
                    retry_payload,
                    self.api_key,
                    timeout_s=self.timeout_s,
                )  # type: ignore[arg-type]
                response_record["retry_for_incomplete_output"] = True
                response_record["retry_for_incomplete_http_status"] = retry_status
                if 200 <= retry_status < 300:
                    status, response = retry_status, retry_response
                    response_record["http_status"] = status
                    response_record["response_id"] = _safe_str(_safe_dict(response).get("id"), None)
                    parsed = self._extract_output_json(response)
                    text = ""
                    if parsed is None:
                        text = self._extract_output_text(response)
                        if text:
                            parsed = self._parse_json_block(text)
            except Exception:
                pass
        response_record["output_text"] = text
        if parsed is None and not text:
            response_record["raw_response"] = response
            return None, {
                "status": "empty_output",
                "error": "panel API returned no output_text payload",
                "request": request_record,
                "response": response_record,
            }
        response_record["parsed_json"] = parsed
        if not parsed:
            response_record["raw_response"] = response
            return None, {
                "status": "invalid_json",
                "error": "panel output could not be parsed as JSON review payload",
                "request": request_record,
                "response": response_record,
            }
        normalized = self._normalize_review(parsed)
        response_record["normalized_review"] = normalized
        normalized_quotes = _safe_list(normalized.get("simulated_user_quotes"))
        empty_review = (
            not _safe_str(normalized.get("reaction"), "").strip()
            and not _safe_list(normalized.get("pain_points"))
            and not _safe_str(normalized.get("next_hypothesis"), "").strip()
            and not normalized_quotes
        )
        if empty_review:
            return None, {
                "status": "empty_review",
                "error": "panel output parsed but contained no reaction, pain_points, next_hypothesis, or simulated_user_quotes",
                "request": request_record,
                "response": response_record,
            }
        return normalized, {
            "status": "ok",
            "error": "",
            "request": request_record,
            "response": response_record,
        }

    def _build_prompt(
        self,
        *,
        persona: dict[str, Any],
        scenario: dict[str, Any],
        action: str,
        turn: int,
        events: list[dict[str, Any]],
        artifacts: list[str],
        screenshot_summary: list[str],
        consecutive_failures: int,
    ) -> str:
        role = _safe_str(persona.get("role"), "(unknown)")
        traits = ", ".join([_safe_str(t) for t in _safe_list(persona.get("traits"))]) or "(none)"
        goal = _safe_str(scenario.get("goal"), "(none)")
        context = _safe_str(scenario.get("project_context"), "(none)")
        event_types = ", ".join(_extract_event_types(events)) or "(none)"
        return (
            f"{self.panel_prompt}\n\n"
            f"Persona: {role}\n"
            f"Traits: {traits}\n"
            f"Scenario goal: {goal}\n"
            f"Scenario context: {context}\n"
            f"Turn: {turn}\n"
            f"Action taken: {action}\n"
            f"Consecutive failures: {consecutive_failures}\n"
            f"Event types: {event_types}\n"
            f"Artifacts: {', '.join(artifacts) if artifacts else '(none)'}\n"
            "Screenshot summary:\n"
            + "\n".join(f"- {line}" for line in screenshot_summary)
            + "\n\n"
            "Return exactly one JSON object with keys: reaction, pain_points, next_hypothesis. "
            "Do not include markdown fences or extra prose. "
            "Keep reaction to one short DM-style sentence. "
            "Keep next_hypothesis to one concise sentence. "
            f"Allowed pain point category values: {', '.join(DEFAULT_PAIN_TAXONOMY)}. "
            "pain_points should be an array of objects: "
            'category, severity (0..1), symptom, evidence (array), likely_cause. '
            "Also include simulated_user_quotes: 1-3 first-person quotes that a simulated user would say out loud "
            "right now, grounded only in visible UI evidence from this screenshot and events "
            "(no hidden internals). Each quote object must include quote, sentiment, confidence (0..1), evidence[]"
        )

    def _normalize_review(self, payload: dict[str, Any]) -> dict[str, Any]:
        reaction_value = payload.get("reaction")
        reaction = _safe_str(reaction_value, "")
        if not reaction and isinstance(reaction_value, dict):
            reaction = _safe_str(
                reaction_value.get("dm_style_reaction")
                or reaction_value.get("dm")
                or reaction_value.get("text")
                or reaction_value.get("message"),
                "",
            )
        if not reaction and isinstance(reaction_value, list):
            for item in reaction_value:
                if isinstance(item, str) and item.strip():
                    reaction = item.strip()
                    break
                if isinstance(item, dict):
                    reaction = _safe_str(
                        item.get("dm_style_reaction")
                        or item.get("dm")
                        or item.get("text")
                        or item.get("message"),
                        "",
                    )
                    if reaction:
                        break
        next_hypothesis = _safe_str(payload.get("next_hypothesis"), "")
        points = []
        for raw in _safe_list(payload.get("pain_points")):
            if not isinstance(raw, dict):
                continue
            category = _safe_str(raw.get("category"))
            if category not in DEFAULT_PAIN_TAXONOMY:
                continue
            severity = min(1.0, max(0.0, _safe_float(raw.get("severity"), 0.0)))
            symptom = _safe_str(raw.get("symptom"))
            evidence = [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()]
            likely_cause = _safe_str(raw.get("likely_cause"), None)
            point = {
                "category": category,
                "severity": severity,
                "symptom": symptom,
                "evidence": evidence,
            }
            if likely_cause:
                point["likely_cause"] = likely_cause
            points.append(point)
        quotes = self._normalize_simulated_quotes(
            payload.get("simulated_user_quotes")
            or payload.get("simulated_quotes")
            or payload.get("quotes")
            or payload.get("verbatims")
        )
        return {
            "reaction": reaction,
            "next_hypothesis": next_hypothesis,
            "pain_points": points,
            "simulated_user_quotes": quotes,
        }

    @staticmethod
    def _normalize_simulated_quotes(raw_quotes: Any) -> list[dict[str, Any]]:
        quotes: list[dict[str, Any]] = []
        for raw in _safe_list(raw_quotes):
            if not isinstance(raw, dict):
                continue
            quote = _safe_str(
                raw.get("quote")
                or raw.get("verbatim")
                or raw.get("text")
                or raw.get("utterance"),
                "",
            )
            if not quote:
                continue
            sentiment = _safe_str(raw.get("sentiment"), "uncertain").strip().lower()
            if sentiment not in {"positive", "neutral", "negative", "mixed", "uncertain"}:
                sentiment = "uncertain"
            confidence = min(1.0, max(0.0, _safe_float(raw.get("confidence"), 0.5)))
            evidence = [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()][:4]
            quote_entry = {
                "quote": quote,
                "sentiment": sentiment,
                "confidence": confidence,
                "evidence": evidence,
            }
            quotes.append(quote_entry)
        return quotes[:3]

    @staticmethod
    def _parse_json_block(text: str) -> dict[str, Any] | None:
        stripped = text.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                return None
        decoder = json.JSONDecoder()
        for start in [idx for idx, char in enumerate(text) if char == "{"][:6]:
            fragment = text[start:]
            try:
                parsed, _ = decoder.raw_decode(fragment)
                if isinstance(parsed, dict):
                    return parsed
            except Exception:
                continue
        return None

    @staticmethod
    def _extract_output_text(response: dict[str, Any]) -> str:
        direct_output_text = response.get("output_text")
        if isinstance(direct_output_text, str) and direct_output_text.strip():
            return direct_output_text.strip()
        if isinstance(direct_output_text, list):
            top_level_texts: list[str] = []
            for value in direct_output_text:
                if isinstance(value, str) and value.strip():
                    top_level_texts.append(value)
                elif isinstance(value, dict):
                    text = value.get("text") or value.get("content")
                    if isinstance(text, str) and text.strip():
                        top_level_texts.append(text)
            if top_level_texts:
                return "\n".join(top_level_texts).strip()

        out = response.get("output")
        if isinstance(out, list):
            texts: list[str] = []
            for item in out:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if isinstance(content, list):
                    for chunk in content:
                        if not isinstance(chunk, dict):
                            continue
                        if chunk.get("type") == "output_text":
                            text = chunk.get("text") or chunk.get("content")
                            if isinstance(text, str):
                                texts.append(text)
                        elif chunk.get("type") in {"output_json", "json", "json_schema"}:
                            json_value = chunk.get("json") or chunk.get("value") or chunk.get("content")
                            if isinstance(json_value, (dict, list)):
                                texts.append(json.dumps(json_value, ensure_ascii=False))
                            elif isinstance(json_value, str) and json_value.strip():
                                texts.append(json_value.strip())
                if item.get("type") == "text" and isinstance(item.get("text"), str):
                    texts.append(item.get("text"))
                if item.get("type") in {"output_json", "json", "json_schema"}:
                    json_value = item.get("json") or item.get("value") or item.get("content")
                    if isinstance(json_value, (dict, list)):
                        texts.append(json.dumps(json_value, ensure_ascii=False))
                    elif isinstance(json_value, str) and json_value.strip():
                        texts.append(json_value.strip())
            if texts:
                return "\n".join(texts).strip()
        direct_text = response.get("text")
        if isinstance(direct_text, str) and direct_text.strip():
            return direct_text.strip()
        if isinstance(direct_text, dict):
            text_value = direct_text.get("value") or direct_text.get("text") or direct_text.get("content")
            if isinstance(text_value, str) and text_value.strip():
                return text_value.strip()
        return ""

    @staticmethod
    def _extract_output_json(response: dict[str, Any]) -> dict[str, Any] | None:
        direct = response.get("output_parsed")
        if isinstance(direct, dict):
            return direct
        out = response.get("output")
        if isinstance(out, list):
            for item in out:
                if not isinstance(item, dict):
                    continue
                item_json = item.get("json") or item.get("parsed")
                if isinstance(item_json, dict):
                    return item_json
                content = item.get("content")
                if isinstance(content, list):
                    for chunk in content:
                        if not isinstance(chunk, dict):
                            continue
                        value = chunk.get("json") or chunk.get("parsed") or chunk.get("value")
                        if isinstance(value, dict):
                            return value
        return None

    @staticmethod
    def _response_incomplete_due_to_tokens(response: dict[str, Any]) -> bool:
        status = _safe_str(response.get("status"), "").strip().lower()
        if status != "incomplete":
            return False
        details = _safe_dict(response.get("incomplete_details"))
        reason = _safe_str(details.get("reason"), "").strip().lower()
        return reason == "max_output_tokens"

    @staticmethod
    def _post_json(
        url: str,
        payload: dict[str, Any],
        api_key: str,
        *,
        timeout_s: float = 45.0,
    ) -> tuple[int, dict[str, Any]]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = Request(url, data=body, method="POST")
        request.add_header("Authorization", f"Bearer {api_key}")
        request.add_header("Content-Type", "application/json")
        try:
            with urlopen(request, timeout=timeout_s) as response:
                status = int(getattr(response, "status", 200))
                raw = response.read().decode("utf-8", errors="ignore")
            return status, json.loads(raw or "{}")
        except HTTPError as exc:
            status = int(getattr(exc, "code", 500))
            try:
                raw = exc.read().decode("utf-8", errors="ignore")
            except Exception:
                raw = ""
            try:
                parsed = json.loads(raw or "{}")
            except Exception:
                parsed = {"error": {"message": raw or str(exc)}}
            parsed["_http_error_status"] = status
            parsed["_http_error_body"] = _truncate_text(raw or str(exc), 4000)
            return status, _safe_dict(parsed)

    @staticmethod
    def _encode_image(path: Path) -> str | None:
        if Image is None or not path.exists():
            return None
        try:
            image = Image.open(path).convert("RGB")
            image.thumbnail((1200, 1200))
            buffer = BytesIO()
            image.save(buffer, format="PNG")
            encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
            return f"data:image/png;base64,{encoded}"
        except Exception:
            return None


def _report_llm_markdown(
    *,
    model: str | None,
    prompt: str,
    timeout_s: float = 60.0,
) -> str | None:
    requested_model = _safe_str(model, "").strip()
    resolved_model, inferred_reasoning_effort = _resolve_panel_model_alias(requested_model)
    if not resolved_model:
        return None
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_TOKEN")
    if not api_key:
        return None
    api_base = os.getenv("OPENAI_API_BASE") or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    endpoint = f"{api_base.rstrip('/')}/responses"
    reasoning_effort = _effective_reasoning_effort_for_model(
        resolved_model,
        inferred_reasoning_effort,
        default="low",
    )
    last_text = ""
    for max_output_tokens in (1600, 2600, 3600):
        payload: dict[str, Any] = {
            "model": resolved_model,
            "input": [{"role": "user", "content": [{"type": "input_text", "text": prompt}]}],
            "max_output_tokens": max_output_tokens,
            "text": {"format": {"type": "text"}},
        }
        if reasoning_effort:
            payload["reasoning"] = {"effort": reasoning_effort}
        try:
            status, response = PanelReviewer._post_json(endpoint, payload, api_key, timeout_s=timeout_s)
            if _is_reasoning_effort_unsupported_error(status, _safe_dict(response)) and "reasoning" in payload:
                retry_payload = dict(payload)
                retry_payload.pop("reasoning", None)
                status, response = PanelReviewer._post_json(endpoint, retry_payload, api_key, timeout_s=timeout_s)
        except Exception:
            return None
        if not status or status < 200 or status >= 300:
            return None
        text = PanelReviewer._extract_output_text(response).strip()
        if text:
            last_text = text
        if text and not PanelReviewer._response_incomplete_due_to_tokens(_safe_dict(response)):
            return text
    return last_text or None


def _synthesis_fallback_reflection(
    *,
    turn: int,
    action: str,
    assistant_lines: list[str],
    delta_events: list[dict[str, Any]],
    duration_s: float,
    screenshot_path: Path,
    screenshot_phase: str,
    screenshot_summary: list[str],
    consecutive_failures: int,
    artifact_paths: list[str],
) -> dict[str, Any]:
    event_types = _extract_event_types(delta_events)
    pains = _build_pain_points(
        action=action,
        events=delta_events,
        duration_s=duration_s,
        consecutive_failures=consecutive_failures,
    )
    what_worked, what_failed = _summarize_turn_outcome(
        action=action,
        events=delta_events,
        artifact_paths=artifact_paths,
    )
    if not what_failed and any(event == "generation_failed" for event in event_types):
        what_failed = "The attempt failed in this turn."
    open_questions: list[str] = []
    if not artifact_paths and action.startswith("/"):
        open_questions.append("I am not sure this action actually did anything.")
    if consecutive_failures >= 2:
        open_questions.append("I'm stuck and not sure what to try next.")
    next_hypothesis = "Try a simpler /use + /diagnose flow first."
    if artifact_paths:
        next_hypothesis = "Run a generation ability using one clear source image."
    if any(event.endswith("_failed") for event in event_types):
        next_hypothesis = "Retry with lower complexity and one source image."
    confidence = 0.8 if artifact_paths else 0.35
    return {
        "turn": turn,
        "timestamp": _utc_now_iso(),
        "action_taken": {"input": action},
        "observed_signals": event_types,
        "what_worked": what_worked,
        "what_failed": what_failed,
        "open_questions": open_questions,
        "next_hypothesis": next_hypothesis,
        "confidence": confidence,
        "consecutive_failures": consecutive_failures,
        "screenshot_path": str(screenshot_path),
        "screenshot_phase": screenshot_phase,
        "screenshot_delta": screenshot_summary,
        "assistant_output_lines": assistant_lines,
        "reaction": "",
        "pain_points": pains,
        "simulated_user_quotes": [],
        "artifact_paths": artifact_paths,
        "duration_s": round(duration_s, 3),
    }


def _build_reflection(
    *,
    turn: int,
    action: str,
    assistant_lines: list[str],
    delta_events: list[dict[str, Any]],
    duration_s: float,
    screenshot_path: Path,
    screenshot_phase: str,
    screenshot_summary: list[str],
    consecutive_failures: int,
    artifact_paths: list[str],
    review: dict[str, Any] | None,
) -> dict[str, Any]:
    if review is None:
        return _synthesis_fallback_reflection(
            turn=turn,
            action=action,
            assistant_lines=assistant_lines,
            delta_events=delta_events,
            duration_s=duration_s,
            screenshot_path=screenshot_path,
            screenshot_phase=screenshot_phase,
            screenshot_summary=screenshot_summary,
            consecutive_failures=consecutive_failures,
            artifact_paths=artifact_paths,
        )

    event_types = _extract_event_types(delta_events)
    reaction = _safe_str(review.get("reaction"), "")
    pain_points = _safe_list(review.get("pain_points"))
    next_hypothesis = _safe_str(review.get("next_hypothesis"), "")
    simulated_user_quotes = [q for q in _safe_list(review.get("simulated_user_quotes")) if isinstance(q, dict)]

    what_worked, what_failed = _summarize_turn_outcome(
        action=action,
        events=delta_events,
        artifact_paths=artifact_paths,
    )
    if any(event == "generation_failed" for event in event_types):
        what_failed = "Generation failed after taking this action."
    open_questions = []
    if not artifact_paths and action.startswith("/"):
        open_questions.append("I want to understand if this action was the right next step.")
    if not next_hypothesis:
        next_hypothesis = "Move to a simpler single-step action."
    if any(event in {"image_diagnosis_failed", "canvas_context_failed"} for event in event_types):
        open_questions.append("Could this step be made safer for a non-technical setup?")

    return {
        "turn": turn,
        "timestamp": _utc_now_iso(),
        "action_taken": {"input": action},
        "observed_signals": event_types,
        "what_worked": what_worked,
        "what_failed": what_failed,
        "open_questions": open_questions,
        "next_hypothesis": next_hypothesis,
        "confidence": 0.7 if artifact_paths else 0.35,
        "consecutive_failures": consecutive_failures,
        "screenshot_path": str(screenshot_path),
        "screenshot_phase": screenshot_phase,
        "screenshot_delta": screenshot_summary,
        "assistant_output_lines": assistant_lines,
        "reaction": reaction,
        "pain_points": pain_points,
        "simulated_user_quotes": simulated_user_quotes,
        "artifact_paths": artifact_paths,
        "duration_s": round(duration_s, 3),
    }


def _assign_quote_ids_to_reflection(reflection: dict[str, Any]) -> list[dict[str, Any]]:
    turn = max(0, _safe_int(reflection.get("turn"), 0))
    normalized_quotes: list[dict[str, Any]] = []
    for idx, raw in enumerate(_safe_list(reflection.get("simulated_user_quotes")), start=1):
        if not isinstance(raw, dict):
            continue
        quote = _safe_str(raw.get("quote"), "")
        if not quote:
            continue
        quote_id = _safe_str(raw.get("quote_id"), "").strip() or f"q-t{turn:02d}-{idx:02d}"
        sentiment = _safe_str(raw.get("sentiment"), "uncertain").strip().lower()
        if sentiment not in {"positive", "neutral", "negative", "mixed", "uncertain"}:
            sentiment = "uncertain"
        confidence = min(1.0, max(0.0, _safe_float(raw.get("confidence"), 0.5)))
        evidence = [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()][:4]
        normalized_quotes.append(
            {
                "quote_id": quote_id,
                "quote": quote,
                "sentiment": sentiment,
                "confidence": confidence,
                "evidence": evidence,
            }
        )
    reflection["simulated_user_quotes"] = normalized_quotes
    return normalized_quotes


def _objective_signals_for_scenario(
    *,
    scenario_id: str,
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    normalized_scenario = _safe_str(scenario_id, "").strip()
    if normalized_scenario != "mother_three_photo_accept_flow":
        return {}

    reached_offering = False
    reached_cooldown = False
    max_canvas_fit_images = 0

    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = _safe_str(event.get("type"), "").strip().lower()
        if event_type == "mother_confirm":
            reached_phase = (
                _safe_str(event.get("reached_phase"), "").strip().lower()
                or _safe_str(event.get("after"), "").strip().lower()
            )
            if reached_phase == "offering":
                reached_offering = True
            elif reached_phase == "cooldown":
                reached_cooldown = True
            continue

        if event_type == "mother_state":
            state = _safe_dict(event.get("state"))
            mother = _safe_dict(state.get("mother"))
            phase = (
                _safe_str(mother.get("phase"), "").strip().lower()
                or _safe_str(state.get("mother_phase"), "").strip().lower()
            )
            if phase == "offering":
                reached_offering = True
            elif phase == "cooldown":
                reached_cooldown = True
            continue

        if event_type == "canvas_view_fitted":
            max_canvas_fit_images = max(max_canvas_fit_images, _safe_int(event.get("image_count"), 0))

    objective_pass = reached_offering and reached_cooldown and max_canvas_fit_images >= 4
    return {
        "scenario_rule": "mother_three_photo_accept_flow:offering_then_cooldown_and_fit4",
        "reached_offering": reached_offering,
        "reached_cooldown": reached_cooldown,
        "max_canvas_fit_images": max_canvas_fit_images,
        "objective_pass": objective_pass,
    }


def _score_run(
    *,
    reflections: list[dict[str, Any]],
    required_abilities: list[str],
    used_abilities: set[str],
    run_cost: float,
    max_cost_usd: float,
    runtime_s: float,
    max_runtime_s: float,
    scenario_id: str = "",
    events_tail: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    required = [str(v) for v in required_abilities if str(v).strip()]
    used = [a for a in used_abilities if a in set(required)]
    artifact_paths = sorted({path for ref in reflections for path in _safe_list(ref.get("artifact_paths"))})
    pain_points = [pt for ref in reflections for pt in _safe_list(ref.get("pain_points"))]
    average_pain = (
        sum(_safe_float(pt.get("severity"), 0.0) for pt in pain_points) / max(1, len(pain_points))
        if pain_points
        else 0.0
    )
    friction_profile = max(0.0, 1.0 - average_pain)
    artifact_quality_proxy = min(1.0, len(artifact_paths) / max(1, max(1, len(required) or 2)))
    ability_usage_quality = 1.0 if not required else len(used) / len(required)
    goal_progress = 0.0
    if reflections:
        if len(used) > 0:
            goal_progress += 0.55
        if artifact_paths:
            goal_progress += 0.3 if len(artifact_paths) else 0.0
        if len(reflections) >= 2:
            goal_progress += 0.15
    efficiency_cost_time = max(0.0, 1.0 - (runtime_s / max(1.0, max_runtime_s)))
    resilience = max(0.0, 1.0 - (average_pain * 0.85))
    reflection_quality = 0.5 + (0.2 if any(ref.get("reaction") for ref in reflections) else 0.0)
    reflection_quality = min(1.0, reflection_quality)
    budget_used = run_cost > max_cost_usd if max_cost_usd > 0 else False
    objective_signals = _objective_signals_for_scenario(
        scenario_id=scenario_id,
        events=events_tail or [],
    )
    objective_pass = _safe_bool(objective_signals.get("objective_pass"), False)
    if objective_pass:
        goal_progress = max(goal_progress, 0.85)
        friction_profile = max(friction_profile, 0.62)

    goal_progress = min(1.0, max(0.0, goal_progress))
    ability_usage_quality = min(1.0, max(0.0, ability_usage_quality))
    artifact_quality_proxy = min(1.0, max(0.0, artifact_quality_proxy))
    efficiency_cost_time = min(1.0, max(0.0, efficiency_cost_time))
    resilience = min(1.0, max(0.0, resilience))
    friction_profile = min(1.0, max(0.0, friction_profile))
    reflection_quality = min(1.0, max(0.0, reflection_quality))
    raw_score_total = (
        (goal_progress * 0.35)
        + (artifact_quality_proxy * 0.20)
        + (ability_usage_quality * 0.12)
        + (min(1.0, efficiency_cost_time) * 0.12)
        + (resilience * 0.08)
        + (reflection_quality * 0.05)
        + (friction_profile * 0.18)
    )
    # Composite terms can exceed 1.0 even for valid runs; keep user-facing score normalized.
    score_total = round(min(1.0, max(0.0, raw_score_total)), 4)
    if objective_pass:
        score_total = max(score_total, 0.66)

    baseline_goal_pass = bool(
        goal_progress >= 0.7
        and (not required or bool(used))
        and score_total >= 0.6
        and friction_profile >= 0.6
    )
    goal_pass = bool((baseline_goal_pass or objective_pass) and not budget_used)
    return {
        "goal_progress": round(goal_progress, 4),
        "artifact_quality_proxy": round(artifact_quality_proxy, 4),
        "ability_usage_quality": round(ability_usage_quality, 4),
        "efficiency_cost_time": round(efficiency_cost_time, 4),
        "resilience": round(resilience, 4),
        "reflection_quality": round(reflection_quality, 4),
        "friction_profile": round(friction_profile, 4),
        "goal_pass": goal_pass,
        "score_total": score_total,
        "required_abilities": required,
        "used_abilities": sorted(used),
        "artifact_count": len(artifact_paths),
        "pain_points_count": len(pain_points),
        "budget_used": budget_used,
        "objective_pass": objective_pass,
        "objective_signals": objective_signals,
    }


def _summarize_turn_outcome(
    *,
    action: str,
    events: list[dict[str, Any]],
    artifact_paths: list[str],
) -> tuple[str, str]:
    if artifact_paths:
        count = len(artifact_paths)
        return (
            f"Generated {count} output artifact{'s' if count != 1 else ''}.",
            "",
        )

    first_ui_failed: dict[str, Any] | None = None
    first_ui_performed: dict[str, Any] | None = None
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = _safe_str(event.get("type"), "").strip().lower()
        if event_type == "ui_action_failed" and first_ui_failed is None:
            first_ui_failed = event
        elif event_type == "ui_action_performed" and first_ui_performed is None:
            first_ui_performed = event

    if first_ui_failed is not None:
        ui_detail = _safe_str(first_ui_failed.get("ui_detail"), "")
        what_failed = ui_detail or "A UI automation action failed in this turn."
        return "UI interaction attempted.", what_failed

    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = _safe_str(event.get("type"), "").strip().lower()
        if event_type == "mother_confirm":
            before = _safe_str(event.get("before"), "unknown")
            after = _safe_str(event.get("after"), "unknown")
            return f"Mother confirm executed ({before} -> {after}).", ""
        if event_type == "mother_reject":
            before = _safe_str(event.get("before"), "unknown")
            after = _safe_str(event.get("after"), "unknown")
            return f"Mother reject executed ({before} -> {after}).", ""
        if event_type == "mother_next_proposal":
            before = _safe_str(event.get("before"), "unknown")
            after = _safe_str(event.get("after"), "unknown")
            return f"Mother suggestion cycled ({before} -> {after}).", ""
        if event_type == "canvas_mode_set":
            before = _safe_str(event.get("prev"), "unknown")
            after = _safe_str(event.get("next"), "unknown")
            return f"Canvas mode changed ({before} -> {after}).", ""
        if event_type == "canvas_view_updated":
            scale = event.get("scale")
            if isinstance(scale, (float, int)):
                return f"Canvas view updated (scale={round(float(scale), 3)}).", ""
            dx = event.get("dx")
            dy = event.get("dy")
            if isinstance(dx, (float, int)) or isinstance(dy, (float, int)):
                dx_text = round(float(dx), 2) if isinstance(dx, (float, int)) else 0.0
                dy_text = round(float(dy), 2) if isinstance(dy, (float, int)) else 0.0
                return f"Canvas pan applied (dx={dx_text}, dy={dy_text}).", ""
            return "Canvas view updated.", ""
        if event_type == "canvas_context":
            return "Canvas context snapshot captured.", ""
        if event_type == "triplet_rule":
            return "Rule extraction output captured.", ""
        if event_type == "image_description":
            return "Image description output captured.", ""
        if event_type == "plan_preview":
            return "Generation plan prepared.", ""

    if first_ui_performed is not None:
        ui_op = _safe_str(first_ui_performed.get("ui_op"), "").strip()
        ui_detail = _safe_str(first_ui_performed.get("ui_detail"), "").strip()
        if ui_detail:
            return ui_detail, ""
        if ui_op:
            return f"UI action executed ({ui_op}).", ""

    if action.startswith("/"):
        return "Command executed with limited visible feedback.", ""
    return "No visible result from this turn.", ""


def _build_report_text(*, scenario_id: str, persona_id: str, turns: int, scorecard: dict[str, Any], reflections: list[dict[str, Any]]) -> str:
    lines = [
        "# Target User Harness Scenario Report",
        f"- Scenario: {scenario_id}",
        f"- Persona: {persona_id}",
        f"- Turns: {turns}",
        f"- Status: {'pass' if scorecard.get('goal_pass') else 'fail'}",
        f"- Score: {scorecard.get('score_total')}",
        "",
        "## Summary",
    ]
    for idx, reflection in enumerate(reflections[:25], start=1):
        what_worked = _safe_str(reflection.get("what_worked"), "no signal")
        what_failed = _safe_str(reflection.get("what_failed"), "")
        reaction = _safe_str(reflection.get("reaction"), "")
        lines.append(f"{idx}. {what_worked}")
        if what_failed:
            lines.append(f"   - issue: {what_failed}")
        if reaction:
            lines.append(f"   - reaction: {reaction[:200]}")
        for quote in _safe_list(reflection.get("simulated_user_quotes"))[:2]:
            if not isinstance(quote, dict):
                continue
            quote_text = _safe_str(quote.get("quote"), "")
            if not quote_text:
                continue
            quote_id = _safe_str(quote.get("quote_id"), "") or f"q-t{idx:02d}-na"
            lines.append(f"   - simulated_quote[{quote_id}]: \"{quote_text[:220]}\"")
    if not reflections:
        lines.append("- no turns executed")
    return "\n".join(lines) + "\n"


def _build_usability_report_prompt(
    *,
    scenario_id: str,
    persona_id: str,
    scenario: dict[str, Any],
    scorecard: dict[str, Any],
    reflections: list[dict[str, Any]],
) -> str:
    compact_reflections: list[dict[str, Any]] = []
    for reflection in reflections[:24]:
        if not isinstance(reflection, dict):
            continue
        turn = _safe_int(reflection.get("turn"), 0)
        quotes: list[dict[str, Any]] = []
        for idx, raw in enumerate(_safe_list(reflection.get("simulated_user_quotes"))[:3], start=1):
            if not isinstance(raw, dict):
                continue
            quote_text = _safe_str(raw.get("quote"), "")
            if not quote_text:
                continue
            quote_id = _safe_str(raw.get("quote_id"), "").strip() or f"q-t{turn:02d}-{idx:02d}"
            quotes.append(
                {
                    "quote_id": quote_id,
                    "quote": quote_text,
                    "sentiment": _safe_str(raw.get("sentiment"), "uncertain"),
                    "confidence": min(1.0, max(0.0, _safe_float(raw.get("confidence"), 0.5))),
                    "evidence": [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()][:4],
                }
            )
        compact_reflections.append(
            {
                "turn": turn,
                "action": _safe_str(_safe_dict(reflection.get("action_taken")).get("input"), ""),
                "observed_signals": _safe_list(reflection.get("observed_signals"))[:10],
                "what_worked": _safe_str(reflection.get("what_worked"), ""),
                "what_failed": _safe_str(reflection.get("what_failed"), ""),
                "open_questions": _safe_list(reflection.get("open_questions"))[:3],
                "pain_points": _safe_list(reflection.get("pain_points"))[:3],
                "reaction": _safe_str(reflection.get("reaction"), "")[:280],
                "duration_s": _safe_float(reflection.get("duration_s"), 0.0),
                "simulated_user_quotes": quotes,
            }
        )

    payload = {
        "scenario_id": scenario_id,
        "persona_id": persona_id,
        "goal": _safe_str(scenario.get("goal"), ""),
        "project_context": _safe_str(scenario.get("project_context"), ""),
        "success_criteria": _safe_list(scenario.get("success_criteria")),
        "required_abilities": _safe_list(scenario.get("required_abilities")),
        "scorecard": scorecard,
        "turn_reflections": compact_reflections,
    }
    return (
        "Generate a concise markdown usability report for this scenario run.\n"
        "You must reason from the provided structured run evidence only.\n"
        "Output format:\n"
        "# Target User Harness Scenario Report\n"
        "## Executive Summary\n"
        "## Simulated User Verbatims\n"
        "## What Worked\n"
        "## Pain Points\n"
        "## Recommended UX Improvements (prioritized)\n"
        "## Evidence Snippets\n"
        "In `Simulated User Verbatims`, include at least 3 first-person quotes when available.\n"
        "Prefix each quote with [quote_id] and treat these as simulated-user quotes (not real interviews).\n"
        "Each recommended UX improvement must cite one or more quote IDs.\n"
        "Keep recommendations concrete and product-actionable.\n\n"
        "Run data:\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _build_ux_improvements_report(*, run_summaries: list[dict[str, Any]], generated_at: str, dry_run: bool) -> str:
    lines = [
        "# Target User Harness UX Improvements",
        f"- Generated at: {generated_at}",
        f"- Runs captured: {len(run_summaries)}",
    ]
    if not run_summaries:
        lines.extend(
            [
                "",
                "## Summary",
                "No scenario runs were captured, so no UX recommendations were generated.",
            ]
        )
        return "\n".join(lines) + "\n"

    dry_runs = [item for item in run_summaries if _safe_bool(item.get("dry_run"), False)]
    analyzed = [item for item in run_summaries if not _safe_bool(item.get("dry_run"), False)]
    lines.append(f"- Dry-run mode: {'yes' if dry_run else 'no'}")
    if dry_runs:
        lines.append(f"- Dry-run scenarios: {len(dry_runs)}")

    if not analyzed:
        lines.extend(
            [
                "",
                "## Summary",
                "Only dry-run scenarios were executed. Run without `--dry-run` to generate evidence-based UX improvements.",
            ]
        )
        return "\n".join(lines) + "\n"

    pass_count = sum(1 for item in analyzed if _safe_str(_safe_dict(item.get("scorecard")).get("status"), "") == "pass")
    fail_count = len(analyzed) - pass_count
    panel_warning_count = sum(len(_safe_list(item.get("panel_warnings"))) for item in analyzed)
    scenario_rows: list[dict[str, Any]] = []
    for item in analyzed:
        score = _safe_dict(item.get("scorecard"))
        panel_warnings = _safe_list(item.get("panel_warnings"))
        first_warning = _safe_dict(panel_warnings[0]) if panel_warnings else {}
        scenario_rows.append(
            {
                "scenario_id": _safe_str(item.get("scenario_id"), "unknown_scenario"),
                "status": _safe_str(score.get("status"), _safe_str(item.get("status"), "unknown")),
                "goal_pass": _safe_bool(score.get("goal_pass"), False),
                "panel_warning_count": len(panel_warnings),
                "first_warning_status": _safe_str(first_warning.get("status"), ""),
                "first_warning_error": _safe_str(first_warning.get("error"), ""),
            }
        )
    lines.extend(
        [
            "",
            "## Outcome Summary",
            f"- Scenarios analyzed: {len(analyzed)}",
            f"- Pass: {pass_count}",
            f"- Fail: {fail_count}",
            f"- Panel review warnings: {panel_warning_count}",
        ]
    )
    lines.extend(["", "## Scenario Outcome Breakdown"])
    for row in scenario_rows:
        lines.append(
            f"- `{row['scenario_id']}`: status={row['status'] or 'unknown'}, "
            f"goal_pass={'yes' if _safe_bool(row.get('goal_pass'), False) else 'no'}, "
            f"panel_warnings={_safe_int(row.get('panel_warning_count'), 0)}"
        )

    category_stats: dict[str, dict[str, Any]] = {}
    for item in analyzed:
        scenario_id = _safe_str(item.get("scenario_id"), "unknown_scenario")
        persona_id = _safe_str(item.get("persona_id"), "unknown_persona")
        reflections = _safe_list(item.get("reflections"))
        for reflection in reflections:
            if not isinstance(reflection, dict):
                continue
            for raw in _safe_list(reflection.get("pain_points")):
                point = _safe_dict(raw)
                category = _safe_str(point.get("category"), "")
                if not category:
                    continue
                bucket = category_stats.setdefault(
                    category,
                    {
                        "count": 0,
                        "severity_sum": 0.0,
                        "severity_max": 0.0,
                        "scenarios": set(),
                        "personas": set(),
                        "symptoms": [],
                    },
                )
                severity = min(1.0, max(0.0, _safe_float(point.get("severity"), 0.0)))
                bucket["count"] += 1
                bucket["severity_sum"] += severity
                bucket["severity_max"] = max(_safe_float(bucket.get("severity_max"), 0.0), severity)
                bucket["scenarios"].add(scenario_id)
                bucket["personas"].add(persona_id)
                symptom = _safe_str(point.get("symptom"), "").strip()
                if symptom and symptom not in bucket["symptoms"] and len(bucket["symptoms"]) < 4:
                    bucket["symptoms"].append(symptom)

    ranked_categories = sorted(
        category_stats.items(),
        key=lambda kv: (
            _safe_float(kv[1].get("severity_sum"), 0.0),
            _safe_int(kv[1].get("count"), 0),
            len(kv[1].get("scenarios") or set()),
        ),
        reverse=True,
    )

    lines.extend(["", "## Pain Clusters"])
    if not ranked_categories:
        lines.append("- No pain points were recorded in reflections.")
        if panel_warning_count:
            lines.append(
                "- Panel responses were empty/invalid on one or more turns; "
                "see each run's `panel_responses.jsonl` for exact failures."
            )
    else:
        for category, stats in ranked_categories:
            count = _safe_int(stats.get("count"), 0)
            severity_sum = _safe_float(stats.get("severity_sum"), 0.0)
            avg = severity_sum / max(1, count)
            scenarios = sorted(str(v) for v in (stats.get("scenarios") or set()))
            lines.append(
                f"- `{category}`: count={count}, avg_severity={avg:.2f}, scenarios={', '.join(scenarios) or 'n/a'}"
            )

    lines.extend(["", "## Proposed UX Improvements"])
    if not ranked_categories:
        if panel_warning_count:
            lines.append("1. Restore scenario-specific panel evidence reliability")
            for row in scenario_rows:
                warning_count = _safe_int(row.get("panel_warning_count"), 0)
                if warning_count <= 0:
                    continue
                status = _safe_str(row.get("first_warning_status"), "unknown")
                error = _safe_str(row.get("first_warning_error"), "n/a")
                lines.append(
                    f"- Scenario `{row['scenario_id']}`: {warning_count} panel warning(s); "
                    f"first warning `{status}` ({error})."
                )
            lines.append(
                "- Proposed change: enforce a compatible strict-output schema and fallback parsing for each panel response."
            )
            lines.append(
                "- Success metric: each scenario shows 0 panel warnings and yields at least one non-empty, parseable reflection."
            )
        else:
            lines.append("1. Capture stronger scenario-specific friction signals")
            for row in scenario_rows:
                if _safe_str(row.get("status"), "").lower() == "pass":
                    continue
                lines.append(
                    f"- Scenario `{row['scenario_id']}` failed without categorized pain points; add targeted post-action checks."
                )
            lines.append(
                "- Proposed change: add scenario-tailored assertions (expected events + visual checkpoints) to improve root-cause specificity."
            )
            lines.append(
                "- Success metric: every failed scenario records at least one categorized pain point tied to a concrete action."
            )
    else:
        for idx, (category, stats) in enumerate(ranked_categories, start=1):
            play = PAIN_IMPROVEMENT_PLAYBOOK.get(
                category,
                {
                    "title": f"Address `{category}` friction",
                    "proposal": "Add focused guidance and safer defaults for this interaction pattern.",
                    "metric": "Reduce recurrence of this pain category across scenarios.",
                },
            )
            count = _safe_int(stats.get("count"), 0)
            avg = _safe_float(stats.get("severity_sum"), 0.0) / max(1, count)
            scenarios = sorted(str(v) for v in (stats.get("scenarios") or set()))
            symptoms = [str(v) for v in _safe_list(stats.get("symptoms")) if str(v).strip()]
            lines.append(f"{idx}. {play.get('title')}")
            lines.append(f"- Category: `{category}`")
            lines.append(
                f"- Evidence: {count} pain points across {len(scenarios)} scenario(s), average severity {avg:.2f}"
            )
            lines.append(f"- Proposed change: {play.get('proposal')}")
            lines.append(f"- Success metric: {play.get('metric')}")
            if symptoms:
                lines.append(f"- Example symptom: {symptoms[0]}")

    lines.extend(["", "## Next Build Targets"])
    if ranked_categories:
        top = [category for category, _ in ranked_categories[:3]]
        lines.append(f"- Prioritize fixes for: {', '.join(top)}")
        lines.append("- Re-run harness with same scenarios and compare pain cluster deltas.")
        lines.append("- Validate fixes against screenshot-coupled reflections, not only pass/fail scores.")
    else:
        if panel_warning_count:
            impacted = [str(row["scenario_id"]) for row in scenario_rows if _safe_int(row.get("panel_warning_count"), 0) > 0]
            if impacted:
                lines.append(
                    "- Resolve panel-response issues for: "
                    + ", ".join(f"`{sid}`" for sid in impacted)
                    + "."
                )
            lines.append("- Re-run the same scenarios to regenerate prioritized recommendations from real reflections.")
        else:
            lines.append(
                "- Expand scenario coverage with higher-friction tasks to generate prioritized recommendations."
            )

    return "\n".join(lines) + "\n"


def _build_ten_x_competitive_edge_report(
    *,
    run_summaries: list[dict[str, Any]],
    scenarios: list[dict[str, Any]],
    generated_at: str,
    dry_run: bool,
) -> str:
    lines = [
        "# Features or Problems Solved That Could Make Brood 10x Better Than the Nearest Competitor",
        f"- Generated at: {generated_at}",
        f"- Runs captured: {len(run_summaries)}",
        f"- Dry-run mode: {'yes' if dry_run else 'no'}",
    ]

    category_stats: dict[str, dict[str, Any]] = {}
    analyzed = [item for item in run_summaries if not _safe_bool(item.get("dry_run"), False)]
    scenario_lookup: dict[str, dict[str, Any]] = {}
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        sid = _safe_str(scenario.get("id"), "").strip()
        if sid:
            scenario_lookup[sid] = scenario
    scenario_rows: list[dict[str, Any]] = []
    for item in analyzed:
        scenario_id = _safe_str(item.get("scenario_id"), "unknown_scenario")
        score = _safe_dict(item.get("scorecard"))
        panel_warnings = _safe_list(item.get("panel_warnings"))
        scenario_goal = _safe_str(_safe_dict(scenario_lookup.get(scenario_id)).get("goal"), "")
        scenario_rows.append(
            {
                "scenario_id": scenario_id,
                "goal": scenario_goal,
                "status": _safe_str(score.get("status"), _safe_str(item.get("status"), "unknown")),
                "goal_pass": _safe_bool(score.get("goal_pass"), False),
                "runtime_s": _safe_float(score.get("runtime_s"), 0.0),
                "artifact_count": _safe_int(score.get("artifact_count"), 0),
                "panel_warning_count": len(panel_warnings),
            }
        )
    for item in analyzed:
        for reflection in _safe_list(item.get("reflections")):
            if not isinstance(reflection, dict):
                continue
            for raw in _safe_list(reflection.get("pain_points")):
                point = _safe_dict(raw)
                category = _safe_str(point.get("category"), "")
                if not category:
                    continue
                bucket = category_stats.setdefault(
                    category,
                    {
                        "count": 0,
                        "severity_sum": 0.0,
                        "scenarios": set(),
                    },
                )
                bucket["count"] += 1
                bucket["severity_sum"] += min(1.0, max(0.0, _safe_float(point.get("severity"), 0.0)))
                bucket["scenarios"].add(_safe_str(item.get("scenario_id"), "unknown_scenario"))

    ranked_categories = sorted(
        category_stats.items(),
        key=lambda kv: (_safe_float(kv[1].get("severity_sum"), 0.0), _safe_int(kv[1].get("count"), 0)),
        reverse=True,
    )

    lines.extend(["", "## Competitive Thesis"])
    lines.append(
        "Nearest competitors are typically strong at single-shot generation, but weaker at reproducibility, "
        "debuggability, and team-grade workflow reliability."
    )

    lines.extend(["", "## 10x Opportunities"])
    if ranked_categories:
        for idx, (category, stats) in enumerate(ranked_categories[:5], start=1):
            play = TEN_X_PLAYBOOK.get(
                category,
                {
                    "feature": f"Focused improvement for `{category}`",
                    "problem": "Recurring friction in production workflows.",
                    "ten_x": "Reduce recurrence and increase reliable completion.",
                },
            )
            count = _safe_int(stats.get("count"), 0)
            avg = _safe_float(stats.get("severity_sum"), 0.0) / max(1, count)
            scenarios_hit = sorted(str(v) for v in (stats.get("scenarios") or set()))
            lines.append(f"{idx}. {play.get('feature')}")
            lines.append(f"- Problem solved: {play.get('problem')}")
            lines.append(f"- Why this can be 10x: {play.get('ten_x')}")
            lines.append(
                f"- Evidence from harness: `{category}` appeared {count} times (avg severity {avg:.2f}) "
                f"across {len(scenarios_hit)} scenario(s)."
            )
    else:
        if scenario_rows:
            for idx, row in enumerate(scenario_rows[:5], start=1):
                scenario_id = _safe_str(row.get("scenario_id"), "unknown_scenario")
                goal = _safe_str(row.get("goal"), "")
                panel_warning_count = _safe_int(row.get("panel_warning_count"), 0)
                status = _safe_str(row.get("status"), "unknown")
                goal_pass = _safe_bool(row.get("goal_pass"), False)
                runtime_s = _safe_float(row.get("runtime_s"), 0.0)
                artifact_count = _safe_int(row.get("artifact_count"), 0)
                lines.append(f"{idx}. Scenario hardening for `{scenario_id}`")
                if panel_warning_count > 0:
                    lines.append(
                        f"- Problem solved: `{scenario_id}` produced {panel_warning_count} panel warning(s), "
                        "so reflection evidence was unusable for product decisions."
                    )
                    lines.append(
                        "- Why this can be 10x: Turning every run into parseable, scenario-linked feedback creates a "
                        "continuous UX learning loop competitors typically lack."
                    )
                elif not goal_pass or status.lower() != "pass":
                    lines.append(
                        f"- Problem solved: `{scenario_id}` missed scenario pass criteria despite runtime completion."
                    )
                    lines.append(
                        "- Why this can be 10x: Deterministic scenario completion with explicit pass gating shortens "
                        "debug cycles and improves trust in automated UX validation."
                    )
                else:
                    lines.append(
                        f"- Problem solved: Preserve successful behavior in `{scenario_id}` while scaling to additional "
                        "user scenarios."
                    )
                    lines.append(
                        "- Why this can be 10x: Scenario-by-scenario reliability baselines make regressions obvious "
                        "before they reach production workflows."
                    )
                goal_line = f" Goal: {goal}" if goal else ""
                lines.append(
                    f"- Evidence from harness: status={status}, goal_pass={'yes' if goal_pass else 'no'}, "
                    f"artifacts={artifact_count}, runtime_s={runtime_s:.1f}.{goal_line}"
                )
        else:
            lines.append("1. Build scenario-specific validation coverage from first harness runs.")
            lines.append("- Problem solved: No non-dry run evidence available yet.")
            lines.append("- Why this can be 10x: Early scenario instrumentation creates a durable UX learning moat.")

    lines.extend(["", "## Features To Double Down On"])
    for feature in BROOD_DEFENSIBLE_FEATURES:
        lines.append(f"- {feature}")

    if scenarios:
        lines.extend(["", "## Scenario Coverage"])
        for scenario in scenarios:
            if not isinstance(scenario, dict):
                continue
            scenario_id = _safe_str(scenario.get("id"), "unknown_scenario")
            goal = _safe_str(scenario.get("goal"), "n/a")
            lines.append(f"- `{scenario_id}`: {goal}")

    lines.extend(["", "## Suggested Next Validation"])
    lines.append("- Implement top 1-2 10x opportunities and re-run the same pack.")
    lines.append("- Compare pain cluster reduction and pass-rate delta versus current baseline.")
    lines.append("- Keep screenshot-coupled evidence in the decision record for each change.")

    return "\n".join(lines) + "\n"


def _build_ten_x_competitive_edge_prompt(
    *,
    run_summaries: list[dict[str, Any]],
    scenarios: list[dict[str, Any]],
) -> str:
    compact_runs: list[dict[str, Any]] = []
    for run in run_summaries:
        compact = {
            "scenario_id": _safe_str(run.get("scenario_id"), ""),
            "persona_id": _safe_str(run.get("persona_id"), ""),
            "dry_run": _safe_bool(run.get("dry_run"), False),
            "scorecard": _safe_dict(run.get("scorecard")),
            "pain_points": [],
            "simulated_user_quotes": [],
        }
        for reflection in _safe_list(run.get("reflections"))[:24]:
            if not isinstance(reflection, dict):
                continue
            turn = _safe_int(reflection.get("turn"), 0)
            for point in _safe_list(reflection.get("pain_points"))[:4]:
                compact["pain_points"].append(point)
            for idx, raw in enumerate(_safe_list(reflection.get("simulated_user_quotes"))[:3], start=1):
                if not isinstance(raw, dict):
                    continue
                quote_text = _safe_str(raw.get("quote"), "")
                if not quote_text:
                    continue
                quote_id = _safe_str(raw.get("quote_id"), "").strip() or f"q-t{turn:02d}-{idx:02d}"
                compact["simulated_user_quotes"].append(
                    {
                        "quote_id": quote_id,
                        "turn": turn,
                        "quote": quote_text,
                        "sentiment": _safe_str(raw.get("sentiment"), "uncertain"),
                        "confidence": min(1.0, max(0.0, _safe_float(raw.get("confidence"), 0.5))),
                        "evidence": [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()][:4],
                    }
                )
        compact_runs.append(compact)

    compact_scenarios = []
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        compact_scenarios.append(
            {
                "id": _safe_str(scenario.get("id"), ""),
                "persona_id": _safe_str(scenario.get("persona_id"), ""),
                "goal": _safe_str(scenario.get("goal"), ""),
                "project_context": _safe_str(scenario.get("project_context"), ""),
                "required_abilities": _safe_list(scenario.get("required_abilities")),
            }
        )

    payload = {"runs": compact_runs, "scenarios": compact_scenarios}
    return (
        "Generate a markdown strategy memo with this exact title:\n"
        "# Features or Problems Solved That Could Make Brood 10x Better Than the Nearest Competitor\n\n"
        "The memo must be grounded in the provided harness evidence.\n"
        "Include sections:\n"
        "## Competitive Thesis\n"
        "## Simulated User Verbatims\n"
        "## Highest-Impact Problems To Solve\n"
        "## Feature Bets That Could Create 10x Advantage\n"
        "## Why These Could Beat Nearest Competitor\n"
        "## Suggested Validation Plan\n"
        "For each feature bet, include: problem solved, rationale, and evidence signal from the data.\n"
        "In `Simulated User Verbatims`, include quote snippets with [quote_id].\n"
        "Each feature bet must cite one or more quote IDs.\n\n"
        "Run data:\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _build_ux_improvements_prompt(
    *,
    run_summaries: list[dict[str, Any]],
    scenarios: list[dict[str, Any]],
) -> str:
    compact_runs: list[dict[str, Any]] = []
    for run in run_summaries:
        panel_warnings = _safe_list(run.get("panel_warnings"))
        compact = {
            "scenario_id": _safe_str(run.get("scenario_id"), ""),
            "persona_id": _safe_str(run.get("persona_id"), ""),
            "dry_run": _safe_bool(run.get("dry_run"), False),
            "scorecard": _safe_dict(run.get("scorecard")),
            "panel_warning_count": len(panel_warnings),
            "panel_warning_examples": [
                {
                    "turn": _safe_int(_safe_dict(w).get("turn"), 0),
                    "status": _safe_str(_safe_dict(w).get("status"), ""),
                    "error": _safe_str(_safe_dict(w).get("error"), ""),
                }
                for w in panel_warnings[:3]
            ],
            "pain_points": [],
            "simulated_user_quotes": [],
        }
        for reflection in _safe_list(run.get("reflections"))[:24]:
            if not isinstance(reflection, dict):
                continue
            turn = _safe_int(reflection.get("turn"), 0)
            for point in _safe_list(reflection.get("pain_points"))[:4]:
                compact["pain_points"].append(point)
            for idx, raw in enumerate(_safe_list(reflection.get("simulated_user_quotes"))[:3], start=1):
                if not isinstance(raw, dict):
                    continue
                quote_text = _safe_str(raw.get("quote"), "")
                if not quote_text:
                    continue
                quote_id = _safe_str(raw.get("quote_id"), "").strip() or f"q-t{turn:02d}-{idx:02d}"
                compact["simulated_user_quotes"].append(
                    {
                        "quote_id": quote_id,
                        "turn": turn,
                        "quote": quote_text,
                        "sentiment": _safe_str(raw.get("sentiment"), "uncertain"),
                        "confidence": min(1.0, max(0.0, _safe_float(raw.get("confidence"), 0.5))),
                        "evidence": [str(v) for v in _safe_list(raw.get("evidence")) if str(v).strip()][:4],
                    }
                )
        compact_runs.append(compact)

    compact_scenarios: list[dict[str, Any]] = []
    for scenario in scenarios:
        if not isinstance(scenario, dict):
            continue
        compact_scenarios.append(
            {
                "id": _safe_str(scenario.get("id"), ""),
                "persona_id": _safe_str(scenario.get("persona_id"), ""),
                "goal": _safe_str(scenario.get("goal"), ""),
                "project_context": _safe_str(scenario.get("project_context"), ""),
                "required_abilities": _safe_list(scenario.get("required_abilities")),
                "success_criteria": _safe_list(scenario.get("success_criteria")),
            }
        )

    payload = {"runs": compact_runs, "scenarios": compact_scenarios}
    return (
        "Generate a markdown report with this exact title:\n"
        "# Target User Harness UX Improvements\n\n"
        "Rules:\n"
        "- Recommendations must be scenario-specific and evidence-based.\n"
        "- Do not provide generic advice that is not tied to scenario IDs or run evidence.\n"
        "- Treat quotes as simulated-user quotes; include quote IDs where you cite them.\n"
        "- If evidence is limited (for example panel warnings), call that out by scenario and provide a concrete fix.\n"
        "- Keep recommendations prioritized.\n\n"
        "Include sections:\n"
        "## Outcome Summary\n"
        "## Simulated User Verbatims\n"
        "## Scenario-Specific Findings\n"
        "## Prioritized UX Improvements\n"
        "## Validation Plan\n\n"
        "For each improvement, include: affected scenario(s), user-visible problem, proposed change, and measurable success signal.\n"
        "Each improvement must cite one or more [quote_id] entries from the verbatims section.\n\n"
        "Run data:\n"
        f"{json.dumps(payload, ensure_ascii=False, indent=2)}"
    )


def _collect_panel_prompt(
    *,
    panel_prompt: str | None,
    panel_prompt_path: str | None,
    default_panel_prompt: str | None,
    default_panel_prompt_path: str | None,
    pack_dir: Path | None,
) -> str | None:
    if panel_prompt:
        return panel_prompt
    if panel_prompt_path:
        prompt_from_path = _read_text_file(_resolve_file_path(panel_prompt_path, base_dir=pack_dir))
        if prompt_from_path:
            return prompt_from_path
    if default_panel_prompt:
        return default_panel_prompt
    if default_panel_prompt_path:
        return _read_text_file(_resolve_file_path(default_panel_prompt_path, base_dir=pack_dir))
    return None


def run_target_user_pack(
    *,
    pack_path: Path,
    out_dir: Path,
    adapter: str | None = None,
    max_turns_override: int | None = None,
    max_runtime_override_s: int | None = None,
    max_cost_override_usd: float | None = None,
    dry_run: bool = False,
    scenario_filter: list[str] | None = None,
    persona_filter: list[str] | None = None,
    panel_enabled: bool = True,
    text_model: str | None = None,
    image_model: str | None = None,
    panel_prompt: str | None = None,
    panel_prompt_path: str | None = None,
    panel_model: str | None = None,
    panel_reasoning_effort: str | None = None,
    panel_temperature: float | None = None,
    screenshot_source_dir: str | None = None,
    screenshot_capture_mode: str | None = None,
    screenshot_app_names: list[str] | None = None,
    desktop_bridge_socket: str | None = None,
    desktop_events_path: str | None = None,
) -> list[Path]:
    payload = json.loads(pack_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise RuntimeError("Harness pack must be a JSON object.")
    defaults = _safe_dict(payload.get("defaults"))
    default_adapter = _safe_str(defaults.get("adapter"), "chat_cli").strip().lower() or "chat_cli"
    resolved_adapter = _safe_str(adapter, default_adapter).strip().lower() or "chat_cli"
    if resolved_adapter not in {"chat_cli", "desktop_ui"}:
        raise RuntimeError(f"Unsupported target user harness adapter: {resolved_adapter}")
    default_max_turns = _safe_int(defaults.get("max_turns"), 12)
    default_max_runtime_s = _safe_int(defaults.get("max_runtime_s"), 900)
    default_max_cost = _safe_float(defaults.get("max_cost_usd"), 6.0)
    if max_turns_override is not None:
        default_max_turns = max_turns_override
    if max_runtime_override_s is not None:
        default_max_runtime_s = max_runtime_override_s
    if max_cost_override_usd is not None:
        default_max_cost = max_cost_override_usd

    resolved_text_model = _safe_str(text_model, _safe_str(defaults.get("text_model"), "gpt-5.2"))
    resolved_image_model = _safe_str(image_model, _safe_str(defaults.get("image_model"), "gemini-2.5-flash-image"))
    cli_panel_model = _safe_str(panel_model, None)
    default_panel_model = _safe_str(defaults.get("panel_model"), None)
    aggregate_panel_model = cli_panel_model or default_panel_model
    default_panel_reasoning_effort = _normalize_reasoning_effort(defaults.get("panel_reasoning_effort"), None)
    default_panel_prompt = _safe_str(defaults.get("panel_prompt"), None)
    default_panel_prompt_path = _safe_str(defaults.get("panel_prompt_path"), None)
    default_panel_source_dir = _safe_str(defaults.get("screenshot_source_dir"), None)
    default_capture_mode = _normalize_screenshot_capture_mode(defaults.get("screenshot_capture_mode"))
    default_app_names = _normalize_app_names(defaults.get("screenshot_app_names"))
    default_desktop_bridge_socket = _safe_str(defaults.get("desktop_bridge_socket"), None)
    default_desktop_events_path = _safe_str(defaults.get("desktop_events_path"), None)
    cli_desktop_bridge_socket = _safe_str(desktop_bridge_socket, None)
    cli_desktop_events_path = _safe_str(desktop_events_path, None)
    default_panel_temperature = _safe_float(defaults.get("panel_temperature"), 0.5)
    if panel_reasoning_effort is None:
        panel_reasoning_effort = default_panel_reasoning_effort
    if panel_temperature is None:
        panel_temperature = default_panel_temperature
    if screenshot_capture_mode is None:
        screenshot_capture_mode = default_capture_mode
    if screenshot_app_names is None:
        screenshot_app_names = default_app_names

    scenario_payloads = _safe_list(payload.get("scenarios"))
    if scenario_filter:
        scenario_set = set(_safe_str(v) for v in scenario_filter)
        scenario_payloads = [s for s in scenario_payloads if _safe_str(s.get("id")) in scenario_set]

    persona_map = {str(p.get("id")): p for p in _safe_list(payload.get("personas")) if isinstance(p, dict) and p.get("id")}
    out_dir.mkdir(parents=True, exist_ok=True)
    run_dirs: list[Path] = []
    ux_summary_runs: list[dict[str, Any]] = []

    for scenario in scenario_payloads:
        if not isinstance(scenario, dict):
            continue
        scenario_id = _safe_str(scenario.get("id"), "")
        persona_id = _safe_str(scenario.get("persona_id"), "")
        if not scenario_id or not persona_id:
            continue
        if persona_filter and persona_id not in [str(v) for v in persona_filter]:
            continue
        persona = persona_map.get(persona_id)
        if not isinstance(persona, dict):
            continue

        run_dir = out_dir / f"{_slug(persona_id)}__{_slug(scenario_id)}__{int(time.time())}"
        run_dirs.append(run_dir)
        run_dir.mkdir(parents=True, exist_ok=True)

        required_abilities = [str(v).strip() for v in _safe_list(scenario.get("required_abilities")) if str(v).strip()]
        policy = _safe_dict(scenario.get("policy"))
        policy_max_turns = _safe_int(policy.get("max_turns"), default_max_turns)
        policy_max_runtime_s = _safe_int(policy.get("max_runtime_s"), default_max_runtime_s)
        policy_max_cost_usd = _safe_float(policy.get("max_cost_usd"), default_max_cost)
        max_turns = max(1, max_turns_override if max_turns_override is not None else policy_max_turns)
        max_runtime_s = max(
            1,
            max_runtime_override_s if max_runtime_override_s is not None else policy_max_runtime_s,
        )
        max_cost_usd = max(
            0.0,
            max_cost_override_usd if max_cost_override_usd is not None else policy_max_cost_usd,
        )
        fail_limit = max(1, _safe_int(policy.get("consecutive_fail_limit"), 3))
        raw_success_criteria = scenario.get("success_criteria")
        if isinstance(raw_success_criteria, list):
            success_level = [str(v) for v in raw_success_criteria if str(v).strip()]
        else:
            single = _safe_str(raw_success_criteria, "")
            success_level = [single] if single else []
        scenario_screenshot_source_dir = _safe_str(scenario.get("screenshot_source_dir"), None)
        scenario_capture_mode = _normalize_screenshot_capture_mode(
            scenario.get("screenshot_capture_mode") or screenshot_capture_mode
        )
        scenario_app_names = _normalize_app_names(
            scenario.get("screenshot_app_names") or screenshot_app_names
        )
        scenario_desktop_bridge_socket = _safe_str(scenario.get("desktop_bridge_socket"), None)
        scenario_desktop_events_path = _safe_str(scenario.get("desktop_events_path"), None)
        scenario_panel_prompt = _safe_str(scenario.get("panel_prompt"), None)
        scenario_panel_prompt_path = _safe_str(scenario.get("panel_prompt_path"), None)
        scenario_panel_model = _safe_str(scenario.get("panel_model"), None)
        scenario_panel_reasoning_effort = _normalize_reasoning_effort(
            scenario.get("panel_reasoning_effort"),
            None,
        )
        scenario_panel_temperature = _safe_float(scenario.get("panel_temperature"), None)
        resolved_panel_prompt = _collect_panel_prompt(
            panel_prompt=_safe_str(panel_prompt, None) or scenario_panel_prompt,
            panel_prompt_path=_safe_str(panel_prompt_path, None) or scenario_panel_prompt_path,
            default_panel_prompt=default_panel_prompt,
            default_panel_prompt_path=_safe_str(default_panel_prompt_path, None),
            pack_dir=pack_path.parent,
        )
        # Precedence: CLI override > scenario override > pack default.
        resolved_panel_model = _safe_str(
            cli_panel_model or scenario_panel_model or default_panel_model,
            None,
        )
        resolved_panel_model, alias_reasoning_effort = _resolve_panel_model_alias(resolved_panel_model)
        resolved_panel_reasoning_effort = _normalize_reasoning_effort(
            scenario_panel_reasoning_effort
            if scenario_panel_reasoning_effort is not None
            else panel_reasoning_effort,
            alias_reasoning_effort,
        )
        resolved_panel_temperature = _safe_float(
            scenario_panel_temperature if scenario_panel_temperature is not None else panel_temperature,
            0.5,
        )
        resolved_screenshot_source_dir = (
            screenshot_source_dir
            if screenshot_source_dir
            else (scenario_screenshot_source_dir if scenario_screenshot_source_dir else default_panel_source_dir)
        )
        resolved_desktop_bridge_socket = (
            cli_desktop_bridge_socket
            if cli_desktop_bridge_socket
            else (
                scenario_desktop_bridge_socket
                if scenario_desktop_bridge_socket
                else default_desktop_bridge_socket
            )
        )
        resolved_desktop_events_path = (
            cli_desktop_events_path
            if cli_desktop_events_path
            else (scenario_desktop_events_path if scenario_desktop_events_path else default_desktop_events_path)
        )

        session_payload = {
            "schema": TARGET_USER_HARNESS_SCHEMA,
            "schema_version": TARGET_USER_HARNESS_SCHEMA_VERSION,
            "resolved_at": _utc_now_iso(),
            "persona": persona,
            "scenario": {
                "id": scenario_id,
                "persona_id": persona_id,
                "goal": _safe_str(scenario.get("goal"), ""),
                "project_context": _safe_str(scenario.get("project_context"), ""),
                "success_criteria": [str(v) for v in _safe_list(scenario.get("success_criteria"))],
                "required_abilities": required_abilities,
                "bootstrap_actions": _safe_list(scenario.get("bootstrap_actions")),
                "policy": policy,
            },
            "defaults": {
                "adapter": resolved_adapter,
                "max_turns": max_turns,
                "max_runtime_s": max_runtime_s,
                "max_cost_usd": max_cost_usd,
                "text_model": resolved_text_model,
                "image_model": resolved_image_model,
                "seed": _safe_int(defaults.get("seed"), 42),
                "require_reflection_each_turn": _safe_bool(defaults.get("require_reflection_each_turn"), True),
                "panel_prompt": _safe_str(resolved_panel_prompt, None),
                "panel_prompt_path": _safe_str(scenario_panel_prompt_path or default_panel_prompt_path, None),
                "panel_model": _safe_str(resolved_panel_model, None),
                "panel_reasoning_effort": _safe_str(resolved_panel_reasoning_effort, None),
                "panel_temperature": resolved_panel_temperature,
                "screenshot_source_dir": _safe_str(resolved_screenshot_source_dir, None),
                "screenshot_capture_mode": scenario_capture_mode,
                "screenshot_app_names": scenario_app_names,
                "desktop_bridge_socket": _safe_str(resolved_desktop_bridge_socket, None),
                "desktop_events_path": _safe_str(resolved_desktop_events_path, None),
            },
        }
        _write_json(run_dir / "session.json", session_payload)

        if dry_run:
            ux_summary_runs.append(
                {
                    "run_dir": str(run_dir),
                    "scenario_id": scenario_id,
                    "persona_id": persona_id,
                    "dry_run": True,
                }
            )
            _write_json(
                run_dir / "summary.json",
                {"status": "dry_run", "session": session_payload, "created_at": _utc_now_iso()},
            )
            continue

        events_path = run_dir / "events.jsonl"
        screenshot_capture = ScreenshotCapture(
            run_dir=run_dir,
            source_dir=Path(resolved_screenshot_source_dir).expanduser()
            if resolved_screenshot_source_dir
            else None,
            capture_mode=scenario_capture_mode,
            app_names=scenario_app_names,
        )
        transcript_path = run_dir / "transcript.jsonl"
        screenshots_path = run_dir / "screenshots.jsonl"
        reflections_path = run_dir / "reflections.jsonl"
        simulated_quotes_path = run_dir / "simulated_user_quotes.jsonl"
        pain_points_path = run_dir / "pain_points.jsonl"
        events_tail_path = run_dir / "events_tail.jsonl"
        panel_requests_path = run_dir / "panel_requests.jsonl"
        panel_responses_path = run_dir / "panel_responses.jsonl"
        simulated_quotes_path.write_text("", encoding="utf-8")

        input_paths = _normalize_scene_inputs(scenario.get("inputs"))
        bootstrap_actions = _safe_list(scenario.get("bootstrap_actions"))
        if not bootstrap_actions and input_paths:
            bootstrap_actions = [{"kind": "command", "command": {"name": "use", "paths": [str(input_paths[0])]}}]

        action_queue: list[dict[str, Any]] = []
        for action in bootstrap_actions:
            queue_item = _action_to_queue_item(_safe_dict(action), input_paths)
            if queue_item:
                action_queue.append(queue_item)

        required_queue = [str(v) for v in required_abilities if str(v).strip()]
        auto_index = 0

        if resolved_adapter == "desktop_ui":
            adapter_session = DesktopUIAdapter(
                bridge_socket=resolved_desktop_bridge_socket,
                events_path=Path(resolved_desktop_events_path).expanduser()
                if resolved_desktop_events_path
                else None,
                app_names=scenario_app_names,
            )
        else:
            adapter_session = ChatCLIAdapter(
                run_dir=run_dir,
                text_model=resolved_text_model,
                image_model=resolved_image_model,
                events_path=events_path,
            )
        adapter_session.start()
        seeded_paths = adapter_session.prepare_inputs(input_paths, base_dir=pack_path.parent)
        if seeded_paths:
            _append_jsonl(
                transcript_path,
                {
                    "timestamp": _utc_now_iso(),
                    "turn": 0,
                    "phase": "bootstrap",
                    "type": "seed_inputs",
                    "paths": seeded_paths,
                },
            )

        final_panel_enabled = panel_enabled and bool(resolved_panel_prompt and resolved_panel_model)
        panel_review = (
            PanelReviewer(
                model=resolved_panel_model if final_panel_enabled else None,
                panel_prompt=resolved_panel_prompt if final_panel_enabled else None,
                reasoning_effort=resolved_panel_reasoning_effort,
                temperature=resolved_panel_temperature,
            )
            if final_panel_enabled
            else None
        )

        start_ts = time.monotonic()
        turns_done = 0
        steps_done = 0
        ui_actions_done = 0
        consecutive_failures = 0
        used_abilities: set[str] = set()
        run_cost = 0.0
        reflections: list[dict[str, Any]] = []
        simulated_quotes_count = 0
        panel_warnings: list[dict[str, Any]] = []
        events_tail_records: list[dict[str, Any]] = []

        try:
            # Mandatory baseline screenshot.
            baseline = screenshot_capture.capture(
                scenario_id=scenario_id,
                persona_id=persona_id,
                turn=0,
                phase="baseline",
                action="session bootstrap",
                reason="initial state",
                events=[],
                artifacts=[],
                source_images=input_paths,
            )
            _append_jsonl(
                screenshots_path,
                {
                    "timestamp": _utc_now_iso(),
                    "turn": 0,
                    "phase": "baseline",
                    "reason": "initial state",
                    "path": str(baseline),
                    "path_exists": baseline.exists(),
                },
            )

            while turns_done < max_turns and (time.monotonic() - start_ts) < max_runtime_s:
                if not action_queue and auto_index < len(required_queue):
                    command = _action_for_required_ability(required_queue[auto_index], input_paths)
                    auto_index += 1
                    if command:
                        action_queue.append({"kind": "chat", "input": command})
                if not action_queue:
                    break

                action_item = _safe_dict(action_queue.pop(0))
                action_kind = _safe_str(action_item.get("kind"), "chat").strip().lower()
                ui_payload = _safe_dict(action_item.get("ui")) if action_kind == "ui" else {}
                if action_kind == "ui":
                    user_input = _ui_action_label(ui_payload)
                else:
                    user_input = _safe_str(action_item.get("input"), "").strip()
                if not user_input:
                    continue

                steps_done += 1
                if action_kind == "ui":
                    ui_actions_done += 1
                else:
                    turns_done += 1
                step_turn = steps_done
                pre_path = screenshot_capture.capture(
                    scenario_id=scenario_id,
                    persona_id=persona_id,
                    turn=step_turn,
                    phase="pre_action",
                    action=user_input,
                    reason="planned turn",
                    events=[],
                    artifacts=[],
                    source_images=input_paths,
                )
                _append_jsonl(
                    screenshots_path,
                    {
                        "timestamp": _utc_now_iso(),
                        "turn": step_turn,
                        "phase": "pre_action",
                        "reason": "planned turn",
                        "path": str(pre_path),
                        "path_exists": pre_path.exists(),
                    },
                )
                _append_jsonl(
                    transcript_path,
                    {
                        "timestamp": _utc_now_iso(),
                        "turn": step_turn,
                        "phase": "pre_action",
                        "type": "user_input",
                        "text": user_input,
                        "screenshot": str(pre_path),
                    },
                )

                if action_kind == "ui":
                    assistant_lines, delta_events, duration_s, prompt_returned, timed_out = adapter_session.run_ui_action(
                        ui_payload
                    )
                else:
                    assistant_lines, delta_events, duration_s, prompt_returned, timed_out = adapter_session.run_turn(
                        user_input
                    )
                event_types = _extract_event_types(delta_events)
                run_cost += _extract_cost_updates(delta_events)
                artifacts = _extract_artifacts_from_events(delta_events)
                failed = any(event in _expected_fail_event_names(user_input) for event in event_types)
                if action_kind != "ui":
                    if failed:
                        consecutive_failures += 1
                    else:
                        consecutive_failures = 0

                for event in delta_events:
                    _append_jsonl(events_tail_path, event)
                    events_tail_records.append(event)

                post_summary = _build_screenshot_lines(events=delta_events, artifacts=artifacts)
                post_path = screenshot_capture.capture(
                    scenario_id=scenario_id,
                    persona_id=persona_id,
                    turn=step_turn,
                    phase="post_action",
                    action=user_input,
                    reason="action complete",
                    events=delta_events,
                    artifacts=artifacts,
                    source_images=[*input_paths, *[Path(path) for path in artifacts if path]],
                )
                _append_jsonl(
                    screenshots_path,
                    {
                        "timestamp": _utc_now_iso(),
                        "turn": step_turn,
                        "phase": "post_action",
                        "reason": "action complete",
                        "path": str(post_path),
                        "path_exists": post_path.exists(),
                    },
                )

                if user_input.startswith("/"):
                    verb = user_input.split(maxsplit=1)[0].lstrip("/")
                    if verb in required_abilities:
                        used_abilities.add(verb)

                review = None
                if panel_review is not None:
                    review, panel_trace = panel_review.review(
                        persona=persona,
                        scenario=scenario,
                        action=user_input,
                        screenshot_path=post_path,
                        turn=step_turn,
                        events=delta_events,
                        artifacts=artifacts,
                        screenshot_summary=post_summary,
                        consecutive_failures=consecutive_failures,
                    )
                    request_payload = _safe_dict(panel_trace.get("request"))
                    if request_payload:
                        _append_jsonl(panel_requests_path, request_payload)
                    response_payload = _safe_dict(panel_trace.get("response"))
                    if response_payload:
                        _append_jsonl(panel_responses_path, response_payload)
                    panel_status = _safe_str(panel_trace.get("status"), "").strip().lower()
                    panel_error = _safe_str(panel_trace.get("error"), "").strip()
                    if panel_status:
                        panel_event = {
                            "type": "panel_response_received" if panel_status == "ok" else "panel_response_empty",
                            "source": "target_user_harness",
                            "ts": _utc_now_iso(),
                            "turn": step_turn,
                            "action": user_input,
                            "panel_status": panel_status,
                            "panel_error": panel_error,
                            "panel_model": _safe_str(resolved_panel_model, ""),
                        }
                        _append_jsonl(events_tail_path, panel_event)
                        events_tail_records.append(panel_event)
                        if panel_status != "ok":
                            panel_warnings.append(
                                {
                                    "turn": step_turn,
                                    "action": user_input,
                                    "status": panel_status,
                                    "error": panel_error,
                                }
                            )
                reflection = _build_reflection(
                    turn=step_turn,
                    action=user_input,
                    assistant_lines=assistant_lines,
                    delta_events=delta_events,
                    duration_s=duration_s,
                    screenshot_path=post_path,
                    screenshot_phase="post_action",
                    screenshot_summary=post_summary,
                    consecutive_failures=consecutive_failures,
                    artifact_paths=artifacts,
                    review=review,
                )
                quote_records = _assign_quote_ids_to_reflection(reflection)
                _append_jsonl(reflections_path, reflection)
                for point in _safe_list(reflection.get("pain_points")):
                    enriched = dict(point)
                    enriched["turn"] = step_turn
                    enriched["scenario_id"] = scenario_id
                    enriched["persona_id"] = persona_id
                    _append_jsonl(pain_points_path, enriched)
                for quote in quote_records:
                    if not isinstance(quote, dict):
                        continue
                    quote_record = {
                        "quote_id": _safe_str(quote.get("quote_id"), ""),
                        "quote": _safe_str(quote.get("quote"), ""),
                        "sentiment": _safe_str(quote.get("sentiment"), "uncertain"),
                        "confidence": min(1.0, max(0.0, _safe_float(quote.get("confidence"), 0.5))),
                        "evidence": [str(v) for v in _safe_list(quote.get("evidence")) if str(v).strip()][:4],
                        "turn": step_turn,
                        "action": user_input,
                        "scenario_id": scenario_id,
                        "persona_id": persona_id,
                        "screenshot_path": str(post_path),
                        "is_simulated": True,
                        "source": "panel_reviewer",
                        "ts": _utc_now_iso(),
                    }
                    _append_jsonl(simulated_quotes_path, quote_record)
                    simulated_quotes_count += 1
                reflections.append(reflection)

                _append_jsonl(
                    transcript_path,
                    {
                        "timestamp": _utc_now_iso(),
                        "turn": step_turn,
                        "phase": "post_action",
                        "type": "assistant_output",
                        "duration_s": round(duration_s, 3),
                        "lines": assistant_lines,
                        "events": event_types,
                        "artifacts": artifacts,
                        "prompt_returned": prompt_returned,
                        "timed_out": timed_out,
                        "screenshot": str(post_path),
                    },
                )

                if timed_out or not prompt_returned:
                    break
                if consecutive_failures >= fail_limit:
                    break
                if run_cost > max_cost_usd:
                    break

            completion = screenshot_capture.capture(
                scenario_id=scenario_id,
                persona_id=persona_id,
                turn=steps_done + 1,
                phase="completion",
                action="run complete",
                reason="end",
                events=[],
                artifacts=[],
                source_images=input_paths,
            )
            _append_jsonl(
                screenshots_path,
                {
                    "timestamp": _utc_now_iso(),
                    "turn": steps_done,
                    "phase": "completion",
                    "reason": "run complete",
                    "path": str(completion),
                    "path_exists": completion.exists(),
                },
            )

            runtime_s = round(time.monotonic() - start_ts, 3)
            scorecard = _score_run(
                reflections=reflections,
                required_abilities=required_abilities,
                used_abilities=used_abilities,
                run_cost=run_cost,
                max_cost_usd=max_cost_usd,
                runtime_s=runtime_s,
                max_runtime_s=max_runtime_s,
                scenario_id=scenario_id,
                events_tail=events_tail_records,
            )
            scorecard.update(
                {
                    "schema": TARGET_USER_HARNESS_SCHEMA,
                    "schema_version": TARGET_USER_HARNESS_SCHEMA_VERSION,
                    "scenario_id": scenario_id,
                    "persona_id": persona_id,
                    "turns_executed": turns_done,
                    "steps_executed": steps_done,
                    "ui_actions_executed": ui_actions_done,
                    "run_cost_usd": round(run_cost, 6),
                    "runtime_s": runtime_s,
                    "status": "pass" if scorecard.get("goal_pass") else "fail",
                    "simulated_quotes_count": simulated_quotes_count,
                    "max_turns": max_turns,
                    "max_runtime_s": max_runtime_s,
                    "max_cost_usd": max_cost_usd,
                    "success_criteria": success_level,
                }
            )
            _write_json(run_dir / "scorecard.json", scorecard)
            summary_payload: dict[str, Any] = {
                "schema": TARGET_USER_HARNESS_SCHEMA,
                "schema_version": TARGET_USER_HARNESS_SCHEMA_VERSION,
                "scenario_id": scenario_id,
                "persona_id": persona_id,
                "status": scorecard.get("status"),
                "scorecard": scorecard,
                "created_at": _utc_now_iso(),
                "simulated_user_quotes": {
                    "count": simulated_quotes_count,
                    "path": str(simulated_quotes_path),
                    "simulated": True,
                },
            }
            if panel_warnings:
                summary_payload["warnings"] = [
                    "Panel model returned empty/invalid review payload on one or more turns."
                ]
                summary_payload["panel"] = {
                    "configured": bool(final_panel_enabled),
                    "enabled": bool(panel_review and panel_review.enabled),
                    "warning_count": len(panel_warnings),
                    "warnings": panel_warnings[:50],
                    "requests_path": str(panel_requests_path),
                    "responses_path": str(panel_responses_path),
                }
            _write_json(run_dir / "summary.json", summary_payload)
            usability_report_fallback = _build_report_text(
                scenario_id=scenario_id,
                persona_id=persona_id,
                turns=turns_done,
                scorecard=scorecard,
                reflections=reflections,
            )
            usability_report_llm = None
            if panel_enabled:
                usability_report_llm = _report_llm_markdown(
                    model=resolved_panel_model,
                    prompt=_build_usability_report_prompt(
                        scenario_id=scenario_id,
                        persona_id=persona_id,
                        scenario=scenario,
                        scorecard=scorecard,
                        reflections=reflections,
                    ),
                    timeout_s=75.0,
                )
            usability_report_text = usability_report_llm or usability_report_fallback
            if usability_report_text and not usability_report_text.lstrip().startswith("#"):
                usability_report_text = (
                    "# Target User Harness Scenario Report\n\n" + usability_report_text.lstrip()
                )
            if panel_warnings:
                diagnostics_lines = [
                    "",
                    "## Panel Diagnostics",
                    (
                        f"- Panel review responses were empty/invalid on {len(panel_warnings)} turn(s). "
                        f"See `{panel_responses_path}`."
                    ),
                ]
                first_warning = _safe_dict(panel_warnings[0])
                diagnostics_lines.append(
                    "- First warning: "
                    f"turn={_safe_int(first_warning.get('turn'), 0)} "
                    f"status={_safe_str(first_warning.get('status'), 'unknown')} "
                    f"error={_safe_str(first_warning.get('error'), 'n/a')}"
                )
                usability_report_text = usability_report_text.rstrip() + "\n" + "\n".join(diagnostics_lines) + "\n"
            (run_dir / "usability_report.md").write_text(
                usability_report_text,
                encoding="utf-8",
            )
            ux_summary_runs.append(
                {
                    "run_dir": str(run_dir),
                    "scenario_id": scenario_id,
                    "persona_id": persona_id,
                    "dry_run": False,
                    "scorecard": scorecard,
                    "reflections": reflections,
                    "panel_warnings": panel_warnings,
                }
            )
        finally:
            adapter_session.stop()

    scenario_dicts = [_safe_dict(s) for s in scenario_payloads if isinstance(s, dict)]
    ux_llm = None
    if panel_enabled:
        ux_llm = _report_llm_markdown(
            model=aggregate_panel_model,
            prompt=_build_ux_improvements_prompt(
                run_summaries=ux_summary_runs,
                scenarios=scenario_dicts,
            ),
            timeout_s=90.0,
        )
    if not ux_llm:
        ux_llm = (
            "# Target User Harness UX Improvements\n\n"
            "LLM synthesis unavailable for this run. "
            "No heuristic fallback was used.\n"
        )
    (out_dir / "ux_improvements.md").write_text(ux_llm, encoding="utf-8")

    ten_x_llm = None
    if panel_enabled:
        ten_x_llm = _report_llm_markdown(
            model=aggregate_panel_model,
            prompt=_build_ten_x_competitive_edge_prompt(
                run_summaries=ux_summary_runs,
                scenarios=scenario_dicts,
            ),
            timeout_s=90.0,
        )
    if not ten_x_llm:
        ten_x_llm = (
            "# Features or Problems Solved That Could Make Brood 10x Better Than the Nearest Competitor\n\n"
            "LLM synthesis unavailable for this run. "
            "No heuristic fallback was used.\n"
        )
    (out_dir / "ten_x_competitive_edge.md").write_text(ten_x_llm, encoding="utf-8")

    return run_dirs
