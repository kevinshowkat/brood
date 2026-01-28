"""OpenAI provider placeholder."""

from __future__ import annotations

from ..runs.receipts import ImageRequest
from .base import ProviderResponse


class OpenAIProvider:
    name = "openai"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        raise RuntimeError("OpenAI provider not implemented in this build.")
