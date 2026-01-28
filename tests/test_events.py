from __future__ import annotations

import json
from pathlib import Path

from brood_engine.runs.events import EventWriter


def test_event_writer(tmp_path: Path) -> None:
    path = tmp_path / "events.jsonl"
    writer = EventWriter(path, "run-123")
    writer.emit("run_started", out_dir="/tmp/run")
    lines = path.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    payload = json.loads(lines[0])
    assert payload["type"] == "run_started"
    assert payload["run_id"] == "run-123"
    assert "ts" in payload
    assert payload["out_dir"] == "/tmp/run"
