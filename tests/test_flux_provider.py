from __future__ import annotations

import base64
from pathlib import Path

from brood_engine.models.registry import ModelRegistry
from brood_engine.providers.flux import FluxProvider
from brood_engine.runs.receipts import ImageInputs, ImageRequest


def test_model_registry_includes_flux_2_max() -> None:
    registry = ModelRegistry()
    model = registry.get("flux-2-max")
    assert model is not None
    assert model.provider == "flux"
    assert "image" in model.capabilities


def test_flux_provider_sends_uploaded_inputs_as_input_images(tmp_path: Path, monkeypatch) -> None:
    init_path = tmp_path / "init.png"
    ref_path = tmp_path / "ref.jpg"
    init_bytes = b"init-image-bytes"
    ref_bytes = b"ref-image-bytes"
    init_path.write_bytes(init_bytes)
    ref_path.write_bytes(ref_bytes)

    captured_payloads: list[dict[str, object]] = []

    def fake_generate_one(
        *,
        endpoint_url,
        payload,
        headers,
        poll_interval,
        poll_timeout,
        request_timeout,
        download_timeout,
    ):
        captured_payloads.append(dict(payload))
        return {
            "image_bytes": b"fake-flux-output",
            "request_id": "flux_req_123",
            "result_payload": {"status": "ready", "result": {"sample": "https://example.test/sample.jpg"}},
        }

    monkeypatch.setenv("BFL_API_KEY", "test-key")
    monkeypatch.setattr("brood_engine.providers.flux._generate_one", fake_generate_one)

    provider = FluxProvider()
    request = ImageRequest(
        prompt="Fuse two references",
        size="1024x1024",
        n=1,
        out_dir=str(tmp_path),
        model="flux-2-max",
        inputs=ImageInputs(
            init_image=str(init_path),
            reference_images=[str(ref_path)],
        ),
    )
    response = provider.generate(request)

    assert len(response.results) == 1
    assert captured_payloads
    payload = captured_payloads[0]
    assert response.provider_request.get("endpoint", "").endswith("/flux-2-max")
    assert "input_image" in payload
    assert "input_image_2" in payload
    assert base64.b64decode(str(payload["input_image"])) == init_bytes
    assert base64.b64decode(str(payload["input_image_2"])) == ref_bytes

    provider_payload = response.provider_request.get("payload")
    assert isinstance(provider_payload, dict)
    input_images = provider_payload.get("input_images")
    assert isinstance(input_images, list)
    assert len(input_images) == 2
    assert input_images[0].get("key") == "input_image"
    assert input_images[1].get("key") == "input_image_2"
