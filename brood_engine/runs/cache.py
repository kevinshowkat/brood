"""Deterministic request cache."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..utils import read_json, write_json


@dataclass
class CacheStore:
    path: Path
    _payload: dict[str, Any] | None = field(default=None, init=False, repr=False)
    _dirty: bool = field(default=False, init=False, repr=False)
    _dirty_keys: set[str] = field(default_factory=set, init=False, repr=False)

    def _ensure_loaded(self, *, refresh: bool = False) -> dict[str, Any]:
        if refresh or self._payload is None:
            payload = read_json(self.path, {})
            self._payload = payload if isinstance(payload, dict) else {}
        return self._payload

    def get(self, key: str) -> dict[str, Any] | None:
        payload = self._ensure_loaded(refresh=True)
        value = payload.get(key)
        return deepcopy(value) if isinstance(value, dict) else None

    def set(self, key: str, value: dict[str, Any]) -> None:
        payload = self._ensure_loaded(refresh=True)
        snapshot = deepcopy(value)
        if payload.get(key) == snapshot:
            return
        payload[key] = snapshot
        self._dirty = True
        self._dirty_keys.add(key)
        self.flush()

    def flush(self) -> None:
        if self._payload is None or not self._dirty or not self._dirty_keys:
            return
        on_disk = read_json(self.path, {})
        merged = on_disk if isinstance(on_disk, dict) else {}
        for key in self._dirty_keys:
            if key in self._payload:
                merged[key] = deepcopy(self._payload[key])
        write_json(self.path, merged)
        self._payload = merged
        self._dirty = False
        self._dirty_keys.clear()
