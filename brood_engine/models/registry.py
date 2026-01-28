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
