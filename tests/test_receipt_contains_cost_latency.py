from __future__ import annotations

import json
from pathlib import Path

from brood_engine.engine import BroodEngine


def test_receipt_contains_cost_latency(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model="dryrun-text-1", image_model="dryrun-image-1")
    engine.generate("boat", {"size": "1024x1024", "n": 1}, {"action": "generate"})
    engine.finish()

    receipt_paths = list(run_dir.glob("receipt-*.json"))
    assert receipt_paths
    payload = json.loads(receipt_paths[0].read_text(encoding="utf-8"))
    metadata = payload.get("result_metadata", {})
    assert "cost_total_usd" in metadata
    assert "cost_per_1k_images_usd" in metadata
    assert "latency_per_image_s" in metadata
