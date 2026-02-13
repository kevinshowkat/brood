from __future__ import annotations

from pathlib import Path

from brood_engine.runs.cache import CacheStore


def test_cache_store(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache = CacheStore(path)
    cache.set("key", {"value": 1})
    assert cache.get("key")["value"] == 1


def test_cache_get_returns_deep_copy(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache = CacheStore(path)
    cache.set("key", {"items": [{"value": 1}]})

    fetched = cache.get("key")
    assert fetched is not None
    fetched["items"][0]["value"] = 99

    assert cache.get("key") == {"items": [{"value": 1}]}


def test_cache_set_persists_mutated_reused_object(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache = CacheStore(path)
    cache.set("key", {"value": 1})

    payload = cache.get("key")
    assert payload is not None
    payload["value"] = 2
    cache.set("key", payload)

    reloaded = CacheStore(path)
    assert reloaded.get("key") == {"value": 2}


def test_cache_set_merges_with_concurrent_writer(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache_a = CacheStore(path)
    cache_b = CacheStore(path)

    cache_a.set("a", {"value": 1})
    cache_b.set("b", {"value": 2})
    cache_a.set("c", {"value": 3})

    reloaded = CacheStore(path)
    assert reloaded.get("a") == {"value": 1}
    assert reloaded.get("b") == {"value": 2}
    assert reloaded.get("c") == {"value": 3}


def test_cache_get_refreshes_between_instances(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache_a = CacheStore(path)
    cache_b = CacheStore(path)

    cache_a.set("key", {"value": 1})
    assert cache_b.get("key") == {"value": 1}

    cache_b.set("key", {"value": 2})
    assert cache_a.get("key") == {"value": 2}


def test_cache_set_does_not_noop_on_stale_local_snapshot(tmp_path: Path) -> None:
    path = tmp_path / "cache.json"
    cache_a = CacheStore(path)
    cache_b = CacheStore(path)

    cache_a.set("key", {"value": 1})
    cache_b.set("key", {"value": 2})

    cache_a.set("key", {"value": 1})
    reloaded = CacheStore(path)
    assert reloaded.get("key") == {"value": 1}
