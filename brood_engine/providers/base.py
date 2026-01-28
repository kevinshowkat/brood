"""Provider base classes."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Mapping, Protocol

from ..runs.receipts import ImageRequest


@dataclass
class GeneratedArtifact:
    image_path: Path
    width: int | None = None
    height: int | None = None
    seed: int | None = None
    metadata: Mapping[str, Any] | None = None


@dataclass
class ProviderResponse:
    results: list[GeneratedArtifact]
    provider_request: Mapping[str, Any]
    provider_response: Mapping[str, Any]
    warnings: list[str]


class ImageProvider(Protocol):
    name: str

    def generate(self, request: ImageRequest) -> ProviderResponse:
        ...


class ProviderRegistry:
    def __init__(self, providers: Iterable[ImageProvider]) -> None:
        self._providers = {provider.name: provider for provider in providers}

    def get(self, name: str) -> ImageProvider | None:
        return self._providers.get(name)

    def list(self) -> list[str]:
        return sorted(self._providers.keys())
