"""Model selection and fallback logic."""

from __future__ import annotations

from dataclasses import dataclass

from .registry import ModelRegistry, ModelSpec


@dataclass(frozen=True)
class ModelSelection:
    model: ModelSpec
    requested: str | None
    fallback_reason: str | None = None


class ModelSelector:
    def __init__(self, registry: ModelRegistry | None = None) -> None:
        self.registry = registry or ModelRegistry()

    def select(self, requested: str | None, capability: str) -> ModelSelection:
        if requested:
            model = self.registry.ensure(requested, capability)
            if model:
                return ModelSelection(model=model, requested=requested)
            fallback_reason = f"Requested model '{requested}' unavailable for capability '{capability}'."
        else:
            fallback_reason = "No model specified; using default."

        candidates = self.registry.by_capability(capability)
        if not candidates:
            raise RuntimeError(f"No models available for capability '{capability}'.")
        model = candidates[0]
        return ModelSelection(model=model, requested=requested, fallback_reason=fallback_reason)
