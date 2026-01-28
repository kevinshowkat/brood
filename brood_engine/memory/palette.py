"""Palette extraction for generated images."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PIL import Image


def extract_palette(image_path: Path, colors: int = 6) -> list[tuple[int, int, int]]:
    image = Image.open(image_path).convert("RGB")
    image = image.resize((128, 128))
    palette = image.convert("P", palette=Image.ADAPTIVE, colors=colors)
    palette_colors = palette.getpalette()
    if not palette_colors:
        return []
    color_counts = palette.getcolors() or []
    color_counts.sort(reverse=True, key=lambda item: item[0])
    result: list[tuple[int, int, int]] = []
    for _, idx in color_counts[:colors]:
        offset = idx * 3
        result.append(
            (
                palette_colors[offset],
                palette_colors[offset + 1],
                palette_colors[offset + 2],
            )
        )
    return result


def palette_to_json(colors: list[tuple[int, int, int]]) -> str:
    payload = [{"r": c[0], "g": c[1], "b": c[2]} for c in colors]
    return json.dumps(payload)
