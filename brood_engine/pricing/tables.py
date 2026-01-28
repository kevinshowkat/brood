"""Pricing tables with overrides."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..utils import read_json


DEFAULT_PRICING_PATH = Path(__file__).with_name("default_pricing.json")
OVERRIDE_PATH = Path.home() / ".brood" / "pricing_overrides.json"


def load_pricing_tables() -> dict[str, dict[str, Any]]:
    base = read_json(DEFAULT_PRICING_PATH, {})
    overrides = read_json(OVERRIDE_PATH, {})
    if not isinstance(base, dict):
        base = {}
    if not isinstance(overrides, dict):
        overrides = {}
    merged: dict[str, dict[str, Any]] = {}
    for key, val in base.items():
        if isinstance(val, dict):
            merged[key] = dict(val)
    for key, val in overrides.items():
        if isinstance(val, dict):
            merged.setdefault(key, {}).update(val)
    return merged


def save_override_tables(payload: dict[str, Any]) -> None:
    OVERRIDE_PATH.parent.mkdir(parents=True, exist_ok=True)
    OVERRIDE_PATH.write_text(json.dumps(payload, indent=2), encoding="utf-8")
