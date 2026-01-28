"""Model registry for Brood."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Mapping


@dataclass(frozen=True)
class ModelSpec:
    name: str
    provider: str
    capabilities: tuple[str, ...]
    context_window: int | None = None
    pricing_key: str | None = None
    latency_key: str | None = None

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities


_DEFAULT_MODELS: dict[str, ModelSpec] = {
    "dryrun-text-1": ModelSpec(
        name="dryrun-text-1",
        provider="dryrun",
        capabilities=("text",),
        context_window=8192,
        pricing_key="dryrun-text",
        latency_key="dryrun-text",
    ),
    "dryrun-image-1": ModelSpec(
        name="dryrun-image-1",
        provider="dryrun",
        capabilities=("image", "edit"),
        pricing_key="dryrun-image",
        latency_key="dryrun-image",
    ),
    "gpt-image-1.5": ModelSpec(
        name="gpt-image-1.5",
        provider="openai",
        capabilities=("image",),
        pricing_key="openai-gpt-image-1.5",
        latency_key="openai-gpt-image-1.5",
    ),
    "gpt-image-1-mini": ModelSpec(
        name="gpt-image-1-mini",
        provider="openai",
        capabilities=("image",),
        pricing_key="openai-gpt-image-1-mini",
        latency_key="openai-gpt-image-1-mini",
    ),
    "gpt-image-1": ModelSpec(
        name="gpt-image-1",
        provider="openai",
        capabilities=("image",),
        pricing_key="openai-gpt-image-1",
        latency_key="openai-gpt-image-1",
    ),
    "gpt-4o-mini": ModelSpec(
        name="gpt-4o-mini",
        provider="openai",
        capabilities=("text", "vision"),
        context_window=128000,
        pricing_key="openai-gpt-4o-mini",
        latency_key="openai-gpt-4o-mini",
    ),
    "gpt-5.2": ModelSpec(
        name="gpt-5.2",
        provider="openai",
        capabilities=("text",),
        context_window=128000,
        pricing_key="openai-gpt-5.2",
        latency_key="openai-gpt-5.2",
    ),
    "gpt-5.1-codex-max": ModelSpec(
        name="gpt-5.1-codex-max",
        provider="openai",
        capabilities=("text", "vision"),
        pricing_key="openai-gpt-5.1-codex-max",
        latency_key="openai-gpt-5.1-codex-max",
    ),
    "claude-opus-4-5-20251101": ModelSpec(
        name="claude-opus-4-5-20251101",
        provider="anthropic",
        capabilities=("text",),
        context_window=200000,
        pricing_key="anthropic-claude-opus-4-5-20251101",
        latency_key="anthropic-claude-opus-4-5-20251101",
    ),
    "gemini-3-pro-preview": ModelSpec(
        name="gemini-3-pro-preview",
        provider="gemini",
        capabilities=("text", "vision"),
        context_window=128000,
        pricing_key="google-gemini-3-pro-preview",
        latency_key="google-gemini-3-pro-preview",
    ),
    "gemini-2.5-flash-image": ModelSpec(
        name="gemini-2.5-flash-image",
        provider="gemini",
        capabilities=("image",),
        pricing_key="google-gemini-2.5-flash-image",
        latency_key="google-gemini-2.5-flash-image",
    ),
    "gemini-3-pro-image-preview": ModelSpec(
        name="gemini-3-pro-image-preview",
        provider="gemini",
        capabilities=("image",),
        pricing_key="google-gemini-3-pro-image-preview",
        latency_key="google-gemini-3-pro-image-preview",
    ),
    "imagen-4.0-ultra": ModelSpec(
        name="imagen-4.0-ultra",
        provider="imagen",
        capabilities=("image",),
        pricing_key="google-imagen-4.0-ultra",
        latency_key="google-imagen-4.0-ultra",
    ),
    "imagen-4": ModelSpec(
        name="imagen-4",
        provider="imagen",
        capabilities=("image",),
        pricing_key="google-imagen-4",
        latency_key="google-imagen-4",
    ),
    "flux-2-flex": ModelSpec(
        name="flux-2-flex",
        provider="flux",
        capabilities=("image", "edit"),
        pricing_key="flux-2-flex",
        latency_key="flux-2-flex",
    ),
    "flux-2-pro": ModelSpec(
        name="flux-2-pro",
        provider="flux",
        capabilities=("image", "edit"),
        pricing_key="flux-2-pro",
        latency_key="flux-2-pro",
    ),
    "flux-2": ModelSpec(
        name="flux-2",
        provider="flux",
        capabilities=("image", "edit"),
        pricing_key="flux-2",
        latency_key="flux-2",
    ),
    "sdxl": ModelSpec(
        name="sdxl",
        provider="replicate",
        capabilities=("image",),
        pricing_key="replicate-sdxl",
        latency_key="replicate-sdxl",
    ),
}


class ModelRegistry:
    def __init__(self, models: Mapping[str, ModelSpec] | None = None) -> None:
        self._models = dict(models) if models else dict(_DEFAULT_MODELS)

    def get(self, name: str) -> ModelSpec | None:
        return self._models.get(name)

    def list(self) -> Iterable[ModelSpec]:
        return self._models.values()

    def by_capability(self, capability: str) -> list[ModelSpec]:
        return [model for model in self._models.values() if model.supports(capability)]

    def ensure(self, name: str, capability: str) -> ModelSpec | None:
        model = self.get(name)
        if model and model.supports(capability):
            return model
        return None
