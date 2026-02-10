"""Cost estimation utilities."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import re

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

    def estimate_image_cost_with_params(
        self,
        pricing_key: str | None,
        *,
        size: str | None = None,
        provider_options: Mapping[str, Any] | None = None,
    ) -> CostEstimate:
        """Estimate image cost with param-aware tiering.

        The default pricing tables can optionally define tier rules like:
        - `cost_per_image_usd_by_image_size`: {"1K": 0.01, "2K": 0.02, "4K": 0.04}
        - `cost_multipliers_by_image_size`: {"4K": 2.0}

        `image_size` is pulled from `provider_options.image_size` (preferred). If
        missing, it is inferred from `size` when possible.
        """

        base = self.estimate_image_cost(pricing_key)
        if not pricing_key or base.cost_per_image_usd is None:
            return base

        row = self.tables.get(pricing_key, {})
        if not isinstance(row, Mapping):
            return base

        tier = _resolve_image_size_tier(size=size, provider_options=provider_options)
        if not tier:
            return base

        # Absolute pricing table wins.
        abs_by = row.get("cost_per_image_usd_by_image_size")
        if isinstance(abs_by, Mapping) and tier in abs_by:
            try:
                val = float(abs_by[tier])
                return CostEstimate(cost_per_image_usd=val, cost_per_1k_images_usd=val * 1000.0)
            except Exception:
                pass

        # Otherwise multiplier.
        mult_by = row.get("cost_multipliers_by_image_size")
        if isinstance(mult_by, Mapping) and tier in mult_by:
            try:
                mult = float(mult_by[tier])
                val = float(base.cost_per_image_usd) * mult
                return CostEstimate(cost_per_image_usd=val, cost_per_1k_images_usd=val * 1000.0)
            except Exception:
                pass

        return base

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


_DIM_RE = re.compile(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$")


def _resolve_image_size_tier(
    *, size: str | None, provider_options: Mapping[str, Any] | None
) -> str | None:
    # Provider options override.
    if isinstance(provider_options, Mapping):
        raw = provider_options.get("image_size")
        if isinstance(raw, str) and raw.strip():
            normalized = raw.strip().upper()
            if normalized in {"1K", "2K", "4K"}:
                return normalized

    if not size:
        return None
    normalized = str(size).strip().lower()
    if normalized in {"1k", "2k", "4k"}:
        return normalized.upper()

    match = _DIM_RE.match(normalized)
    if match:
        try:
            w = int(match.group(1))
            h = int(match.group(2))
        except Exception:
            return None
        longest = max(w, h)
        if longest >= 3600:
            return "4K"
        if longest >= 1800:
            return "2K"
        # Avoid applying implicit "1K" tiering unless the caller explicitly opted in
        # via provider options or a symbolic size string.
        return None
    return None
