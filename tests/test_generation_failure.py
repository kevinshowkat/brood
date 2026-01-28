from __future__ import annotations

import json
from pathlib import Path

import pytest

from brood_engine.engine import BroodEngine
from brood_engine.providers.base import ProviderRegistry
from brood_engine.runs.receipts import ImageRequest


class FailingProvider:
    name = "dryrun"

    def generate(self, request: ImageRequest):  # type: ignore[override]
        raise RuntimeError("boom")


def test_generation_failed_event_emitted(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    registry = ProviderRegistry([FailingProvider()])
    engine = BroodEngine(
        run_dir,
        events_path,
        text_model="dryrun-text-1",
        image_model="dryrun-image-1",
        provider_registry=registry,
    )

    with pytest.raises(RuntimeError):
        engine.generate("boat", {"size": "1024x1024", "n": 1}, {"action": "generate"})

    assert engine.last_cost_latency is not None

    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
    types = [event["type"] for event in events]
    assert "generation_failed" in types
    assert "cost_latency_update" in types
