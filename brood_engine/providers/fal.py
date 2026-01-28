"""Fal provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class FalProvider:
    name = "fal"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("Fal provider not implemented in this build.")
