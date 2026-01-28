"""Prompt refinement and inline directives."""

from __future__ import annotations

import re
from typing import Iterable

from ..models.registry import ModelRegistry


_MODEL_ALIASES = {
    "flux": "flux-2",
    "flux-pro": "flux-2-pro",
    "flux-flex": "flux-2-flex",
    "gpt-image-1.5": "gpt-image-1.5",
    "gpt-image-1-mini": "gpt-image-1-mini",
    "gpt-image-1": "gpt-image-1",
    "imagen-4": "imagen-4",
    "imagen-ultra": "imagen-4.0-ultra",
    "imagen-4-ultra": "imagen-4.0-ultra",
    "gemini-flash-image": "gemini-2.5-flash-image",
    "gemini-pro-image": "gemini-3-pro-image-preview",
    "sdxl": "sdxl",
    "dryrun": "dryrun-image-1",
}

_MODEL_DIRECTIVE_RE = re.compile(
    r"(?:^|\s|,|;)(?:and\s+)?(?:use|using|with)\s+(?P<model>[\w.\-]+)",
    re.IGNORECASE,
)

_REFINE_PREFIXES = {
    "make",
    "adjust",
    "tweak",
    "refine",
    "change",
    "update",
    "add",
    "remove",
    "more",
    "less",
    "bigger",
    "smaller",
    "darker",
    "lighter",
    "brighter",
}

_REFINE_PHRASES = {
    "make it",
    "make this",
    "make that",
    "change it",
    "change this",
    "change that",
    "update it",
    "update this",
    "update that",
    "more ",
    "less ",
}

_REPEAT_PHRASES = {
    "again",
    "same",
    "same thing",
    "same as before",
    "same as last",
    "repeat",
    "rerun",
    "try again",
    "generate again",
    "generate it again",
    "generate it",
    "generate this",
    "generate that",
    "make it",
    "make this",
    "make that",
    "do it",
    "do this",
    "do that",
    "render it",
    "render this",
    "render that",
    "create it",
    "create this",
    "create that",
}

_REPEAT_RE = re.compile(
    r"^(?:now|please|just)?\s*(generate|make|render|create|do|redo|rerun|try)\s+(it|that|this)(\s+again)?$",
    re.IGNORECASE,
)

_EDIT_TRIGGER_RE = re.compile(
    r"^(?:now|please|just)?\s*(edit|replace)\b",
    re.IGNORECASE,
)


def extract_model_directive(prompt: str, registry: ModelRegistry | None = None) -> tuple[str, str | None]:
    match = _MODEL_DIRECTIVE_RE.search(prompt)
    if not match:
        return prompt, None
    raw_model = match.group("model").strip().lower()
    model = _resolve_model(raw_model, registry or ModelRegistry())
    cleaned = (prompt[: match.start()] + prompt[match.end() :]).strip()
    cleaned = " ".join(cleaned.split())
    if not cleaned:
        cleaned = ""
    return cleaned, model


def is_refinement(prompt: str, *, word_threshold: int = 6) -> bool:
    normalized = prompt.strip().lower()
    if not normalized:
        return True
    words = normalized.split()
    if len(words) < word_threshold:
        return True
    if words[0] in _REFINE_PREFIXES:
        return True
    return any(phrase in normalized for phrase in _REFINE_PHRASES)


def is_repeat_request(prompt: str) -> bool:
    normalized = " ".join(prompt.strip().lower().split())
    if not normalized:
        return True
    if normalized in _REPEAT_PHRASES:
        return True
    return _REPEAT_RE.match(normalized) is not None


def detect_edit_model(prompt: str, registry: ModelRegistry | None = None) -> str | None:
    normalized = prompt.strip().lower()
    if not normalized:
        return None
    if not _EDIT_TRIGGER_RE.match(normalized):
        return None
    return _resolve_model("gemini-3-pro-image-preview", registry or ModelRegistry())


def _resolve_model(raw_model: str, registry: ModelRegistry) -> str | None:
    if raw_model in _MODEL_ALIASES:
        return _MODEL_ALIASES[raw_model]
    if registry.get(raw_model):
        return raw_model
    for spec in registry.list():
        if spec.name.lower() == raw_model:
            return spec.name
    return None
