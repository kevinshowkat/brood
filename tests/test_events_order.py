from __future__ import annotations

import json
from pathlib import Path

from brood_engine.engine import BroodEngine


def test_generation_event_order(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model="dryrun-text-1", image_model="dryrun-image-1")
    engine.generate("boat", {"size": "1024x1024", "n": 1}, {"action": "generate"})
    engine.finish()

    events = [json.loads(line) for line in events_path.read_text(encoding="utf-8").splitlines()]
    types = [event["type"] for event in events]

    assert "plan_preview" in types
    assert "version_created" in types
    assert "artifact_created" in types
    assert "cost_latency_update" in types
    assert "run_finished" in types

    plan_idx = types.index("plan_preview")
    version_idx = types.index("version_created")
    artifact_idxs = [idx for idx, t in enumerate(types) if t == "artifact_created"]
    cost_idx = types.index("cost_latency_update")
    finished_idx = types.index("run_finished")

    assert plan_idx < version_idx
    assert artifact_idxs and version_idx < min(artifact_idxs)
    assert max(artifact_idxs) < cost_idx < finished_idx
