"""Reasoning summary helpers."""

from __future__ import annotations

import re
import shutil
import threading

from .cli_progress import ProgressTicker
from .providers.openai import fetch_reasoning_summary


def start_reasoning_summary(
    prompt: str,
    model: str | None,
    ticker: ProgressTicker,
    *,
    effort: str = "low",
    summary: str = "auto",
) -> None:
    if not model:
        return
    if not model.startswith(("gpt-", "o")):
        return

    def _run() -> None:
        try:
            summary_text = fetch_reasoning_summary(
                prompt, model, effort=effort, summary=summary
            )
        except Exception:
            return
        if not summary_text:
            return
        width = None
        try:
            width = shutil.get_terminal_size(fallback=(100, 20)).columns
        except Exception:
            width = None
        compact = _compact_summary(summary_text, width)
        if compact:
            ticker.update_label(f"Reasoning: {compact}")

    thread = threading.Thread(target=_run, daemon=True)
    thread.start()


def _compact_summary(text: str, width: int | None) -> str:
    cleaned = re.sub(r"[*_`]+", "", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    max_len = 120
    if width:
        max_len = max(40, width - 30)
    if len(cleaned) > max_len:
        cleaned = cleaned[: max_len - 1].rstrip() + "…"
    return cleaned
