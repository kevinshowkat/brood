"""Provider registry."""

from __future__ import annotations

from .base import ProviderRegistry
from .dryrun import DryRunProvider
from .openai import OpenAIProvider
from .replicate import ReplicateProvider
from .stability import StabilityProvider
from .fal import FalProvider
from .gemini import GeminiProvider
from .imagen import ImagenProvider
from .flux import FluxProvider


def default_registry() -> ProviderRegistry:
    return ProviderRegistry(
        [
            DryRunProvider(),
            OpenAIProvider(),
            ReplicateProvider(),
            StabilityProvider(),
            FalProvider(),
            GeminiProvider(),
            ImagenProvider(),
            FluxProvider(),
        ]
    )
