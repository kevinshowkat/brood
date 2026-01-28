"""Reasoning summary helpers."""

from __future__ import annotations

import re
import shutil
import threading

from .cli_progress import ProgressTicker
from .providers.openai import fetch_reasoning_summary


def reasoning_summary(
    prompt: str,
    model: str | None,
    *,
    effort: str = "low",
    summary: str = "auto",
    compact: bool = True,
) -> str | None:
    if not model:
        return None
    if not model.startswith(("gpt-", "o")):
        return None
    effort_value = effort
    enable_web_search = False
    if model.startswith("gpt-5.2") and "codex" not in model:
        effort_value = "xhigh"
        enable_web_search = True
    attempts: list[tuple[str, bool]] = [(effort_value, enable_web_search)]
    if effort_value == "xhigh":
        attempts.append(("high", enable_web_search))
    if enable_web_search:
        attempts.append((effort_value if effort_value != "xhigh" else "high", False))
    summary_text = None
    for effort_try, web_search in attempts:
        try:
            summary_text = fetch_reasoning_summary(
                prompt,
                model,
                effort=effort_try,
                summary=summary,
                enable_web_search=web_search,
            )
        except Exception:
            summary_text = None
        if summary_text:
            break
    if not summary_text:
        return None
    if not summary_text:
        return None
    if compact:
        width = None
        try:
            width = shutil.get_terminal_size(fallback=(100, 20)).columns
        except Exception:
            width = None
        return _compact_summary(summary_text, width)
    return _clean_summary(summary_text)


def start_reasoning_summary(
    prompt: str,
    model: str | None,
    ticker: ProgressTicker,
    *,
    effort: str = "low",
    summary: str = "auto",
) -> None:
    def _run() -> None:
        compact = reasoning_summary(prompt, model, effort=effort, summary=summary)
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


def _clean_summary(text: str) -> str:
    cleaned = re.sub(r"[*_`]+", "", text)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned


def build_optimize_reasoning_prompt(receipt: dict, goals: list[str]) -> str:
    request = receipt.get("request") if isinstance(receipt, dict) else {}
    resolved = receipt.get("resolved") if isinstance(receipt, dict) else {}
    metadata = receipt.get("result_metadata") if isinstance(receipt, dict) else {}
    prompt = ""
    provider = ""
    model = ""
    size = ""
    n = ""
    options = {}
    if isinstance(request, dict):
        prompt = str(request.get("prompt", "") or "")
        provider = str(request.get("provider", "") or "")
        model = str(request.get("model", "") or "")
        size = str(request.get("size", "") or "")
        n = str(request.get("n", "") or "")
        options = request.get("provider_options") if isinstance(request.get("provider_options"), dict) else {}
    if isinstance(resolved, dict):
        provider = str(resolved.get("provider", provider) or provider)
        model = str(resolved.get("model", model) or model)
        size = str(resolved.get("size", size) or size)
        n = str(resolved.get("n", n) or n)
        resolved_options = resolved.get("provider_params")
        if isinstance(resolved_options, dict) and resolved_options:
            options = resolved_options
    cost = None
    latency = None
    if isinstance(metadata, dict):
        cost = metadata.get("cost_per_1k_images_usd", metadata.get("cost_total_usd"))
        latency = metadata.get("latency_per_image_s")
    goals_line = ", ".join(goals) if goals else "none"
    options_line = options if options else "(none)"
    return (
        "You are optimizing image generation parameters for the next iteration.\n"
        f"Goals: {goals_line}\n"
        f"Prompt: {prompt}\n"
        f"Provider: {provider} Model: {model}\n"
        f"Size: {size} N: {n}\n"
        f"Current options: {options_line}\n"
        f"Recent cost/latency: cost={cost} latency={latency}\n"
        "Provide a brief reasoning summary of the most impactful parameter changes "
        "to better achieve the goals."
    )
