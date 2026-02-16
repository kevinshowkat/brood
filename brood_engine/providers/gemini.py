"""Gemini provider."""

from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from google import genai  # type: ignore
    from google.genai import errors as genai_errors  # type: ignore
    from google.genai import types  # type: ignore
except Exception:  # pragma: no cover
    genai = None  # type: ignore
    genai_errors = None  # type: ignore
    types = None  # type: ignore

from ..runs.receipts import ImageRequest
from .base import GeneratedArtifact, ProviderResponse
from .google_utils import (
    build_image_path,
    normalize_output_format,
    nearest_gemini_ratio,
    resolve_image_size_hint,
)

GEMINI_DEBUG_DIRNAME = "_raw_provider_outputs"
GEMINI_DEBUG_ENV_FLAGS = ("BROOD_DEBUG_GEMINI_WIRE", "BROOD_DEBUG_GEMINI_REQUEST_PAYLOAD")


class GeminiProvider:
    name = "gemini"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY not set.")
        if genai is None:
            raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

        client = genai.Client(api_key=api_key)
        model = request.model or "gemini-3-pro-image-preview"
        warnings: list[str] = []

        ratio = nearest_gemini_ratio(request.size, warnings)
        provider_options = request.provider_options or {}
        image_size = None
        if provider_options.get("image_size"):
            image_size = resolve_image_size_hint(str(provider_options.get("image_size")))
        if image_size is None:
            image_size = resolve_image_size_hint(request.size)

        content_config = _build_content_config(
            request_count=max(1, int(request.n)),
            aspect_ratio=provider_options.get("aspect_ratio") or ratio,
            image_size=image_size,
            provider_options=provider_options,
        )

        output_format = normalize_output_format(request.output_format, "png")
        raw_request = {
            "model": model,
            "prompt": request.prompt,
            "config": _to_dict(content_config),
        }
        debug_manifest_path = _maybe_write_debug_request_manifest(
            request=request,
            model=model,
            content_config=raw_request["config"],
        )
        if debug_manifest_path:
            raw_request["debug_manifest_path"] = debug_manifest_path
        raw_response: dict[str, Any] = {}

        results: list[GeneratedArtifact] = []
        chat = client.chats.create(model=model)
        parts = _build_message_parts(request)
        try:
            response = chat.send_message(parts, config=content_config)
        except genai_errors.ClientError as exc:
            warnings.append("Gemini rejected config; retrying with minimal config.")
            minimal_config = types.GenerateContentConfig(
                response_modalities=["IMAGE"],
                candidate_count=1,
            )
            try:
                response = chat.send_message(parts, config=minimal_config)
            except Exception as retry_exc:
                raise RuntimeError(
                    "Gemini request failed. Ensure the model is enabled for image generation "
                    "and the API key has access to the requested model."
                ) from retry_exc

        candidates = getattr(response, "candidates", []) or []
        raw_response = {"model": model, "candidates": len(candidates)}
        usage_summary = _extract_usage_summary(response)
        if usage_summary:
            raw_response["usage"] = usage_summary
            raw_response["usage_metadata"] = usage_summary
        image_blobs = _extract_image_bytes(candidates)
        # Gemini can return multiple image parts per candidate; cap to the requested count.
        image_blobs = image_blobs[: max(1, int(request.n))]
        for idx, blob in enumerate(image_blobs):
            image_path = build_image_path(request.out_dir, idx, output_format)
            image_path.write_bytes(blob["bytes"])
            results.append(
                GeneratedArtifact(
                    image_path=image_path,
                    width=None,
                    height=None,
                    seed=request.seed,
                    metadata={"mime_type": blob.get("mime_type")},
                )
            )

        if not results:
            raise RuntimeError("Gemini returned no images.")

        return ProviderResponse(
            results=results,
            provider_request=raw_request,
            provider_response=raw_response,
            warnings=warnings,
        )


