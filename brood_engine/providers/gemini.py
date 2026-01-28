"""Gemini provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class GeminiProvider:
    name = "gemini"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("Gemini provider not implemented in this build.")
