from __future__ import annotations

from pathlib import Path

from brood_engine.runs.cache import CacheStore


def test_cache_store(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache = CacheStore(path)
    cache.set("key", {"value": 1})
    assert cache.get("key")["value"] == 1
