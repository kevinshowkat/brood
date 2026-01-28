from __future__ import annotations

from brood_engine.utils import format_cost_generation_cents, format_latency_seconds


def test_cost_and_latency_formatting() -> None:
    assert format_cost_generation_cents(34.0) == "3400 cents"
    assert format_cost_generation_cents(0.004) == "0 cents"
    assert format_latency_seconds(38.503) == "38.5s"
