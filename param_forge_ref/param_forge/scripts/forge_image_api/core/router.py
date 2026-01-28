"""Provider routing and alias normalization."""

from __future__ import annotations

import os
import re
from typing import Dict


PROVIDER_ALIASES: Dict[str, str] = {
    "openai": "openai",
    "gpt-image-1": "openai",
    "gpt-image": "openai",
    "gptimage": "openai",
    "gemini": "gemini",
    "google": "gemini",
    "gemini-2.5-flash-image": "gemini",
    "gemini-3-pro-image-preview": "gemini",
    "imagen": "imagen",
    "imagen-4": "imagen",
    "imagen-4-ultra": "imagen",
    "vertex": "imagen",
    "flux": "flux",
    "flux-2": "flux",
    "flux-2-flex": "flux",
    "flux-2-pro": "flux",
    "bfl": "flux",
}


def normalize_provider(provider: str | None) -> str:
    if not provider:
        return "openai"
    if provider.strip().lower() in {"auto", "default"}:
        return "auto"
    slug = re.sub(r"[^a-z0-9]+", "-", provider.strip().lower()).strip("-")
    return PROVIDER_ALIASES.get(slug, slug)


def resolve_provider(provider: str | None) -> str:
    normalized = normalize_provider(provider)
    if normalized != "auto":
        return normalized
    env_choice = os.getenv("PARAM_FORGE_PROVIDER")
    if env_choice:
        return normalize_provider(env_choice)
    return "openai"
