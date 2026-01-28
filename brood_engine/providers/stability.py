"""Stability provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class StabilityProvider:
    name = "stability"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("Stability provider not implemented in this build.")
