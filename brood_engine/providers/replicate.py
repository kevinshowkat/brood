"""Replicate provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class ReplicateProvider:
    name = "replicate"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("Replicate provider not implemented in this build.")
