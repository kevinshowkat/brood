"""LLM council stub for analysis."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class AnalysisResult:
    recommendations: list[str]
    analysis_excerpt: str


def analyze_receipt(receipt: dict[str, Any]) -> AnalysisResult:
    # Deterministic placeholder; real implementation would call LLMs.
    prompt = str(receipt.get("request", {}).get("prompt", ""))
    excerpt = f"Receipt analyzed for prompt: {prompt[:80]}"
    return AnalysisResult(recommendations=["Try a different size"], analysis_excerpt=excerpt)
