"""Provider adapter registry."""

from __future__ import annotations

from typing import Dict

from .base import ProviderAdapter


_ADAPTERS: Dict[str, ProviderAdapter] = {}


def _build_adapter(provider: str) -> ProviderAdapter:
    key = provider.strip().lower()
    if key == "openai":
        from .openai import OpenAIAdapter
        return OpenAIAdapter()
    if key == "gemini":
        from .gemini import GeminiAdapter
        return GeminiAdapter()
    if key == "imagen":
        from .imagen import ImagenAdapter
        return ImagenAdapter()
    if key == "flux":
        from .flux import FluxAdapter
        return FluxAdapter()
    raise ValueError(f"No adapter registered for provider '{provider}'.")


def get_adapter(provider: str) -> ProviderAdapter:
    key = provider.strip().lower()
    adapter = _ADAPTERS.get(key)
    if adapter is not None:
        return adapter
    adapter = _build_adapter(key)
    _ADAPTERS[key] = adapter
    return adapter


__all__ = ["get_adapter", "ProviderAdapter"]
