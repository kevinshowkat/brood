"""Receipt builder and writer."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from ..utils import sanitize_payload, serialize, write_json


RECEIPT_SCHEMA_VERSION = 1


@dataclass
class ImageInputs:
    init_image: str | None = None
    mask: str | None = None
    reference_images: Sequence[str] = ()


@dataclass
class ImageRequest:
    prompt: str
    mode: str = "generate"
    size: str = "1024x1024"
    n: int = 1
    seed: int | None = None
    output_format: str | None = None
    background: str | None = None
    inputs: ImageInputs = field(default_factory=ImageInputs)
    provider: str | None = None
    provider_options: Mapping[str, Any] = field(default_factory=dict)
    user: str | None = None
    out_dir: str | None = None
    stream: bool = False
    partial_images: int | None = None
    model: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ResolvedRequest:
    provider: str
    model: str | None
    size: str
    width: int | None
    height: int | None
    output_format: str
    background: str | None
    seed: int | None
    n: int
    user: str | None
    prompt: str
    inputs: ImageInputs
    stream: bool
    partial_images: int | None
    provider_params: Mapping[str, Any] = field(default_factory=dict)
    warnings: Sequence[str] = ()


@dataclass
class ImageResult:
    image_path: Path
    receipt_path: Path
    provider: str
    model: str | None = None
    provider_request_id: str | None = None
    width: int | None = None
    height: int | None = None
    seed: int | None = None
    usage: Mapping[str, Any] | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


def build_receipt(
    *,
    request: ImageRequest,
    resolved: ResolvedRequest,
    provider_request: Mapping[str, Any],
    provider_response: Mapping[str, Any],
    warnings: list[str],
    image_path: Path,
    receipt_path: Path,
    result_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": RECEIPT_SCHEMA_VERSION,
        "request": serialize(request),
        "resolved": serialize(resolved),
        "provider_request": sanitize_payload(provider_request),
        "provider_response": sanitize_payload(provider_response),
        "warnings": warnings,
        "artifacts": {
            "image_path": str(image_path),
            "receipt_path": str(receipt_path),
        },
        "result_metadata": sanitize_payload(result_metadata),
    }


def write_receipt(path: Path, payload: Mapping[str, Any]) -> None:
    write_json(path, payload)
