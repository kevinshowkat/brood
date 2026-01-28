"""Provider registry."""

from __future__ import annotations

from .base import ProviderRegistry
from .dryrun import DryRunProvider


def default_registry() -> ProviderRegistry:
    return ProviderRegistry([DryRunProvider()])
