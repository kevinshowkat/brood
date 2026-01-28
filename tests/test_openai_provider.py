from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest

from brood_engine.providers.openai import OpenAIProvider
from brood_engine.runs.receipts import ImageRequest


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

    assert response.warnings == []
    assert response.provider_response.get("data_count") == 2
    assert len(response.results) == 2

    saved = sorted(tmp_path.glob("artifact-*.png"))
    assert len(saved) == 2
    assert response.results[0].width == 512
    assert response.results[0].height == 512
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
