"""Deterministic request cache."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import read_json, write_json


@dataclass
class CacheStore:
    path: Path

    def _load(self) -> dict[str, Any]:
        payload = read_json(self.path, {})
        return payload if isinstance(payload, dict) else {}

    def get(self, key: str) -> dict[str, Any] | None:
        payload = self._load()
        value = payload.get(key)
        return value if isinstance(value, dict) else None

    def set(self, key: str, value: dict[str, Any]) -> None:
        payload = self._load()
        payload[key] = value
        write_json(self.path, payload)
