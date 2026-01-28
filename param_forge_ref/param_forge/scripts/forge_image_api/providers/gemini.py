"""Gemini image adapter."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Sequence

try:
    from google import genai  # type: ignore
    from google.genai import errors as genai_errors  # type: ignore
    from google.genai import types  # type: ignore
except Exception:  # pragma: no cover
    genai = None  # type: ignore
    genai_errors = None  # type: ignore
    types = None  # type: ignore

from forge_image_api.core.contracts import ImageRequest, ResolvedRequest
from forge_image_api.core.utils import read_input_bytes
from .base import ProviderAdapter, ProviderImage, ProviderResponse, ProviderStreamEvent


_DEFAULT_MODEL = "gemini-2.5-flash-image"

_GENAI_CLIENT: Optional[genai.Client] = None


def _client() -> genai.Client:
    global _GENAI_CLIENT
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY or GOOGLE_API_KEY not set.")
    if genai is None:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")
    if _GENAI_CLIENT is None:
        _GENAI_CLIENT = genai.Client(api_key=api_key)
    return _GENAI_CLIENT


def _mime_to_suffix(mime_type: str | None, fallback: str) -> str:
    if mime_type:
        if mime_type == "image/png":
            return "png"
        if mime_type == "image/jpeg":
            return "jpg"
        if mime_type == "image/webp":
            return "webp"
        if "/" in mime_type:
            return mime_type.split("/", 1)[1]
    if fallback == "jpeg":
        return "jpg"
    return fallback


def _coerce_input_parts(inputs: Sequence[Any]) -> Sequence[types.Part]:
    parts: List[types.Part] = []
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
            data, path_str = read_input_bytes(entry)
            mime_type = None
            if path_str:
                suffix = Path(path_str).suffix.lower()
                if suffix == ".png":
                    mime_type = "image/png"
                elif suffix in {".jpg", ".jpeg"}:
                    mime_type = "image/jpeg"
                elif suffix == ".webp":
                    mime_type = "image/webp"
            parts.append(types.Part(inline_data=types.Blob(data=data, mime_type=mime_type)))
    return parts


def _build_content_config(
    *,
    request_count: int,
    aspect_ratio: Optional[str],
    image_size: Optional[str],
    provider_options: Mapping[str, Any] | None,
) -> types.GenerateContentConfig:
    config_kwargs: Dict[str, Any] = {
        "response_modalities": ["IMAGE"],
        "candidate_count": max(1, request_count),
    }

    default_safety_settings = [
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

    image_config_kwargs: Dict[str, Any] = {}
    if aspect_ratio:
        image_config_kwargs["aspect_ratio"] = aspect_ratio
    if image_size:
        image_config_kwargs["image_size"] = image_size
    if image_config_kwargs:
        config_kwargs["image_config"] = types.ImageConfig(**image_config_kwargs)

    if provider_options:
        safety_settings = provider_options.get("safety_settings")
        if isinstance(safety_settings, Sequence):
            config_kwargs["safety_settings"] = list(safety_settings)

    if "safety_settings" not in config_kwargs:
        config_kwargs["safety_settings"] = default_safety_settings

    return types.GenerateContentConfig(**config_kwargs)


def _extract_status_code(exc: Exception) -> Optional[int]:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int):
        return status
    code = getattr(exc, "code", None)
    if isinstance(code, int):
        return code
    text = str(exc)
    for token in text.split():
        if token.isdigit():
            try:
                return int(token)
            except ValueError:
                continue
    return None


class GeminiAdapter:
    name = "gemini"

    def generate(self, request: ImageRequest, resolved: ResolvedRequest) -> ProviderResponse:
        client = _client()
        model = resolved.model or _DEFAULT_MODEL
        output_format = resolved.output_format
        warnings: List[str] = list(resolved.warnings or [])

        aspect_ratio = resolved.provider_params.get("aspect_ratio")
        image_size = resolved.provider_params.get("image_size")
        content_config = _build_content_config(
            request_count=1,
            aspect_ratio=aspect_ratio,
            image_size=image_size,
            provider_options=request.provider_options,
        )

        images: List[ProviderImage] = []
        usage_payload: Optional[Mapping[str, Any]] = None
        raw_request = {
            "model": model,
            "prompt": resolved.prompt,
            "config": content_config.model_dump() if hasattr(content_config, "model_dump") else {},
        }
        raw_response: Dict[str, Any] = {}

        chat = client.chats.create(model=model)
        for _ in range(max(1, resolved.n)):
            message_parts: List[types.Part] = []
            if request.inputs.init_image is not None:
                message_parts.extend(_coerce_input_parts([request.inputs.init_image]))
            if request.inputs.reference_images:
                message_parts.extend(_coerce_input_parts(list(request.inputs.reference_images)))
            message_parts.append(types.Part(text=resolved.prompt))
            try:
                response = chat.send_message(message_parts, config=content_config)
            except genai_errors.ClientError as exc:
                status = _extract_status_code(exc)
                warnings.append(
                    "Gemini rejected the initial config; retrying with minimal config."
                )
                minimal_config = types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                    candidate_count=1,
                )
                try:
                    response = chat.send_message(message_parts, config=minimal_config)
                except Exception as retry_exc:
                    raise RuntimeError(
                        "Gemini request failed. This usually means the project/model "
                        "is not enabled for image generation or the model ID is not valid. "
                        "Try a model like 'gemini-2.5-flash-image' or 'gemini-3-pro-image-preview', "
                        "or switch provider to OpenAI/Imagen."
                    ) from retry_exc
            usage_payload = getattr(response, "usage_metadata", None) or getattr(response, "usage", None)
            candidates = getattr(response, "candidates", []) or []
            for candidate in candidates:
                content = getattr(candidate, "content", None)
                parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
                for part in parts:
                    inline_data = getattr(part, "inline_data", None)
                    if not inline_data or getattr(inline_data, "data", None) is None:
                        continue
                    mime_type = getattr(inline_data, "mime_type", None)
                    data = inline_data.data
                    if isinstance(data, str):
                        data = data.encode("latin1")
                    images.append(
                        ProviderImage(
                            image_bytes=data,
                            mime_type=mime_type or f"image/{output_format}",
                            metadata={
                                "candidate_index": getattr(candidate, "index", None),
                                "mime_type": mime_type,
                            },
                        )
                    )
            raw_response = {
                "model": model,
                "candidates": len(candidates),
            }

        if not images:
            raise RuntimeError("Gemini returned no images.")

        return ProviderResponse(
            images=images,
            model=model,
            usage=usage_payload if isinstance(usage_payload, Mapping) else None,
            raw_request=raw_request,
            raw_response=raw_response,
            warnings=warnings,
        )

    def stream(self, request: ImageRequest, resolved: ResolvedRequest) -> Iterator[ProviderStreamEvent]:
        yield ProviderStreamEvent(
            type="error",
            index=0,
            message="Gemini does not support streaming image generation.",
        )