def _build_content_config(
    *,
    request_count: int,
    aspect_ratio: str | None,
    image_size: str | None,
    provider_options: Mapping[str, Any] | None,
) -> types.GenerateContentConfig:
    config_kwargs: dict[str, Any] = {
        "response_modalities": ["IMAGE"],
        "candidate_count": max(1, request_count),
    }
    image_config: dict[str, Any] = {}
    if aspect_ratio:
        image_config["aspect_ratio"] = aspect_ratio
    if image_size:
        image_config["image_size"] = image_size
    if image_config:
        config_kwargs["image_config"] = types.ImageConfig(**image_config)
    if provider_options:
        safety_settings = provider_options.get("safety_settings")
        if isinstance(safety_settings, Sequence):
            config_kwargs["safety_settings"] = list(safety_settings)
    if "safety_settings" not in config_kwargs:
        config_kwargs["safety_settings"] = [
            types.SafetySetting(
                category=category,
                threshold=types.HarmBlockThreshold.OFF,
            )
            for category in (
                types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            )
        ]
    return types.GenerateContentConfig(**config_kwargs)


def _build_message_parts(request: ImageRequest) -> list[types.Part]:
    parts: list[types.Part] = []
    if request.inputs.init_image is not None:
        parts.extend(_coerce_input_parts([request.inputs.init_image]))
    if request.inputs.reference_images:
        parts.extend(_coerce_input_parts(list(request.inputs.reference_images)))
    parts.append(types.Part(text=request.prompt))
    return parts


def _coerce_input_parts(inputs: Sequence[Any]) -> Sequence[types.Part]:
    parts: list[types.Part] = []
    for entry in inputs:
        if isinstance(entry, types.Part):
            parts.append(entry)
            continue
        if isinstance(entry, types.Image):
            parts.append(
                types.Part(
                    inline_data=types.Blob(
                        data=entry.image_bytes,
                        mime_type=entry.mime_type,
                    )
                )
            )
            continue
        if isinstance(entry, bytes):
            parts.append(types.Part(inline_data=types.Blob(data=entry)))
            continue
        if isinstance(entry, (str, Path)):
            data, mime_type = _read_input_bytes(entry)
            parts.append(types.Part(inline_data=types.Blob(data=data, mime_type=mime_type)))
    return parts


def _read_input_bytes(value: str | Path) -> tuple[bytes, str | None]:
    path = Path(value)
    data = path.read_bytes()
    mime_type = _mime_type_for_suffix(path.suffix.lower())
    return data, mime_type


def _mime_type_for_suffix(suffix: str) -> str | None:
    lowered = str(suffix or "").strip().lower()
    if lowered == ".png":
        return "image/png"
    if lowered in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if lowered == ".webp":
        return "image/webp"
    return None


def _env_flag_enabled(name: str) -> bool:
    value = str(os.getenv(name) or "").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _gemini_debug_manifest_enabled() -> bool:
    return any(_env_flag_enabled(name) for name in GEMINI_DEBUG_ENV_FLAGS)


def _describe_path_input(
    *,
    value: str | Path,
    role: str,
    part_index: int,
    source_index: int,
) -> dict[str, Any]:
    path = Path(value).expanduser()
    payload: dict[str, Any] = {
        "part_type": "image",
        "role": role,
        "part_index": part_index,
        "source_index": source_index,
        "source_type": "path",
        "path": str(path),
        "mime_type": _mime_type_for_suffix(path.suffix.lower()),
    }
    try:
        resolved_path = str(path.resolve())
    except Exception:
        resolved_path = str(path)
    payload["resolved_path"] = resolved_path
    if not path.exists():
        payload["missing"] = True
        return payload
    try:
        data = path.read_bytes()
    except Exception as exc:
        payload["read_error"] = str(exc)
        return payload
    payload["byte_count"] = len(data)
    payload["sha256"] = hashlib.sha256(data).hexdigest()
    return payload


