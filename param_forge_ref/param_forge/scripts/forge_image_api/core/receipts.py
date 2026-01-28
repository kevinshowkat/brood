"""Receipt writer for PARAM FORGE artifacts."""

from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from pathlib import Path
from typing import Any, Mapping, MutableMapping

from .contracts import ImageRequest, ResolvedRequest


_MAX_INLINE_BYTES = 2000
_RECEIPT_SCHEMA_VERSION = 1


def _serialize(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if is_dataclass(value):
        return {k: _serialize(v) for k, v in asdict(value).items()}
    if isinstance(value, Mapping):
        return {str(k): _serialize(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_serialize(item) for item in value]
    return str(value)


def _sanitize_payload(payload: Any) -> Any:
    if payload is None:
        return None
    if isinstance(payload, (str, int, float, bool)):
        return payload
    if isinstance(payload, bytes):
        return f"<bytes:{len(payload)}>"
    if isinstance(payload, Mapping):
        sanitized: MutableMapping[str, Any] = {}
        for key, value in payload.items():
            lowered = str(key).lower()
            if lowered in {"b64_json", "image", "image_bytes", "data"}:
                sanitized[str(key)] = "<omitted>"
                continue
            sanitized[str(key)] = _sanitize_payload(value)
        return sanitized
    if isinstance(payload, (list, tuple)):
        return [_sanitize_payload(item) for item in payload]
    return str(payload)


def build_receipt(
    *,
    request: ImageRequest,
    resolved: ResolvedRequest,
    provider_request: Mapping[str, Any],
    provider_response: Mapping[str, Any],
    warnings: list[str],
    image_path: Path,
    receipt_path: Path,
    result_metadata: Mapping[str, Any],
) -> dict[str, Any]:
    return {
        "schema_version": _RECEIPT_SCHEMA_VERSION,
        "request": _serialize(request),
        "resolved": _serialize(resolved),
        "provider_request": _sanitize_payload(provider_request),
        "provider_response": _sanitize_payload(provider_response),
        "warnings": warnings,
        "artifacts": {
            "image_path": str(image_path),
            "receipt_path": str(receipt_path),
        },
        "result_metadata": _sanitize_payload(result_metadata),
    }


def write_receipt(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
