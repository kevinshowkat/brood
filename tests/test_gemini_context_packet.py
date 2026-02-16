from __future__ import annotations

import json
from types import SimpleNamespace

from brood_engine.providers import gemini as gemini_provider
from brood_engine.runs.receipts import ImageInputs, ImageRequest


class _FakePart:
    def __init__(self, text=None, inline_data=None):
        self.text = text
        self.inline_data = inline_data


def test_build_message_parts_includes_context_packet_before_prompt(monkeypatch) -> None:
    monkeypatch.setattr(
        gemini_provider,
        "types",
        SimpleNamespace(
            Part=_FakePart,
            Image=type("Image", (), {}),
            Blob=type("Blob", (), {}),
        ),
    )
    request = ImageRequest(
        prompt="Draw a fused scene.",
        inputs=ImageInputs(),
        metadata={
            "gemini_context_packet": {
                "schema": "brood.gemini.context_packet.v1",
                "proposal_lock": {"transformation_mode": "hybridize", "selected_ids": ["img_a", "img_b"]},
            }
        },
    )

    parts = gemini_provider._build_message_parts(request)
    assert len(parts) == 2
    assert parts[1].text == "Draw a fused scene."
    assert isinstance(parts[0].text, str) and parts[0].text.startswith("BROOD_CONTEXT_PACKET_JSON:\n")
    context_json = parts[0].text.split("\n", 1)[1]
    parsed = json.loads(context_json)
    assert parsed["schema"] == "brood.gemini.context_packet.v1"
    assert parsed["proposal_lock"]["selected_ids"] == ["img_a", "img_b"]


def test_debug_manifest_includes_context_packet_part() -> None:
    request = ImageRequest(
        prompt="Prompt text",
        inputs=ImageInputs(),
        metadata={
            "gemini_context_packet": {
                "schema": "brood.gemini.context_packet.v1",
                "proposal_lock": {"transformation_mode": "hybridize"},
            }
        },
    )
    manifest = gemini_provider._build_debug_request_manifest(
        request=request,
        model="gemini-3-pro-image-preview",
        content_config={"response_modalities": ["IMAGE"]},
    )
    parts = manifest["send_message"]["parts"]
    assert parts[0]["role"] == "context_packet"
    assert parts[1]["role"] == "prompt"
    assert parts[0]["packet"]["schema"] == "brood.gemini.context_packet.v1"
