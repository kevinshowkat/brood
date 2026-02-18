from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from brood_engine.providers.openai import OpenAIProvider
from brood_engine.runs.receipts import ImageInputs, ImageRequest


class DummyResponse:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status = status

    def read(self) -> bytes:
        return json.dumps(self._payload).encode("utf-8")

    def __enter__(self) -> "DummyResponse":
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        return False


def test_openai_provider_generates_images(tmp_path: Path, monkeypatch) -> None:
    blob = base64.b64encode(b"fake-image-bytes").decode("utf-8")
    payload = {
        "created": 123,
        "data": [
            {"b64_json": blob},
            {"b64_json": blob},
        ],
    }

    def fake_urlopen(req, timeout=0):
        return DummyResponse(payload)

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_IMAGE_USE_RESPONSES", raising=False)
    monkeypatch.delenv("OPENAI_IMAGE_STREAM", raising=False)
    monkeypatch.setattr("brood_engine.providers.openai.urlopen", fake_urlopen)

    provider = OpenAIProvider()
    request = ImageRequest(
        prompt="A sunny beach",
        size="512x512",
        n=2,
        output_format="png",
        out_dir=str(tmp_path),
        model="gpt-image-1",
    )
    response = provider.generate(request)

    assert any("OpenAI size snapped to 1024x1024." in warning for warning in response.warnings)
    assert response.provider_response.get("data_count") == 2
    assert len(response.results) == 2

    saved = sorted(tmp_path.glob("artifact-*.png"))
    assert len(saved) == 2
    assert response.results[0].width == 1024
    assert response.results[0].height == 1024
    assert saved[0].read_bytes() == b"fake-image-bytes"


def test_openai_provider_requires_api_key(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY_BACKUP", raising=False)
    monkeypatch.delenv("OPENAI_IMAGE_USE_RESPONSES", raising=False)
    monkeypatch.delenv("OPENAI_IMAGE_STREAM", raising=False)

    provider = OpenAIProvider()
    request = ImageRequest(prompt="A cat", out_dir=str(tmp_path), model="gpt-image-1")
    with pytest.raises(RuntimeError, match="OpenAI API key missing"):
        provider.generate(request)


def test_openai_provider_uses_normalized_extension_for_mime_output_format(
    tmp_path: Path, monkeypatch
) -> None:
    blob = base64.b64encode(b"fake-image-bytes").decode("utf-8")
    payload = {"created": 123, "data": [{"b64_json": blob}]}

    def fake_urlopen(req, timeout=0):
        return DummyResponse(payload)

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_IMAGE_USE_RESPONSES", raising=False)
    monkeypatch.delenv("OPENAI_IMAGE_STREAM", raising=False)
    monkeypatch.setattr("brood_engine.providers.openai.urlopen", fake_urlopen)

    provider = OpenAIProvider()
    request = ImageRequest(
        prompt="A studio portrait",
        size="1024x1024",
        n=1,
        output_format="image/jpeg",
        out_dir=str(tmp_path),
        model="gpt-image-1.5",
    )
    response = provider.generate(request)

    assert len(response.results) == 1
    saved = sorted(tmp_path.glob("artifact-*.jpg"))
    assert len(saved) == 1
    assert saved[0].read_bytes() == b"fake-image-bytes"


def test_openai_responses_provider_uses_normalized_extension_for_mime_output_format(
    tmp_path: Path, monkeypatch
) -> None:
    blob = base64.b64encode(b"fake-response-image").decode("utf-8")
    responses_payload = {
        "id": "resp_123",
        "output": [
            {
                "type": "image_generation_call",
                "result": blob,
            }
        ],
    }

    def fake_urlopen(req, timeout=0):
        return DummyResponse(responses_payload)

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_IMAGE_USE_RESPONSES", "1")
    monkeypatch.delenv("OPENAI_IMAGE_STREAM", raising=False)
    monkeypatch.setattr("brood_engine.providers.openai.urlopen", fake_urlopen)

    provider = OpenAIProvider()
    request = ImageRequest(
        prompt="A cinematic landscape",
        size="1024x1024",
        n=1,
        output_format="image/webp",
        out_dir=str(tmp_path),
        model="gpt-image-1.5",
    )
    response = provider.generate(request)

    assert len(response.results) == 1
    saved = sorted(tmp_path.glob("artifact-*.webp"))
    assert len(saved) == 1
    assert saved[0].read_bytes() == b"fake-response-image"


def test_openai_provider_uses_edits_endpoint_for_reference_inputs(tmp_path: Path, monkeypatch) -> None:
    blob = base64.b64encode(b"edited-image-bytes").decode("utf-8")
    payload = {"created": 123, "data": [{"b64_json": blob}]}
    captured: dict[str, object] = {}

    init_path = tmp_path / "init.png"
    ref_path = tmp_path / "ref.jpg"
    init_path.write_bytes(b"init-image")
    ref_path.write_bytes(b"reference-image")

    def fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        captured["content_type"] = req.headers.get("Content-type")
        captured["body"] = req.data
        return DummyResponse(payload)

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_IMAGE_USE_RESPONSES", "1")
    monkeypatch.delenv("OPENAI_IMAGE_STREAM", raising=False)
    monkeypatch.setattr("brood_engine.providers.openai.urlopen", fake_urlopen)

    provider = OpenAIProvider()
    request = ImageRequest(
        prompt="Blend these references",
        size="1024x1024",
        n=1,
        output_format="png",
        out_dir=str(tmp_path),
        model="gpt-image-1.5",
        provider_options={"input_fidelity": "high"},
        inputs=ImageInputs(
            init_image=str(init_path),
            reference_images=[str(ref_path)],
        ),
    )
    response = provider.generate(request)

    assert len(response.results) == 1
    assert str(captured.get("url", "")).endswith("/images/edits")
    assert str(captured.get("content_type", "")).startswith("multipart/form-data; boundary=")
    body = captured.get("body")
    assert isinstance(body, (bytes, bytearray))
    assert body.count(b'name="image[]"') == 2
    assert b'name="input_fidelity"' in body
    assert b"high" in body
    payload_manifest = response.provider_request.get("payload")
    assert isinstance(payload_manifest, dict)
    files = payload_manifest.get("files")
    assert isinstance(files, list)
    assert len([entry for entry in files if entry.get("field") == "image[]"]) == 2
    assert any(
        "responses mode does not support multipart image edits" in warning
        for warning in response.warnings
    )
