"""Offline similarity scoring."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from PIL import Image

try:  # optional
    import numpy as np  # type: ignore
except Exception:  # pragma: no cover
    np = None  # type: ignore


def dhash(image_path: Path) -> int:
    image = Image.open(image_path).convert("L").resize((9, 8))
    pixels = list(image.getdata())
    diff = []
    for row in range(8):
        row_pixels = pixels[row * 9 : row * 9 + 9]
        for col in range(8):
            diff.append(1 if row_pixels[col] > row_pixels[col + 1] else 0)
    value = 0
    for bit in diff:
        value = (value << 1) | bit
    return value


def phash(image_path: Path) -> int | None:
    if np is None:
        return None
    image = Image.open(image_path).convert("L").resize((32, 32))
    pixels = np.asarray(image, dtype=float)
    dct = np.fft.fft2(pixels)
    dct_low = dct[:8, :8].real
    median = np.median(dct_low[1:, 1:])
    bits = dct_low > median
    value = 0
    for bit in bits.flatten():
        value = (value << 1) | int(bit)
    return int(value)


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def _score_hash(a: int, b: int, bits: int) -> float:
    return 1.0 - (_hamming(a, b) / float(bits))


def compare(reference: Path, candidate: Path) -> dict[str, Any]:
    dh_ref = dhash(reference)
    dh_can = dhash(candidate)
    dh_score = _score_hash(dh_ref, dh_can, 64)
    ph_score = None
    ph_ref = phash(reference)
    ph_can = phash(candidate)
    if ph_ref is not None and ph_can is not None:
        ph_score = _score_hash(ph_ref, ph_can, 64)
    overall = dh_score if ph_score is None else (dh_score + ph_score) / 2.0
    return {
        "dhash": dh_score,
        "phash": ph_score,
        "overall": overall,
    }
