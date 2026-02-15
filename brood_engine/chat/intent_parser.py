"""Parse user input into structured intents."""

from __future__ import annotations

import re
import shlex
from .intent_schema import Intent
from .command_registry import (
    EXPORT_COMMAND,
    MULTI_PATH_COMMAND_MAP,
    NO_ARG_COMMAND_MAP,
    QUALITY_PRESET_COMMANDS,
    RAW_ARG_COMMAND_MAP,
    SINGLE_PATH_COMMAND_MAP,
)

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
        if command in RAW_ARG_COMMAND_MAP:
            action = RAW_ARG_COMMAND_MAP[command]
            key = "profile" if action == "set_profile" else "model"
            return Intent(action=action, raw=text, command_args={key: arg})
        if command in QUALITY_PRESET_COMMANDS:
            return Intent(action="set_quality", raw=text, settings_update={"quality_preset": command})
        if command == "optimize":
            goals, mode = _parse_optimize_args(arg)
            return Intent(action="optimize", raw=text, command_args={"goals": goals, "mode": mode})
        if command in SINGLE_PATH_COMMAND_MAP:
            return Intent(
                action=SINGLE_PATH_COMMAND_MAP[command],
                raw=text,
                command_args={"path": _parse_single_path_arg(arg)},
            )
        if command in MULTI_PATH_COMMAND_MAP:
            return Intent(action=MULTI_PATH_COMMAND_MAP[command], raw=text, command_args={"paths": _parse_path_args(arg)})
        if command in NO_ARG_COMMAND_MAP:
            return Intent(action=NO_ARG_COMMAND_MAP[command], raw=text, command_args={})
        if command == EXPORT_COMMAND.command:
            return Intent(action=EXPORT_COMMAND.action, raw=text, command_args={"format": arg or "html"})
        return Intent(action="unknown", raw=text, command_args={"command": command, "arg": arg})

    # Heuristic: refinement if starts with verbs and prior prompt exists
    return Intent(action="generate", raw=text, prompt=raw)
