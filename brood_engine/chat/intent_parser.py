"""Parse user input into structured intents."""

from __future__ import annotations

import re
from .intent_schema import Intent

_SLASH_PATTERN = re.compile(r"^/(\w+)(?:\s+(.*))?$")


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
        if command == "recreate":
            return Intent(action="recreate", raw=text, command_args={"path": arg})
        if command == "export":
            return Intent(action="export", raw=text, command_args={"format": arg or "html"})
        if command == "help":
            return Intent(action="help", raw=text)
        return Intent(action="unknown", raw=text, command_args={"command": command, "arg": arg})

    # Heuristic: refinement if starts with verbs and prior prompt exists
    return Intent(action="generate", raw=text, prompt=raw)
