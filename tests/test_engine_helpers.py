from __future__ import annotations

import json
from pathlib import Path

import pytest

from brood_engine.engine import BroodEngine
from brood_engine.runs.thread_manifest import ThreadManifest


def _make_engine(tmp_path: Path, image_model: str) -> BroodEngine:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    return BroodEngine(
        run_dir,
        events_path,
        text_model="dryrun-text-1",
        image_model=image_model,
    )


def test_apply_quality_preset_maps_fast_to_low_for_openai_provider(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path, image_model="gpt-image-1")
    model = engine.model_selector.select("gpt-image-1", "image").model
    updated = engine._apply_quality_preset({"quality_preset": "fast"}, model)

    assert updated["provider_options"]["quality"] == "low"


def test_apply_quality_preset_does_not_set_provider_options_for_non_openai(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path, image_model="dryrun-image-1")
    model = engine.model_selector.select("dryrun-image-1", "image").model
    updated = engine._apply_quality_preset({"quality_preset": "fast"}, model)

    assert "provider_options" not in updated
    assert updated["quality_preset"] == "fast"


def test_apply_recommendations_skips_unsupported_openai_size(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path, image_model="gpt-image-1")
    updated, updated_prompt, summary, skipped = engine.apply_recommendations(
        {"size": "1024x1024"},
        [{"setting_name": "size", "setting_value": "256x256", "setting_target": "request"}],
    )

    assert updated["size"] == "1024x1024"
    assert updated_prompt is None
    assert summary == []
    assert "size=256x256 (unsupported)" in skipped


def test_apply_recommendations_updates_model_prompt_and_provider_options(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path, image_model="gpt-image-1")
    updated, updated_prompt, summary, skipped = engine.apply_recommendations(
        {"size": "1024x1024", "provider_options": {"seed": 123}},
        [
            {"setting_name": "model", "setting_value": "gpt-image-1-mini", "setting_target": "request"},
            {"setting_name": "size", "setting_value": "1536x1024", "setting_target": "request"},
            {"setting_name": "prompt", "setting_value": "A warmer sunrise", "setting_target": "request"},
            {"setting_name": "quality", "setting_value": "hd", "setting_target": "provider_options"},
        ],
        prompt="A cool sunrise",
    )

    assert engine.image_model == "gpt-image-1-mini"
    assert updated["size"] == "1536x1024"
    assert updated["provider_options"]["quality"] == "high"
    assert updated_prompt == "A warmer sunrise"
    assert "model=gpt-image-1-mini" in summary
    assert "size=1536x1024" in summary
    assert "provider_options.quality=high" in summary
    assert skipped == []


def test_analyze_last_receipt_stores_goals_and_emits_event(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_BACKUP", raising=False)
    engine = _make_engine(tmp_path, image_model="dryrun-image-1")
    engine.generate("boat at dawn", {"size": "1024x1024", "n": 1}, {"action": "generate"})
    result = engine.analyze_last_receipt(
        goals=["maximize quality of render"],
        mode="review",
        round_idx=1,
        round_total=2,
    )

    assert result is not None
    assert result["analysis_excerpt"] is not None
    assert result["mode"] == "review"
    assert result["analysis_model"] == "dryrun-text-1"

    events = [
        json.loads(line)
        for line in (engine.events.path.read_text(encoding="utf-8").splitlines())
    ]
    assert any(event["type"] == "analysis_ready" for event in events)

    manifest = ThreadManifest.load(engine.thread_path)
    assert manifest.versions[-1].intent["goals"] == ["maximize quality of render"]


def test_analyze_last_receipt_returns_none_before_any_generation(tmp_path: Path) -> None:
    engine = _make_engine(tmp_path, image_model="dryrun-image-1")
    assert engine.analyze_last_receipt(goals=["maximize quality of render"]) is None
