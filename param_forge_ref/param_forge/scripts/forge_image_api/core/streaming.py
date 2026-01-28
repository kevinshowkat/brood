"""Streaming helpers."""

from __future__ import annotations

from typing import Iterable, Iterator

from .contracts import ImageEvent, ImageResult


def wrap_final_results(results: Iterable[ImageResult]) -> Iterator[ImageEvent]:
    for idx, result in enumerate(results):
        yield ImageEvent(type="final", index=idx, result=result)
