from __future__ import annotations

import json
from pathlib import Path

from brood_engine.pricing.estimator import PricingEstimator
from brood_engine.pricing.latency import LatencyEstimator
import brood_engine.pricing.tables as tables


def test_pricing_estimator(tmp_path: Path, monkeypatch) -> None:
    default_path = tmp_path / "default.json"
    override_path = tmp_path / "override.json"
    default_path.write_text(json.dumps({"model-a": {"cost_per_image_usd": 0.01}}), encoding="utf-8")
    override_path.write_text(json.dumps({"model-a": {"cost_per_image_usd": 0.02}}), encoding="utf-8")

    monkeypatch.setattr(tables, "DEFAULT_PRICING_PATH", default_path)
    monkeypatch.setattr(tables, "OVERRIDE_PATH", override_path)
    merged = tables.load_pricing_tables()
    estimator = PricingEstimator(merged)
    estimate = estimator.estimate_image_cost("model-a")
    assert estimate.cost_per_image_usd == 0.02
    assert estimate.cost_per_1k_images_usd == 20.0


def test_latency_estimator(tmp_path: Path, monkeypatch) -> None:
    default_path = tmp_path / "default.json"
    default_path.write_text(json.dumps({"model-b": {"latency_per_image_s": 1.5}}), encoding="utf-8")
    monkeypatch.setattr(tables, "DEFAULT_PRICING_PATH", default_path)
    monkeypatch.setattr(tables, "OVERRIDE_PATH", tmp_path / "missing.json")
    merged = tables.load_pricing_tables()
    estimator = LatencyEstimator(merged)
    estimate = estimator.estimate_image_latency("model-b")
    assert estimate.latency_per_image_s == 1.5
