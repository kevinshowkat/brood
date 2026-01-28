"""Gemini provider."""

from __future__ import annotations

import os
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


class GeminiProvider:
    name = "gemini"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY not set.")
        if genai is None:
            raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

        client = genai.Client(api_key=api_key)
        model = request.model or "gemini-2.5-flash-image"
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
        image_blobs = _extract_image_bytes(candidates)
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
    suffix = path.suffix.lower()
    mime_type = None
    if suffix == ".png":
        mime_type = "image/png"
    elif suffix in {".jpg", ".jpeg"}:
        mime_type = "image/jpeg"
    elif suffix == ".webp":
        mime_type = "image/webp"
    return data, mime_type


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
