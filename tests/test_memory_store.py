from __future__ import annotations

from pathlib import Path

from brood_engine.memory.store import MemoryStore


def test_memory_store_insert(tmp_path: Path) -> None:
    store = MemoryStore(path=tmp_path / "memory.sqlite")
    store.init_db()
    store.add_artifact(
        {
            "artifact_id": "a1",
            "run_id": "r1",
            "version_id": "v1",
            "image_path": "/tmp/img.png",
            "receipt_path": "/tmp/receipt.json",
            "provider": "dryrun",
            "model": "dryrun-image-1",
            "prompt": "test",
            "created_at": "now",
        }
    )
    store.upsert_profile("default", "summary", "{}", "now")
    profiles = store.list_profiles()
    assert "default" in profiles