def _describe_non_path_input(
    *,
    value: Any,
    role: str,
    part_index: int,
    source_index: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "part_type": "image",
        "role": role,
        "part_index": part_index,
        "source_index": source_index,
    }
    if isinstance(value, (bytes, bytearray)):
        data = bytes(value)
        payload.update(
            {
                "source_type": "bytes",
                "byte_count": len(data),
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
        return payload
    payload["source_type"] = type(value).__name__
    return payload


def _describe_input_parts(request: ImageRequest) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    part_index = 0
    if request.inputs.init_image is not None:
        init_value = request.inputs.init_image
        if isinstance(init_value, (str, Path)):
            entries.append(
                _describe_path_input(
                    value=init_value,
                    role="init_image",
                    part_index=part_index,
                    source_index=0,
                )
            )
        else:
            entries.append(
                _describe_non_path_input(
                    value=init_value,
                    role="init_image",
                    part_index=part_index,
                    source_index=0,
                )
            )
        part_index += 1
    for source_index, ref_value in enumerate(request.inputs.reference_images):
        if isinstance(ref_value, (str, Path)):
            entries.append(
                _describe_path_input(
                    value=ref_value,
                    role="reference_image",
                    part_index=part_index,
                    source_index=source_index,
                )
            )
        else:
            entries.append(
                _describe_non_path_input(
                    value=ref_value,
                    role="reference_image",
                    part_index=part_index,
                    source_index=source_index,
                )
            )
        part_index += 1
    entries.append(
        {
            "part_type": "text",
            "role": "prompt",
            "part_index": part_index,
            "text_chars": len(str(request.prompt or "")),
            "text_preview": str(request.prompt or ""),
        }
    )
    return entries


def _build_debug_request_manifest(
    *,
    request: ImageRequest,
    model: str,
    content_config: Mapping[str, Any] | Sequence[Any] | Any,
) -> dict[str, Any]:
    out_dir = str(request.out_dir or "").strip()
    return {
        "schema": "brood.gemini.send_message.debug.v1",
        "ts_utc": datetime.now(timezone.utc).isoformat(),
        "provider": "gemini",
        "model": model,
        "out_dir": out_dir or None,
        "prompt": str(request.prompt or ""),
        "send_message": {
            "method": "chat.send_message",
            "config": _to_dict(content_config),
            "parts": _describe_input_parts(request),
        },
    }


def _maybe_write_debug_request_manifest(
    *,
    request: ImageRequest,
    model: str,
    content_config: Mapping[str, Any] | Sequence[Any] | Any,
) -> str | None:
    if not _gemini_debug_manifest_enabled():
        return None
    out_dir_raw = str(request.out_dir or "").strip()
    if not out_dir_raw:
        return None
    out_dir = Path(out_dir_raw).expanduser()
    payload = _build_debug_request_manifest(
        request=request,
        model=model,
        content_config=content_config,
    )
    try:
        raw_dir = out_dir / GEMINI_DEBUG_DIRNAME
        raw_dir.mkdir(parents=True, exist_ok=True)
        stamp = int(time.time() * 1000)
        suffix = uuid.uuid4().hex[:8]
        output_path = raw_dir / f"gemini-send-message-{stamp}-{suffix}.json"
        output_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    except Exception:
        return None
    return str(output_path)


def _extract_image_bytes(candidates: Sequence[Any]) -> list[dict[str, Any]]:
    blobs: list[dict[str, Any]] = []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            inline_data = getattr(part, "inline_data", None)
            data = getattr(inline_data, "data", None) if inline_data else None
            if data is None:
                continue
            mime_type = getattr(inline_data, "mime_type", None)
            if isinstance(data, str):
                data = data.encode("latin1")
            if isinstance(data, (bytes, bytearray)):
                blobs.append({"bytes": bytes(data), "mime_type": mime_type})
    return blobs


def _to_dict(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(k): _to_dict(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_dict(v) for v in value]
    if hasattr(value, "model_dump"):
        try:
            return _to_dict(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {str(k): _to_dict(v) for k, v in value.__dict__.items() if not str(k).startswith("_")}
    return str(value)


def _extract_usage_summary(response: Any) -> Mapping[str, Any] | None:
    if response is None:
        return None
    for key in ("usage_metadata", "usage", "usageMetadata"):
        if isinstance(response, Mapping):
            raw = response.get(key)
        else:
            raw = getattr(response, key, None)
        mapped = _to_dict(raw)
        if isinstance(mapped, Mapping):
            return dict(mapped)
    mapped_response = _to_dict(response)
    if isinstance(mapped_response, Mapping):
        for key in ("usage_metadata", "usage", "usageMetadata"):
            nested = mapped_response.get(key)
            if isinstance(nested, Mapping):
                return dict(nested)
    return None
