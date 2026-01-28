"""Context window tracking and summarization."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

try:  # optional tokenizer
    import tiktoken  # type: ignore
except Exception:  # pragma: no cover
    tiktoken = None  # type: ignore


@dataclass
class ContextUsage:
    used_tokens: int
    max_tokens: int
    pct: float
    alert_level: str


class ContextTracker:
    def __init__(self, max_tokens: int = 8192) -> None:
        self.max_tokens = max_tokens
        self.used_tokens = 0
        self.history: list[str] = []

    def _estimate_tokens(self, text: str, model: str | None = None) -> int:
        if tiktoken is not None:
            try:
                enc = tiktoken.encoding_for_model(model or "gpt-4o-mini")
            except Exception:
                enc = tiktoken.get_encoding("cl100k_base")
            return len(enc.encode(text))
        return max(1, int(len(text) / 4))

    def record_call(self, text_in: str, text_out: str, model: str | None = None) -> ContextUsage:
        tokens_in = self._estimate_tokens(text_in, model)
        tokens_out = self._estimate_tokens(text_out, model)
        self.used_tokens += tokens_in + tokens_out
        self.history.append(text_in)
        pct = min(self.used_tokens / max(self.max_tokens, 1), 1.0)
        alert = "none"
        if pct >= 0.95:
            alert = "95"
        elif pct >= 0.85:
            alert = "85"
        elif pct >= 0.70:
            alert = "70"
        return ContextUsage(used_tokens=self.used_tokens, max_tokens=self.max_tokens, pct=pct, alert_level=alert)

    def maybe_summarize(self) -> str | None:
        if self.used_tokens < int(self.max_tokens * 0.85):
            return None
        # Simple heuristic summary: keep the last 3 turns and summarize earlier text.
        if len(self.history) <= 3:
            snapshot = " ".join(self.history)
            summary = snapshot[:500] + ("..." if len(snapshot) > 500 else "")
            self.used_tokens = int(self.max_tokens * 0.5)
            return summary
        older = " ".join(self.history[:-3])
        summary = older[:500] + ("..." if len(older) > 500 else "")
        self.history = self.history[-3:]
        self.used_tokens = int(self.max_tokens * 0.5)
        return summary
