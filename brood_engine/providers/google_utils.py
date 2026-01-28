"""Shared helpers for Google image providers."""

from __future__ import annotations

import re
import time
from pathlib import Path
from typing import Optional, Tuple


_DIM_RE = re.compile(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$")
_RATIO_RE = re.compile(r"^\s*(\d+)\s*[:/]\s*(\d+)\s*$")

_GEMINI_RATIOS = {
    "1:1": 1.0,
    "2:3": 2.0 / 3.0,
    "3:2": 3.0 / 2.0,
    "3:4": 3.0 / 4.0,
    "4:3": 4.0 / 3.0,
    "4:5": 4.0 / 5.0,
    "5:4": 5.0 / 4.0,
    "9:16": 9.0 / 16.0,
    "16:9": 16.0 / 9.0,
    "21:9": 21.0 / 9.0,
}


def normalize_output_format(value: Optional[str], default: Optional[str]) -> Optional[str]:
    if not value:
        return default
    lowered = value.strip().lower()
    if lowered.startswith("image/"):
        lowered = lowered.split("/", 1)[1]
    if lowered in {"jpg", "jpeg"}:
        return "jpeg"
    if lowered in {"png", "webp"}:
        return lowered
    return default


def parse_dims(value: str | None) -> Optional[Tuple[int, int]]:
    if not value:
        return None
    match = _DIM_RE.match(value)
    if not match:
        return None
    w = int(match.group(1))
    h = int(match.group(2))
    if w <= 0 or h <= 0:
        return None
    return w, h


def parse_ratio(value: str | None) -> Optional[Tuple[int, int]]:
    if not value:
        return None
    match = _RATIO_RE.match(value)
    if not match:
        return None
    w = int(match.group(1))
    h = int(match.group(2))
    if w <= 0 or h <= 0:
        return None
    return w, h


def nearest_gemini_ratio(size: str | None, warnings: list[str]) -> Optional[str]:
    if not size:
        return None
    normalized = size.strip().lower()
    if normalized in {"portrait", "tall"}:
        return "9:16"
    if normalized in {"landscape", "wide"}:
        return "16:9"
    if normalized in {"square", "1:1"}:
        return "1:1"
    if _RATIO_RE.match(normalized):
        ratio = parse_ratio(normalized)
        if ratio:
            candidate = f"{ratio[0]}:{ratio[1]}"
            if candidate in _GEMINI_RATIOS:
                return candidate
            target_ratio = ratio[0] / ratio[1]
        else:
            return None
    else:
        dims = parse_dims(normalized)
        if not dims:
            return None
        target_ratio = dims[0] / dims[1]

    best_key = None
    best_delta = float("inf")
    for key, val in _GEMINI_RATIOS.items():
        delta = abs(val - target_ratio)
        if delta < best_delta:
            best_key = key
            best_delta = delta
    if best_key and best_key != normalized:
        warnings.append(f"Gemini aspect ratio snapped to {best_key}.")
    return best_key


def resolve_image_size_hint(size: str | None) -> str:
    if not size:
        return "2K"
    normalized = size.strip().lower()
    if normalized in {"1k", "2k", "4k"}:
        return normalized.upper()
    dims = parse_dims(normalized)
    if dims:
        longest = max(dims)
        if longest >= 3600:
            return "4K"
        if longest >= 1800:
            return "2K"
        return "1K"
    return "2K"


def extension_from_format(output_format: Optional[str]) -> str:
    if not output_format:
        return "png"
    normalized = output_format.strip().lower()
    if normalized in {"jpeg", "jpg"}:
        return "jpg"
    if normalized == "webp":
        return "webp"
    return "png"


def build_image_path(out_dir: str | None, idx: int, output_format: Optional[str]) -> Path:
    base_dir = Path(out_dir) if out_dir else Path(".")
    base_dir.mkdir(parents=True, exist_ok=True)
    timestamp = int(time.time() * 1000)
    ext = extension_from_format(output_format)
    return base_dir / f"artifact-{timestamp}-{idx:02d}.{ext}"

