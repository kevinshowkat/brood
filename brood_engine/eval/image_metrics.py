"""Image metric stubs."""

from __future__ import annotations

from pathlib import Path


def compute_metrics(image_path: Path) -> dict[str, float]:
    # Placeholder for real metrics (sharpness, contrast, etc.)
    return {"sharpness": 0.5, "contrast": 0.5}
