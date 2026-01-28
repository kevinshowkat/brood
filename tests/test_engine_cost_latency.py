from __future__ import annotations

import json
from pathlib import Path

from brood_engine.engine import BroodEngine


def test_cost_latency_emitted(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model="dryrun-text-1", image_model="dryrun-image-1")
    engine.generate("boat", {"size": "1024x1024", "n": 1}, {"action": "generate"})
    engine.finish()

    assert engine.last_cost_latency is not None
    assert engine.last_cost_latency["cost_total_usd"] == 0.0
    assert engine.last_cost_latency["latency_per_image_s"] is not None

    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
    assert any(event["type"] == "cost_latency_update" for event in events)
