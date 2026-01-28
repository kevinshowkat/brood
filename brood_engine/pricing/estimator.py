"""Cost estimation utilities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .tables import load_pricing_tables


@dataclass(frozen=True)
class CostEstimate:
    cost_per_image_usd: float | None
    cost_per_1k_images_usd: float | None


class PricingEstimator:
    def __init__(self, tables: dict[str, dict[str, Any]] | None = None) -> None:
        self.tables = tables or load_pricing_tables()

    def estimate_image_cost(self, pricing_key: str | None) -> CostEstimate:
        if not pricing_key:
            return CostEstimate(None, None)
        row = self.tables.get(pricing_key, {})
        cost_per_image = row.get("cost_per_image_usd")
        try:
            cost_val = float(cost_per_image)
        except Exception:
            return CostEstimate(None, None)
        return CostEstimate(cost_per_image_usd=cost_val, cost_per_1k_images_usd=cost_val * 1000.0)

    def estimate_text_cost(self, pricing_key: str | None, tokens_in: int, tokens_out: int) -> float | None:
        if not pricing_key:
            return None
        row = self.tables.get(pricing_key, {})
        cost_per_1k = row.get("cost_per_1k_tokens_usd")
        try:
            cost_val = float(cost_per_1k)
        except Exception:
            return None
        total_tokens = max(tokens_in + tokens_out, 1)
        return (total_tokens / 1000.0) * cost_val
