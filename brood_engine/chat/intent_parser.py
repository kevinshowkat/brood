"""Parse user input into structured intents."""

from __future__ import annotations

import re
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
            goals = _parse_goals(arg)
            return Intent(action="optimize", raw=text, command_args={"goals": goals})
        if command == "recreate":
            return Intent(action="recreate", raw=text, command_args={"path": arg})
        if command == "export":
            return Intent(action="export", raw=text, command_args={"format": arg or "html"})
        if command == "help":
            return Intent(action="help", raw=text)
        return Intent(action="unknown", raw=text, command_args={"command": command, "arg": arg})

    # Heuristic: refinement if starts with verbs and prior prompt exists
    return Intent(action="generate", raw=text, prompt=raw)
