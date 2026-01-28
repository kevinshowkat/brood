"""Intent schema for chat commands."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class Intent:
    action: str
    raw: str
    prompt: str | None = None
    settings_update: dict[str, Any] = field(default_factory=dict)
    command_args: dict[str, Any] = field(default_factory=dict)
    description: str | None = None
