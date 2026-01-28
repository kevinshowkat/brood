"""Style tagger stub (LLM optional)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class StyleTags:
    tags: dict[str, Any]
    summary_1line: str


def tag_style(prompt: str) -> StyleTags:
    # Placeholder for LLM-based tagging. Keep deterministic and offline.
    summary = "warm" if "warm" in prompt.lower() else "neutral"
    return StyleTags(tags={"tone": summary}, summary_1line=summary)
