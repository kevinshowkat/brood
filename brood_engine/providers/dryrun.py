"""Dry-run image provider (offline)."""

from __future__ import annotations

import hashlib
import random
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from ..runs.receipts import ImageRequest
from .base import GeneratedArtifact, ProviderResponse


class DryRunProvider:
    name = "dryrun"

    def __init__(self) -> None:
        self._font = None

    def generate(self, request: ImageRequest) -> ProviderResponse:
        start = time.monotonic()
        results: list[GeneratedArtifact] = []
        width, height = _resolve_size(request.size)
        for idx in range(request.n):
            seed = request.seed if request.seed is not None else random.randint(1, 10_000_000)
            image_path = _build_image_path(request.out_dir, idx)
            image = Image.new("RGB", (width, height), _color_from_prompt(request.prompt, seed))
            draw = ImageDraw.Draw(image)
            font = self._font or ImageFont.load_default()
            text = f"dryrun\n{request.prompt[:60]}"
            draw.text((20, 20), text, fill=(255, 255, 255), font=font)
            image.save(image_path)
            results.append(
                GeneratedArtifact(
                    image_path=image_path,
                    width=width,
                    height=height,
                    seed=seed,
                    metadata={"dryrun": True},
                )
            )
        elapsed = time.monotonic() - start
        provider_request: dict[str, Any] = {
            "prompt": request.prompt,
            "size": request.size,
            "n": request.n,
        }
        provider_response: dict[str, Any] = {
            "elapsed": elapsed,
            "count": len(results),
        }
        return ProviderResponse(results=results, provider_request=provider_request, provider_response=provider_response, warnings=[])


def _build_image_path(out_dir: str | None, idx: int) -> Path:
    base_dir = Path(out_dir) if out_dir else Path(".")
    base_dir.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time() * 1000)
    return base_dir / f"artifact-{stamp}-{idx:02d}.png"


def _resolve_size(size: str) -> tuple[int, int]:
    normalized = (size or "").strip().lower()
    if normalized in {"portrait", "tall"}:
        return (1024, 1536)
    if normalized in {"landscape", "wide"}:
        return (1536, 1024)
    if normalized in {"square", "1:1"}:
        return (1024, 1024)
    if "x" in normalized:
        parts = normalized.split("x", 1)
        try:
            return int(parts[0]), int(parts[1])
        except Exception:
            return (1024, 1024)
    return (1024, 1024)


def _color_from_prompt(prompt: str, seed: int) -> tuple[int, int, int]:
    digest = hashlib.sha256(f"{prompt}:{seed}".encode("utf-8")).digest()
    return digest[0], digest[1], digest[2]
