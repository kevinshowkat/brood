from __future__ import annotations

from pathlib import Path

from brood_engine.runs.thread_manifest import ThreadManifest


def test_thread_manifest_versions(tmp_path: Path) -> None:
    path = tmp_path / "thread.json"
    manifest = ThreadManifest(path)
    v1 = manifest.add_version(intent={"action": "generate"}, settings={"size": "1024x1024"}, prompt="A", parent_version_id=None)
    v2 = manifest.add_version(intent={"action": "generate"}, settings={"size": "512x512"}, prompt="B", parent_version_id=v1.version_id)
    manifest.add_artifact(v2.version_id, {"artifact_id": "a1"})
    manifest.save()

    loaded = ThreadManifest.load(path)
    assert len(loaded.versions) == 2
    assert loaded.versions[1].parent_version_id == v1.version_id
    assert loaded.versions[1].prompt_diff is not None
    assert loaded.versions[1].settings_diff is not None
    assert loaded.versions[1].artifacts[0]["artifact_id"] == "a1"
