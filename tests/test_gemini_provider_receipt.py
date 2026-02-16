from __future__ import annotations

import json
from pathlib import Path

from brood_engine.engine import BroodEngine
from brood_engine.providers.base import GeneratedArtifact, ProviderRegistry, ProviderResponse


class _FakeGeminiProvider:
    name = "gemini"

    def generate(self, request):
        out_dir = Path(str(request.out_dir))
        image_path = out_dir / "artifact-fake-00.png"
        image_path.write_bytes(b"fake-image-bytes")
        metadata = dict(request.metadata) if isinstance(request.metadata, dict) else {}
        return ProviderResponse(
            results=[GeneratedArtifact(image_path=image_path, width=1024, height=1024, seed=123)],
            provider_request={
                "model": request.model or "gemini-3-pro-image-preview",
                "prompt": request.prompt,
                "config": {"response_modalities": ["IMAGE"], "candidate_count": 1},
                "metadata": metadata,
            },
            provider_response={"model": request.model or "gemini-3-pro-image-preview", "candidates": 1},
            warnings=[],
        )


def test_engine_writes_gemini_provider_receipt_copy(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    registry = ProviderRegistry([_FakeGeminiProvider()])
    engine = BroodEngine(
        run_dir=run_dir,
        events_path=events_path,
        text_model="dryrun-text-1",
        image_model="gemini-3-pro-image-preview",
        provider_registry=registry,
    )

    artifacts = engine.generate("mother prompt", {"size": "1024x1024", "n": 1}, {"action": "mother_generate"})
    assert artifacts

    receipt_path = Path(str(artifacts[0]["receipt_path"]))
    receipt_payload = json.loads(receipt_path.read_text(encoding="utf-8"))
    copied_paths = sorted((run_dir / "_raw_provider_outputs").glob("gemini-receipt-*.json"))
    assert len(copied_paths) == 1
    copied_payload = json.loads(copied_paths[0].read_text(encoding="utf-8"))

    assert copied_payload["schema_version"] == 1
    assert copied_payload["provider_request"]["model"] == "gemini-3-pro-image-preview"
    assert copied_payload == receipt_payload
    assert receipt_payload["result_metadata"]["gemini_receipt_path"] == str(copied_paths[0])


def test_engine_does_not_write_gemini_provider_receipt_for_non_gemini(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model="dryrun-text-1", image_model="dryrun-image-1")
    engine.generate("boat", {"size": "1024x1024", "n": 1}, {"action": "generate"})

    copied_paths = list((run_dir / "_raw_provider_outputs").glob("gemini-receipt-*.json"))
    assert copied_paths == []


def test_engine_forwards_gemini_context_packet_into_request_metadata(tmp_path: Path) -> None:
    run_dir = tmp_path / "run"
    events_path = run_dir / "events.jsonl"
    registry = ProviderRegistry([_FakeGeminiProvider()])
    engine = BroodEngine(
        run_dir=run_dir,
        events_path=events_path,
        text_model="dryrun-text-1",
        image_model="gemini-3-pro-image-preview",
        provider_registry=registry,
    )
    packet = {
        "schema": "brood.gemini.context_packet.v1",
        "proposal_lock": {"transformation_mode": "hybridize", "selected_ids": ["img_a"]},
    }

    artifacts = engine.generate(
        "mother prompt",
        {"size": "1024x1024", "n": 1},
        {"action": "mother_generate", "gemini_context_packet": packet},
    )
    assert artifacts
    receipt_path = Path(str(artifacts[0]["receipt_path"]))
    payload = json.loads(receipt_path.read_text(encoding="utf-8"))
    metadata = payload["provider_request"]["metadata"]
    assert metadata["gemini_context_packet"] == packet
