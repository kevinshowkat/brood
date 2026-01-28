"""Latency estimation utilities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .tables import load_pricing_tables


@dataclass(frozen=True)
class LatencyEstimate:
    latency_per_image_s: float | None
    latency_per_call_s: float | None


class LatencyEstimator:
    def __init__(self, tables: dict[str, dict[str, Any]] | None = None) -> None:
        self.tables = tables or load_pricing_tables()

    def estimate_image_latency(self, latency_key: str | None) -> LatencyEstimate:
        if not latency_key:
            return LatencyEstimate(None, None)
        row = self.tables.get(latency_key, {})
        latency_image = row.get("latency_per_image_s")
        latency_call = row.get("latency_per_call_s")
        def _to_float(value: Any) -> float | None:
            try:
                return float(value)
            except Exception:
                return None
        return LatencyEstimate(
            latency_per_image_s=_to_float(latency_image),
            latency_per_call_s=_to_float(latency_call),
        )
