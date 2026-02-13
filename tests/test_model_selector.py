from __future__ import annotations

import pytest

from brood_engine.models.registry import ModelRegistry, ModelSpec
from brood_engine.models.selectors import ModelSelector
from brood_engine.providers.base import ProviderRegistry


def _image_model(name: str) -> ModelSpec:
    return ModelSpec(
        name=name,
        provider="dryrun",
        capabilities=("image",),
        pricing_key=name,
        latency_key=name,
    )


def test_model_selector_falls_back_when_requested_model_unavailable() -> None:
    registry = ModelRegistry({"gpt-image-fallback": _image_model("gpt-image-fallback")})
    selection = ModelSelector(registry).select("missing", "image")

    assert selection.model.name == "gpt-image-fallback"
    assert selection.requested == "missing"
    assert selection.fallback_reason == "Requested model 'missing' unavailable for capability 'image'."


def test_model_selector_no_request_uses_default_with_explanation() -> None:
    registry = ModelRegistry({"gpt-image-default": _image_model("gpt-image-default")})
    selection = ModelSelector(registry).select(None, "image")

    assert selection.model.name == "gpt-image-default"
    assert selection.fallback_reason == "No model specified; using default."


def test_model_selector_raises_when_no_models_for_capability() -> None:
    registry = ModelRegistry({"text-only": ModelSpec(name="text-only", provider="dryrun", capabilities=("text",))})
    selector = ModelSelector(registry)
    with pytest.raises(RuntimeError, match="No models available for capability 'image'."):
        selector.select("gpt-image-1", "image")


def test_model_selector_respects_provider_registry_order() -> None:
    registry = ProviderRegistry([_DummyProvider("z"), _DummyProvider("a"), _DummyProvider("m")])
    assert registry.list() == ["a", "m", "z"]
    assert [p.name for p in registry.providers()] == ["z", "a", "m"]


class _DummyProvider:
    def __init__(self, name: str) -> None:
        self.name = name
