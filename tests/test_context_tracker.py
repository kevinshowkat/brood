from __future__ import annotations

from brood_engine.chat.context_tracker import ContextTracker


def test_context_tracker_alerts() -> None:
    tracker = ContextTracker(max_tokens=100)
    usage = tracker.record_call("a" * 600, "", None)
    assert usage.alert_level in {"70", "85", "95"}
    summary = tracker.maybe_summarize()
    assert summary is not None
