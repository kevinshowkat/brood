from pathlib import Path

from brood_engine.providers.openai import (
    _build_images_edit_payload,
    _build_images_payload,
    _build_responses_payload,
)
from brood_engine.runs.receipts import ImageInputs, ImageRequest


def test_openai_images_payload_omits_seed_by_default() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        seed=12345,
        provider_options={},
    )
    payload = _build_images_payload(request)
    assert "seed" not in payload


def test_openai_images_payload_includes_seed_when_explicitly_enabled() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        seed=12345,
        provider_options={"openai_allow_seed": True, "quality": "high"},
    )
    payload = _build_images_payload(request)
    assert payload.get("seed") == 12345
    assert payload.get("quality") == "high"
    assert "openai_allow_seed" not in payload


def test_openai_responses_payload_omits_seed_by_default() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        seed=12345,
        provider_options={},
    )
    payload = _build_responses_payload(request)
    tools = payload.get("tools")
    assert isinstance(tools, list) and tools
    tool = tools[0]
    assert isinstance(tool, dict)
    assert "seed" not in tool


def test_openai_payload_normalizes_size_and_quality() -> None:
    warnings: list[str] = []
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        size="512x512",
        provider_options={"quality": "hd"},
    )
    payload = _build_images_payload(request, warnings=warnings)
    assert payload.get("size") == "1024x1024"
    assert payload.get("quality") == "high"
    assert any("OpenAI size snapped to 1024x1024." in warning for warning in warnings)


def test_openai_payload_drops_unknown_provider_options() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        provider_options={
            "quality": "high",
            "aspect_ratio": "16:9",
            "image_size": "2K",
            "responses_model": "gpt-4.1-mini",
        },
    )
    payload = _build_images_payload(request)
    assert payload.get("quality") == "high"
    assert "aspect_ratio" not in payload
    assert "image_size" not in payload
    assert "responses_model" not in payload


def test_openai_responses_payload_normalizes_mime_output_format() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        output_format="image/jpeg",
    )
    payload = _build_responses_payload(request)
    tools = payload.get("tools")
    assert isinstance(tools, list) and tools
    tool = tools[0]
    assert isinstance(tool, dict)
    assert tool.get("format") == "jpeg"


def test_openai_edit_payload_includes_all_reference_images_and_input_fidelity(tmp_path: Path) -> None:
    init_path = tmp_path / "init.png"
    ref_path = tmp_path / "reference.webp"
    init_path.write_bytes(b"init")
    ref_path.write_bytes(b"ref")

    request = ImageRequest(
        prompt="blend",
        model="gpt-image-1.5",
        provider_options={"input_fidelity": "high"},
        inputs=ImageInputs(
            init_image=str(init_path),
            reference_images=[str(ref_path)],
        ),
    )

    fields, files, payload = _build_images_edit_payload(request)
    assert ("input_fidelity", "high") in fields
    assert [item[0] for item in files].count("image[]") == 2
    assert payload.get("input_fidelity") == "high"


def test_openai_images_payload_defaults_moderation_low_for_gpt_image() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
    )
    payload = _build_images_payload(request)
    assert payload.get("moderation") == "low"


def test_openai_images_payload_respects_explicit_moderation() -> None:
    request = ImageRequest(
        prompt="test prompt",
        model="gpt-image-1.5",
        provider_options={"moderation": "auto"},
    )
    payload = _build_images_payload(request)
    assert payload.get("moderation") == "auto"
