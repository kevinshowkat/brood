"""Provider capability registry."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet


@dataclass(frozen=True)
class ProviderCapabilities:
    name: str
    supports_stream: bool
    supports_partial_images: bool
    supports_edit: bool
    supports_seed: bool
    output_formats: FrozenSet[str]
    size_modes: FrozenSet[str]


_CAPABILITIES: Dict[str, ProviderCapabilities] = {
    "openai": ProviderCapabilities(
        name="openai",
        supports_stream=True,
        supports_partial_images=True,
        supports_edit=True,
        supports_seed=True,
        output_formats=frozenset({"png", "jpeg", "webp"}),
        size_modes=frozenset({"fixed", "auto"}),
    ),
    "gemini": ProviderCapabilities(
        name="gemini",
        supports_stream=False,
        supports_partial_images=False,
        supports_edit=False,
        supports_seed=False,
        output_formats=frozenset({"png", "jpeg", "webp"}),
        size_modes=frozenset({"aspect", "preset"}),
    ),
    "imagen": ProviderCapabilities(
        name="imagen",
        supports_stream=False,
        supports_partial_images=False,
        supports_edit=False,
        supports_seed=True,
        output_formats=frozenset({"png", "jpeg"}),
        size_modes=frozenset({"preset", "fixed"}),
    ),
    "flux": ProviderCapabilities(
        name="flux",
        supports_stream=False,
        supports_partial_images=False,
        supports_edit=True,
        supports_seed=True,
        output_formats=frozenset({"png", "jpeg"}),
        size_modes=frozenset({"fixed", "aspect"}),
    ),
}


def get_capabilities(provider: str) -> ProviderCapabilities:
    key = provider.strip().lower()
    if key not in _CAPABILITIES:
        raise ValueError(f"Unknown provider '{provider}'")
    return _CAPABILITIES[key]
