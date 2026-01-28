from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from brood_engine.recreate.loop import RecreateLoop
from brood_engine.runs.events import EventWriter
from brood_engine.utils import write_json


def test_recreate_loop_updates_receipt(tmp_path: Path) -> None:
    reference = tmp_path / "ref.png"
    Image.new("RGB", (64, 64), (0, 255, 0)).save(reference)

    events_path = tmp_path / "events.jsonl"
    writer = EventWriter(events_path, "run-1")

    def fake_generate(prompt: str, settings: dict[str, object], intent: dict[str, object]):
        image_path = tmp_path / f"candidate-{intent['iteration']}.png"
        Image.new("RGB", (64, 64), (0, 255, 0)).save(image_path)
        receipt_path = tmp_path / f"receipt-{intent['iteration']}.json"
        write_json(receipt_path, {"result_metadata": {}})
        return [
            {
                "artifact_id": f"a-{intent['iteration']}",
                "image_path": str(image_path),
                "receipt_path": str(receipt_path),
            }
        ]

    loop = RecreateLoop(fake_generate, writer, "run-1")
    result = loop.run(reference, settings={}, iterations=1, target_similarity=0.5)
    assert result["best_score"] >= 0.9

    receipt_payload = json.loads((tmp_path / "receipt-1.json").read_text(encoding="utf-8"))
    assert "similarity" in receipt_payload.get("result_metadata", {})

    events = events_path.read_text(encoding="utf-8").strip().splitlines()
    assert any("recreate_iteration_update" in line for line in events)
