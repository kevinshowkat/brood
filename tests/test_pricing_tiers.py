from __future__ import annotations

from brood_engine.pricing.estimator import PricingEstimator


def test_pricing_tier_by_provider_options() -> None:
    tables = {
        "model-a": {
            "cost_per_image_usd": 0.02,
            "cost_multipliers_by_image_size": {"1K": 0.5, "2K": 1.0, "4K": 2.0},
        }
    }
    est = PricingEstimator(tables)
    base = est.estimate_image_cost("model-a")
    assert base.cost_per_image_usd == 0.02

    tiered = est.estimate_image_cost_with_params("model-a", provider_options={"image_size": "4K"})
    assert tiered.cost_per_image_usd == 0.04


def test_pricing_tier_inferred_from_large_dims() -> None:
    tables = {"model-a": {"cost_per_image_usd": 0.02, "cost_multipliers_by_image_size": {"4K": 2.0}}}
    est = PricingEstimator(tables)
    tiered = est.estimate_image_cost_with_params("model-a", size="4096x4096")
    assert tiered.cost_per_image_usd == 0.04


def test_pricing_does_not_infer_1k_from_small_dims() -> None:
    tables = {"model-a": {"cost_per_image_usd": 0.02, "cost_multipliers_by_image_size": {"1K": 0.5}}}
    est = PricingEstimator(tables)
    tiered = est.estimate_image_cost_with_params("model-a", size="1024x1024")
    assert tiered.cost_per_image_usd == 0.02

