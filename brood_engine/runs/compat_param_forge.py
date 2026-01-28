"""Compatibility reader for Param Forge run directories."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from ..utils import read_json


def load_param_forge_run(run_dir: Path) -> dict[str, Any]:
    receipts = sorted(run_dir.glob("receipt-*.json"))
    versions: list[dict[str, Any]] = []
    for idx, receipt_path in enumerate(receipts, start=1):
        receipt = read_json(receipt_path, {})
        if not isinstance(receipt, dict):
            continue
        request = receipt.get("request", {}) if isinstance(receipt.get("request"), dict) else {}
        resolved = receipt.get("resolved", {}) if isinstance(receipt.get("resolved"), dict) else {}
        artifacts = receipt.get("artifacts", {}) if isinstance(receipt.get("artifacts"), dict) else {}
        image_path = artifacts.get("image_path")
        if not image_path:
            image_path = receipt_path.with_suffix(".png")
        version_id = f"v{idx}"
        versions.append(
            {
                "version_id": version_id,
                "parent_version_id": None,
                "intent": {"source": "param_forge"},
                "settings": {
                    "provider": resolved.get("provider"),
                    "model": resolved.get("model"),
                    "size": resolved.get("size"),
                    "output_format": resolved.get("output_format"),
                    "provider_params": resolved.get("provider_params"),
                },
                "prompt": request.get("prompt", ""),
                "prompt_diff": None,
                "settings_diff": None,
                "artifacts": [
                    {
                        "artifact_id": receipt_path.stem,
                        "image_path": str(image_path),
                        "receipt_path": str(receipt_path),
                    }
                ],
                "selected_artifact_id": None,
                "feedback": [],
            }
        )
    return {
        "schema_version": 1,
        "thread_id": str(uuid.uuid4()),
        "created_at": None,
        "versions": versions,
        "context_summary": {"text": "", "updated_at": None},
    }
