"""Provider adapter interfaces."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable, Iterator, Mapping, Optional, Protocol, Sequence

from forge_image_api.core.contracts import ImageRequest, ResolvedRequest


@dataclass
class ProviderImage:
    image_bytes: bytes
    mime_type: Optional[str] = None
    seed: Optional[int] = None
    width: Optional[int] = None
    height: Optional[int] = None
    provider_request_id: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ProviderResponse:
    images: Sequence[ProviderImage]
    model: Optional[str] = None
    usage: Optional[Mapping[str, Any]] = None
    raw_request: Mapping[str, Any] = field(default_factory=dict)
    raw_response: Mapping[str, Any] = field(default_factory=dict)
    warnings: Sequence[str] = ()


@dataclass
class ProviderStreamEvent:
    type: str
    index: int
    image: Optional[ProviderImage] = None
    image_bytes: Optional[bytes] = None
    message: Optional[str] = None
    data: Mapping[str, Any] = field(default_factory=dict)


class ProviderAdapter(Protocol):
    name: str

    def generate(
        self,
        request: ImageRequest,
        resolved: ResolvedRequest,
    ) -> ProviderResponse:
        ...

    def stream(
        self,
        request: ImageRequest,
        resolved: ResolvedRequest,
    ) -> Iterator[ProviderStreamEvent]:
        ...
