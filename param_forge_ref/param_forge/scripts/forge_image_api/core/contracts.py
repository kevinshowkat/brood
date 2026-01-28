"""Core data contracts for PARAM FORGE."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Literal, Mapping, Optional, Sequence, Union


ImageMode = Literal["generate", "edit", "variations"]
ImageEventType = Literal["partial", "final", "log", "error"]
ImageInput = Union[str, Path, bytes]


@dataclass(frozen=True)
class ImageInputs:
    init_image: Optional[ImageInput] = None
    mask: Optional[ImageInput] = None
    reference_images: Sequence[ImageInput] = ()


@dataclass
class ImageRequest:
    prompt: str
    mode: ImageMode = "generate"
    size: str = "1024x1024"
    n: int = 1
    seed: Optional[int] = None
    output_format: Optional[str] = None
    background: Optional[str] = None
    inputs: ImageInputs = field(default_factory=ImageInputs)
    provider: Optional[str] = None
    provider_options: Mapping[str, Any] = field(default_factory=dict)
    user: Optional[str] = None
    out_dir: Optional[Path] = None
    stream: bool = False
    partial_images: Optional[int] = None
    model: Optional[str] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ImageResult:
    image_path: Path
    receipt_path: Path
    provider: str
    model: Optional[str] = None
    provider_request_id: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    seed: Optional[int] = None
    usage: Optional[Mapping[str, Any]] = None
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ImageEvent:
    type: ImageEventType
    index: int
    image_bytes: Optional[bytes] = None
    result: Optional[ImageResult] = None
    message: Optional[str] = None
    data: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class ResolvedRequest:
    provider: str
    model: Optional[str]
    size: str
    width: Optional[int]
    height: Optional[int]
    output_format: str
    background: Optional[str]
    seed: Optional[int]
    n: int
    user: Optional[str]
    prompt: str
    inputs: ImageInputs
    stream: bool
    partial_images: Optional[int]
    provider_params: Mapping[str, Any] = field(default_factory=dict)
    warnings: Sequence[str] = ()
