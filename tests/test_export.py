from __future__ import annotations

from pathlib import Path

from brood_engine.runs.export import export_html
from brood_engine.utils import write_json


def test_export_html(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    thread_path = run_dir / "thread.json"
    write_json(
        thread_path,
        {
            "schema_version": 1,
            "thread_id": "t1",
            "created_at": "now",
            "versions": [
                {
                    "version_id": "v1",
                    "parent_version_id": None,
                    "intent": {},
                    "settings": {},
                    "prompt": "hello",
                    "prompt_diff": None,
                    "settings_diff": None,
                    "artifacts": [
                        {
                            "artifact_id": "a1",
                            "image_path": "image.png",
                            "receipt_path": "receipt.json",
                        }
                    ],
                    "selected_artifact_id": None,
                    "feedback": [],
                }
            ],
            "context_summary": {"text": "", "updated_at": None},
        },
    )
    out_path = tmp_path / "export.html"
    export_html(run_dir, out_path)
    assert out_path.exists()
    html = out_path.read_text(encoding="utf-8")
    assert "Brood Run Export" in html
