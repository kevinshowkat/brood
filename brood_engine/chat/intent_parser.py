"""Parse user input into structured intents."""

from __future__ import annotations

import re
import shlex
from .intent_schema import Intent

_SLASH_PATTERN = re.compile(r"^/(\w+)(?:\s+(.*))?$")

_GOAL_ALIASES = {
    "quality": "maximize quality of render",
    "maximize_quality": "maximize quality of render",
    "cost": "minimize cost of render",
    "minimize_cost": "minimize cost of render",
    "time": "minimize time to render",
    "speed": "minimize time to render",
    "minimize_time": "minimize time to render",
    "retrieval": "maximize LLM retrieval score",
    "llm_retrieval": "maximize LLM retrieval score",
}


def _parse_goals(arg: str) -> list[str]:
    if not arg:
        return []
    normalized = arg.strip().lower()
    if not normalized:
        return []
    parts = [part.strip() for part in normalized.replace(";", ",").split(",") if part.strip()]
    goals: list[str] = []
    for part in parts:
        if part in _GOAL_ALIASES:
            goals.append(_GOAL_ALIASES[part])
            continue
        # Accept full goal phrases as-is.
        if "maximize" in part or "minimize" in part:
            goals.append(part)
            continue
    seen: set[str] = set()
    deduped: list[str] = []
    for goal in goals:
        if goal in seen:
            continue
        seen.add(goal)
        deduped.append(goal)
    return deduped


def _parse_optimize_args(arg: str) -> tuple[list[str], str | None]:
    if not arg:
        return [], None
    parts = arg.split()
    mode: str | None = None
    goals_arg = arg
    if parts:
        head = parts[0].lower()
        if head in {"review", "auto"}:
            mode = head
            goals_arg = " ".join(parts[1:])
        elif head.startswith("mode="):
            mode = head.split("=", 1)[1]
            goals_arg = " ".join(parts[1:])
    return _parse_goals(goals_arg), mode


def _parse_path_args(arg: str) -> list[str]:
    """Parse one or more path args from a slash command.

    Supports quoted paths so spaces work:
      /blend "/path/with spaces/a.png" "/path/b.png"
    """
    if not arg:
        return []
    try:
        parts = shlex.split(arg)
    except ValueError:
        parts = arg.split()
    return [part for part in parts if part]


def _parse_single_path_arg(arg: str) -> str:
    """Parse a single path argument (best-effort).

    Accepts quoted paths for spaces. If the user forgets to quote a path that
    contains spaces, join tokens back together as a last-resort.
    """
    parts = _parse_path_args(arg)
    if not parts:
        return ""
    if len(parts) == 1:
        return parts[0]
    return " ".join(parts)


def parse_intent(text: str) -> Intent:
    raw = text.strip()
    if not raw:
        return Intent(action="noop", raw=text)
    match = _SLASH_PATTERN.match(raw)
    if match:
        command = match.group(1).lower()
        arg = (match.group(2) or "").strip()
        if command == "profile":
            return Intent(action="set_profile", raw=text, command_args={"profile": arg})
        if command == "text_model":
            return Intent(action="set_text_model", raw=text, command_args={"model": arg})
        if command == "image_model":
            return Intent(action="set_image_model", raw=text, command_args={"model": arg})
        if command in {"fast", "quality", "cheaper", "better"}:
            return Intent(action="set_quality", raw=text, settings_update={"quality_preset": command})
        if command == "optimize":
            goals, mode = _parse_optimize_args(arg)
            return Intent(action="optimize", raw=text, command_args={"goals": goals, "mode": mode})
        if command == "recreate":
            return Intent(action="recreate", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "describe":
            return Intent(action="describe", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "canvas_context":
            return Intent(action="canvas_context", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "intent_infer":
            return Intent(action="intent_infer", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "prompt_compile":
            return Intent(action="prompt_compile", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "mother_generate":
            return Intent(action="mother_generate", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "canvas_context_rt_start":
            return Intent(action="canvas_context_rt_start", raw=text, command_args={})
        if command == "canvas_context_rt_stop":
            return Intent(action="canvas_context_rt_stop", raw=text, command_args={})
        if command == "canvas_context_rt":
            return Intent(action="canvas_context_rt", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "intent_rt_start":
            return Intent(action="intent_rt_start", raw=text, command_args={})
        if command == "intent_rt_stop":
            return Intent(action="intent_rt_stop", raw=text, command_args={})
        if command == "intent_rt":
            return Intent(action="intent_rt", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "intent_rt_mother_start":
            return Intent(action="intent_rt_mother_start", raw=text, command_args={})
        if command == "intent_rt_mother_stop":
            return Intent(action="intent_rt_mother_stop", raw=text, command_args={})
        if command == "intent_rt_mother":
            return Intent(action="intent_rt_mother", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "diagnose":
            return Intent(action="diagnose", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "recast":
            return Intent(action="recast", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "use":
            return Intent(action="set_active_image", raw=text, command_args={"path": _parse_single_path_arg(arg)})
        if command == "blend":
            return Intent(action="blend", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "swap_dna":
            return Intent(action="swap_dna", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "argue":
            return Intent(action="argue", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "bridge":
            return Intent(action="bridge", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "extract_dna":
            return Intent(action="extract_dna", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "soul_leech":
            return Intent(action="soul_leech", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "extract_rule":
            return Intent(action="extract_rule", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "odd_one_out":
            return Intent(action="odd_one_out", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "triforce":
            return Intent(action="triforce", raw=text, command_args={"paths": _parse_path_args(arg)})
        if command == "export":
            return Intent(action="export", raw=text, command_args={"format": arg or "html"})
        if command == "help":
            return Intent(action="help", raw=text)
        return Intent(action="unknown", raw=text, command_args={"command": command, "arg": arg})

    # Heuristic: refinement if starts with verbs and prior prompt exists
    return Intent(action="generate", raw=text, prompt=raw)
