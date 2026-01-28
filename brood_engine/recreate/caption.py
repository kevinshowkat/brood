"""Prompt inference for recreate flow."""

from __future__ import annotations

from pathlib import Path

from PIL import Image


def infer_prompt(reference_path: Path) -> str:
    try:
        image = Image.open(reference_path)
        info = image.info
        prompt = info.get("parameters") or info.get("prompt")
        if prompt:
            return str(prompt)
    except Exception:
        pass
    return f"Recreate an image similar to {reference_path.name}."
