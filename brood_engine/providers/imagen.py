"""Imagen provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class ImagenProvider:
    name = "imagen"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("Imagen provider not implemented in this build.")
