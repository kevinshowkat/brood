"""OpenAI image provider."""

from __future__ import annotations

import base64
import json
import os
import re
import time
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..runs.receipts import ImageRequest
from ..utils import getenv_flag
from .base import GeneratedArtifact, ProviderResponse


_OPENAI_PROVIDER_OPTION_CONTROL_KEYS = {
    "allow_seed",
    "openai_allow_seed",
    "seed",
    "use_responses",
    "openai_use_responses",
    "responses_model",
    "openai_responses_model",
}
_OPENAI_ALLOWED_IMAGES_OPTIONS = {"quality", "moderation", "output_compression"}
_OPENAI_ALLOWED_EDITS_OPTIONS = {"quality", "moderation", "output_compression", "input_fidelity"}
_OPENAI_ALLOWED_RESPONSES_OPTIONS = {"quality"}
_OPENAI_SIZE_CHOICES: dict[str, tuple[int, int]] = {
    "1024x1024": (1024, 1024),
    "1024x1536": (1024, 1536),
    "1536x1024": (1536, 1024),
}
_OPENAI_QUALITY_ALIASES = {
    "low": "low",
    "fast": "low",
    "cheaper": "low",
    "medium": "medium",
    "standard": "medium",
    "high": "high",
    "hd": "high",
    "quality": "high",
    "better": "high",
    "auto": "auto",
}
_OPENAI_MODERATION_VALUES = {"auto", "low"}
_OPENAI_INPUT_FIDELITY_VALUES = {"low", "high"}
_OPENAI_OUTPUT_FORMAT_ALIASES = {
    "png": "png",
    "jpg": "jpeg",
    "jpeg": "jpeg",
    "webp": "webp",
}
_OPENAI_BACKGROUND_VALUES = {"auto", "transparent", "opaque"}
_OPENAI_DIM_RE = re.compile(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$")
_OPENAI_RATIO_RE = re.compile(r"^\s*(\d+)\s*[:/]\s*(\d+)\s*$")


class OpenAIProvider:
    name = "openai"

    def __init__(self, api_base: str | None = None, timeout_s: float = 90.0) -> None:
        self.api_base = (api_base or "https://api.openai.com/v1").rstrip("/")
        self.timeout_s = timeout_s

    def generate(self, request: ImageRequest) -> ProviderResponse:
        api_key = _get_api_key()
        if not api_key:
            raise RuntimeError("OpenAI API key missing. Set OPENAI_API_KEY or OPENAI_API_KEY_BACKUP.")

        warnings: list[str] = []
        use_responses = getenv_flag("OPENAI_IMAGE_USE_RESPONSES", False)
        has_image_inputs = _has_openai_edit_inputs(request)
        stream_requested = request.stream or getenv_flag("OPENAI_IMAGE_STREAM", False)
        if stream_requested:
            warnings.append("OpenAI image streaming is not implemented; falling back to non-streaming mode.")

        if has_image_inputs:
            if use_responses:
                warnings.append(
                    "OpenAI responses mode does not support multipart image edits; using Images edits endpoint."
                )
            return self._edit_with_images_api(request, api_key, warnings)
        if use_responses:
            return self._generate_with_responses(request, api_key, warnings)
        return self._generate_with_images_api(request, api_key, warnings)

    def _generate_with_images_api(
        self, request: ImageRequest, api_key: str, warnings: list[str]
    ) -> ProviderResponse:
        payload = _build_images_payload(request, warnings=warnings)
        endpoint = f"{self.api_base}/images/generations"
        status_code, response = _post_json(endpoint, payload, api_key, self.timeout_s)
        image_items = _extract_image_items(response)
        if not image_items:
            raise RuntimeError("OpenAI Images API returned no image data.")

        width, height = _resolve_size(str(payload.get("size") or request.size))
        artifact_output_format = _artifact_output_format_from_images_payload(payload)
        stamp = int(time.time() * 1000)
        results = _write_image_items(
            image_items,
            request,
            stamp,
            width,
            height,
            output_format=artifact_output_format,
        )
        provider_response = _summarize_response(response, status_code, len(results))
        return ProviderResponse(
            results=results,
            provider_request={"endpoint": endpoint, "payload": payload},
            provider_response=provider_response,
            warnings=warnings,
        )

    def _edit_with_images_api(
        self, request: ImageRequest, api_key: str, warnings: list[str]
    ) -> ProviderResponse:
        endpoint = f"{self.api_base}/images/edits"
        fields, files, payload_manifest = _build_images_edit_payload(request, warnings=warnings)
        status_code, response = _post_multipart(
            endpoint,
            fields=fields,
            files=files,
            api_key=api_key,
            timeout_s=self.timeout_s,
        )
        image_items = _extract_image_items(response)
        if not image_items:
            raise RuntimeError("OpenAI Images edits endpoint returned no image data.")

        width, height = _resolve_size(str(payload_manifest.get("size") or request.size))
        artifact_output_format = _artifact_output_format_from_images_payload(payload_manifest)
        stamp = int(time.time() * 1000)
        results = _write_image_items(
            image_items,
            request,
            stamp,
            width,
            height,
            output_format=artifact_output_format,
        )
        provider_response = _summarize_response(response, status_code, len(results))
        return ProviderResponse(
            results=results,
            provider_request={"endpoint": endpoint, "payload": payload_manifest},
            provider_response=provider_response,
            warnings=warnings,
        )

    def _generate_with_responses(
        self, request: ImageRequest, api_key: str, warnings: list[str]
    ) -> ProviderResponse:
        responses: list[Mapping[str, Any]] = []
        payloads: list[Mapping[str, Any]] = []
        first_payload = _build_responses_payload(request, warnings=warnings)
        tool_size = None
        tools = first_payload.get("tools")
        if isinstance(tools, list) and tools and isinstance(tools[0], Mapping):
            tool_size = tools[0].get("size")
        width, height = _resolve_size(str(tool_size or request.size))
        artifact_output_format = _artifact_output_format_from_responses_payload(first_payload)
        stamp = int(time.time() * 1000)
        results: list[GeneratedArtifact] = []
        endpoint = f"{self.api_base}/responses"
        target = max(int(request.n), 1)
        status_code = 0
        while len(results) < target:
            payload = first_payload if not payloads else _build_responses_payload(request, warnings=warnings)
            payloads.append(payload)
            status_code, response = _post_json(endpoint, payload, api_key, self.timeout_s)
            responses.append(response)
            image_blobs = _extract_response_images(response)
            if not image_blobs:
                raise RuntimeError("OpenAI Responses API returned no image data.")
            for image_blob in image_blobs:
                if len(results) >= target:
                    break
                image_path = _build_image_path(
                    request.out_dir,
                    len(results),
                    artifact_output_format,
                    stamp,
                )
                image_path.write_bytes(image_blob)
                results.append(
                    GeneratedArtifact(
                        image_path=image_path,
                        width=width,
                        height=height,
                        seed=request.seed,
                    )
                )
        provider_response = {
            "status_code": status_code,
            "responses_count": len(responses),
            "response_ids": [resp.get("id") for resp in responses if isinstance(resp, Mapping)],
        }
        usage_summary = _aggregate_usage(
            [resp.get("usage") for resp in responses if isinstance(resp, Mapping)]
        )
        if usage_summary:
            provider_response["usage"] = usage_summary
        return ProviderResponse(
            results=results,
            provider_request={"endpoint": endpoint, "payloads": payloads},
            provider_response=provider_response,
            warnings=warnings,
        )


def _get_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")


def _build_images_payload(request: ImageRequest, warnings: list[str] | None = None) -> dict[str, Any]:
    normalized_size = _normalize_openai_size(request.size, warnings=warnings)
    normalized_format = _normalize_openai_output_format(request.output_format, warnings=warnings)
    normalized_background = _normalize_openai_background(request.background, warnings=warnings)
    payload: dict[str, Any] = {
        "model": request.model or "gpt-image-1",
        "prompt": request.prompt,
        "n": max(int(request.n), 1),
        "size": normalized_size,
    }
    if request.seed is not None and _should_send_seed(request):
        payload["seed"] = request.seed
    if normalized_format:
        payload["output_format"] = normalized_format
    if normalized_background:
        payload["background"] = normalized_background
    if request.user:
        payload["user"] = request.user
    _merge_provider_options(
        payload,
        request.provider_options,
        allowed_options=_OPENAI_ALLOWED_IMAGES_OPTIONS,
        warnings=warnings,
    )
    if _is_gpt_image_model(payload.get("model")) and "moderation" not in payload:
        payload["moderation"] = "low"
    return payload


def _build_responses_payload(request: ImageRequest, warnings: list[str] | None = None) -> dict[str, Any]:
    model = _responses_model(request)
    tool: dict[str, Any] = {"type": "image_generation"}
    tool["size"] = _normalize_openai_size(request.size, warnings=warnings)
    normalized_background = _normalize_openai_background(request.background, warnings=warnings)
    if normalized_background:
        tool["background"] = normalized_background
    normalized_format = _normalize_openai_output_format(request.output_format, warnings=warnings)
    if normalized_format:
        tool["format"] = normalized_format
    if request.seed is not None and _should_send_seed(request):
        tool["seed"] = request.seed
    if request.model:
        tool["model"] = request.model
    _merge_provider_options(
        tool,
        request.provider_options,
        allowed_options=_OPENAI_ALLOWED_RESPONSES_OPTIONS,
        warnings=warnings,
    )
    payload = {
        "model": model,
        "input": request.prompt,
        "tools": [tool],
        "tool_choice": {"type": "image_generation"},
    }
    return payload


def _build_images_edit_payload(
    request: ImageRequest,
    warnings: list[str] | None = None,
) -> tuple[list[tuple[str, Any]], list[tuple[str, str, bytes, str | None]], dict[str, Any]]:
    normalized_size = _normalize_openai_size(request.size, warnings=warnings)
    normalized_format = _normalize_openai_output_format(request.output_format, warnings=warnings)
    normalized_background = _normalize_openai_background(request.background, warnings=warnings)

    scalar_fields: dict[str, Any] = {
        "model": request.model or "gpt-image-1",
        "prompt": request.prompt,
        "n": max(int(request.n), 1),
        "size": normalized_size,
    }
    if normalized_format:
        scalar_fields["output_format"] = normalized_format
    if normalized_background:
        scalar_fields["background"] = normalized_background
    if request.user:
        scalar_fields["user"] = request.user
    _merge_provider_options(
        scalar_fields,
        request.provider_options,
        allowed_options=_OPENAI_ALLOWED_EDITS_OPTIONS,
        warnings=warnings,
    )
    if _is_gpt_image_model(scalar_fields.get("model")) and "moderation" not in scalar_fields:
        scalar_fields["moderation"] = "low"

    images_to_attach = _openai_edit_image_inputs(request)
    if not images_to_attach:
        raise RuntimeError("OpenAI image edits require at least one input image.")

    files: list[tuple[str, str, bytes, str | None]] = []
    file_manifest: list[dict[str, Any]] = []
    for idx, image_value in enumerate(images_to_attach):
        image_bytes, filename, mime_type = _read_openai_image_input(image_value, f"image-{idx}")
        files.append(("image[]", filename, image_bytes, mime_type))
        file_manifest.append({"field": "image[]", "filename": filename, "mime_type": mime_type})

    if request.inputs.mask is not None:
        mask_bytes, mask_filename, mask_mime = _read_openai_image_input(request.inputs.mask, "mask")
        files.append(("mask", mask_filename, mask_bytes, mask_mime))
        file_manifest.append({"field": "mask", "filename": mask_filename, "mime_type": mask_mime})

    fields = [(key, value) for key, value in scalar_fields.items() if value is not None]
    payload_manifest = dict(scalar_fields)
    payload_manifest["files"] = file_manifest
    return fields, files, payload_manifest


def _responses_model(request: ImageRequest) -> str:
    options = request.provider_options
    if isinstance(options, Mapping):
        responses_model = options.get("responses_model")
        if responses_model is None:
            responses_model = options.get("openai_responses_model")
        if isinstance(responses_model, str) and responses_model.strip():
            return responses_model
    env_model = os.getenv("OPENAI_RESPONSES_MODEL")
    if env_model:
        return env_model
    return "gpt-4o-mini"


def _is_gpt_image_model(model: Any) -> bool:
    return str(model or "").strip().lower().startswith("gpt-image")


def _has_openai_edit_inputs(request: ImageRequest) -> bool:
    return bool(_openai_edit_image_inputs(request))


def _openai_edit_image_inputs(request: ImageRequest) -> list[Any]:
    images: list[Any] = []
    if request.inputs.init_image is not None:
        images.append(request.inputs.init_image)
    if request.inputs.reference_images:
        images.extend(list(request.inputs.reference_images))
    return images


def _read_openai_image_input(value: Any, default_stem: str) -> tuple[bytes, str, str | None]:
    if isinstance(value, (str, Path)):
        path = Path(value).expanduser()
        image_bytes = path.read_bytes()
        filename = path.name or f"{default_stem}.bin"
        mime_type = _mime_type_for_suffix(path.suffix)
        return image_bytes, filename, mime_type
    if isinstance(value, (bytes, bytearray)):
        return bytes(value), f"{default_stem}.bin", None
    raise RuntimeError(f"Unsupported OpenAI image input type: {type(value)}")


def _mime_type_for_suffix(suffix: str | None) -> str | None:
    normalized = str(suffix or "").strip().lower()
    if normalized == ".png":
        return "image/png"
    if normalized in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if normalized == ".webp":
        return "image/webp"
    return None


def _merge_provider_options(
    target: dict[str, Any],
    options: Mapping[str, Any],
    *,
    allowed_options: set[str],
    warnings: list[str] | None = None,
) -> None:
    for raw_key, value in options.items():
        key = str(raw_key or "").strip().lower()
        if not key:
            continue
        if key in _OPENAI_PROVIDER_OPTION_CONTROL_KEYS:
            continue
        if key not in allowed_options:
            continue
        if key in target:
            continue
        normalized = _normalize_openai_option_value(key, value, warnings=warnings)
        if normalized is None:
            continue
        target[key] = normalized


def _should_send_seed(request: ImageRequest) -> bool:
    options = request.provider_options
    if not isinstance(options, Mapping):
        return False
    raw = options.get("openai_allow_seed")
    if raw is None:
        raw = options.get("allow_seed")
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, (int, float)):
        return bool(raw)
    if isinstance(raw, str):
        return raw.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _normalize_openai_option_value(
    key: str, value: Any, *, warnings: list[str] | None = None
) -> Any:
    if key == "quality":
        return _normalize_openai_quality(value, warnings=warnings)
    if key == "moderation":
        return _normalize_openai_moderation(value, warnings=warnings)
    if key == "output_compression":
        return _normalize_openai_output_compression(value, warnings=warnings)
    if key == "input_fidelity":
        return _normalize_openai_input_fidelity(value, warnings=warnings)
    return value


def _normalize_openai_size(size: str | None, *, warnings: list[str] | None = None) -> str:
    normalized = str(size or "").strip().lower()
    if not normalized:
        return "1024x1024"
    if normalized in {"auto", "default"}:
        return "auto"
    if normalized in {"portrait", "tall"}:
        return "1024x1536"
    if normalized in {"landscape", "wide"}:
        return "1536x1024"
    if normalized in {"square", "1:1"}:
        return "1024x1024"

    dims = _parse_openai_dims(normalized)
    if dims:
        key = f"{dims[0]}x{dims[1]}"
        if key in _OPENAI_SIZE_CHOICES:
            return key
        target_ratio = dims[0] / dims[1]
    else:
        ratio = _parse_openai_ratio(normalized)
        if ratio is None:
            _append_warning(warnings, "OpenAI size unsupported; using 1024x1024.")
            return "1024x1024"
        target_ratio = ratio[0] / ratio[1]

    best_key = "1024x1024"
    best_delta = float("inf")
    for key, (width, height) in _OPENAI_SIZE_CHOICES.items():
        delta = abs((width / height) - target_ratio)
        if delta < best_delta:
            best_key = key
            best_delta = delta
    _append_warning(warnings, f"OpenAI size snapped to {best_key}.")
    return best_key


def _normalize_openai_quality(value: Any, *, warnings: list[str] | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    normalized = _OPENAI_QUALITY_ALIASES.get(text)
    if normalized is None:
        _append_warning(warnings, f"OpenAI quality '{value}' unsupported; using auto.")
        return "auto"
    return normalized


def _normalize_openai_moderation(value: Any, *, warnings: list[str] | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text in _OPENAI_MODERATION_VALUES:
        return text
    _append_warning(warnings, f"OpenAI moderation '{value}' unsupported; using auto.")
    return "auto"


def _normalize_openai_input_fidelity(value: Any, *, warnings: list[str] | None = None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text in _OPENAI_INPUT_FIDELITY_VALUES:
        return text
    _append_warning(warnings, f"OpenAI input_fidelity '{value}' unsupported; ignoring.")
    return None


def _normalize_openai_output_compression(value: Any, *, warnings: list[str] | None = None) -> int | None:
    if value is None:
        return None
    try:
        number = int(round(float(value)))
    except Exception:
        _append_warning(warnings, f"OpenAI output_compression '{value}' unsupported; ignoring.")
        return None
    clamped = max(0, min(100, number))
    if clamped != number:
        _append_warning(warnings, f"OpenAI output_compression clamped to {clamped}.")
    return clamped


def _normalize_openai_output_format(
    value: str | None, *, warnings: list[str] | None = None
) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text.startswith("image/"):
        text = text.split("/", 1)[1]
    normalized = _OPENAI_OUTPUT_FORMAT_ALIASES.get(text)
    if normalized:
        return normalized
    _append_warning(warnings, f"OpenAI output_format '{value}' unsupported; using provider default.")
    return None


def _normalize_openai_background(
    value: str | None, *, warnings: list[str] | None = None
) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text in _OPENAI_BACKGROUND_VALUES:
        return text
    _append_warning(warnings, f"OpenAI background '{value}' unsupported; omitting.")
    return None


def _parse_openai_dims(value: str) -> tuple[int, int] | None:
    match = _OPENAI_DIM_RE.match(value)
    if not match:
        return None
    width = int(match.group(1))
    height = int(match.group(2))
    if width <= 0 or height <= 0:
        return None
    return width, height


def _parse_openai_ratio(value: str) -> tuple[int, int] | None:
    match = _OPENAI_RATIO_RE.match(value)
    if not match:
        return None
    left = int(match.group(1))
    right = int(match.group(2))
    if left <= 0 or right <= 0:
        return None
    return left, right


def _append_warning(warnings: list[str] | None, message: str) -> None:
    if warnings is None:
        return
    if message in warnings:
        return
    warnings.append(message)


def _post_json(url: str, payload: Mapping[str, Any], api_key: str, timeout_s: float) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    req = Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout_s) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"OpenAI API error ({exc.code}): {raw}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc}") from exc

    try:
        payload_json: dict[str, Any] = json.loads(raw)
    except Exception:
        payload_json = {"raw": raw}
    return status_code, payload_json


def _post_multipart(
    url: str,
    *,
    fields: Sequence[tuple[str, Any]],
    files: Sequence[tuple[str, str, bytes, str | None]],
    api_key: str,
    timeout_s: float,
) -> tuple[int, dict[str, Any]]:
    boundary = f"----BroodBoundary{int(time.time() * 1000)}"
    body = _build_multipart_body(boundary, fields, files)
    req = Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urlopen(req, timeout=timeout_s) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"OpenAI API error ({exc.code}): {raw}") from exc
    except URLError as exc:
        raise RuntimeError(f"OpenAI API request failed: {exc}") from exc

    try:
        payload_json: dict[str, Any] = json.loads(raw)
    except Exception:
        payload_json = {"raw": raw}
    return status_code, payload_json


def _build_multipart_body(
    boundary: str,
    fields: Sequence[tuple[str, Any]],
    files: Sequence[tuple[str, str, bytes, str | None]],
) -> bytes:
    boundary_bytes = boundary.encode("utf-8")
    payload = bytearray()
    for key, value in fields:
        if value is None:
            continue
        payload.extend(b"--")
        payload.extend(boundary_bytes)
        payload.extend(b"\r\n")
        disposition = f'Content-Disposition: form-data; name="{_multipart_quote(key)}"\r\n\r\n'
        payload.extend(disposition.encode("utf-8"))
        payload.extend(str(value).encode("utf-8"))
        payload.extend(b"\r\n")
    for field_name, filename, blob, mime_type in files:
        payload.extend(b"--")
        payload.extend(boundary_bytes)
        payload.extend(b"\r\n")
        disposition = (
            "Content-Disposition: form-data; "
            f'name="{_multipart_quote(field_name)}"; filename="{_multipart_quote(filename)}"\r\n'
        )
        payload.extend(disposition.encode("utf-8"))
        if mime_type:
            payload.extend(f"Content-Type: {mime_type}\r\n".encode("utf-8"))
        payload.extend(b"\r\n")
        payload.extend(blob)
        payload.extend(b"\r\n")
    payload.extend(b"--")
    payload.extend(boundary_bytes)
    payload.extend(b"--\r\n")
    return bytes(payload)


def _multipart_quote(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def _extract_image_items(response: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    data = response.get("data")
    if isinstance(data, list):
        return [item for item in data if isinstance(item, Mapping)]
    return []


def _extract_response_images(response: Mapping[str, Any]) -> list[bytes]:
    images: list[bytes] = []
    output = response.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, Mapping):
                continue
            item_type = item.get("type")
            if item_type == "image_generation_call":
                result = item.get("result")
                if isinstance(result, str):
                    images.append(base64.b64decode(result))
                elif isinstance(result, list):
                    for entry in result:
                        if isinstance(entry, str):
                            images.append(base64.b64decode(entry))
                continue
            content = item.get("content")
            if isinstance(content, list):
                for chunk in content:
                    if not isinstance(chunk, Mapping):
                        continue
                    blob = chunk.get("image_base64") or chunk.get("b64_json")
                    if isinstance(blob, str):
                        images.append(base64.b64decode(blob))
    return images


def _artifact_output_format_from_images_payload(payload: Mapping[str, Any]) -> str | None:
    value = payload.get("output_format")
    if not isinstance(value, str):
        return None
    return _normalize_openai_output_format(value)


def _artifact_output_format_from_responses_payload(payload: Mapping[str, Any]) -> str | None:
    tools = payload.get("tools")
    if not isinstance(tools, list) or not tools:
        return None
    first = tools[0]
    if not isinstance(first, Mapping):
        return None
    value = first.get("format")
    if value is None:
        value = first.get("output_format")
    if not isinstance(value, str):
        return None
    return _normalize_openai_output_format(value)


def _write_image_items(
    items: Iterable[Mapping[str, Any]],
    request: ImageRequest,
    stamp: int,
    width: int | None,
    height: int | None,
    *,
    output_format: str | None = None,
) -> list[GeneratedArtifact]:
    results: list[GeneratedArtifact] = []
    for idx, item in enumerate(items):
        image_bytes = _extract_image_bytes(item)
        image_path = _build_image_path(request.out_dir, idx, output_format, stamp)
        image_path.write_bytes(image_bytes)
        seed = item.get("seed") if isinstance(item, Mapping) else None
        if seed is None:
            seed = request.seed
        results.append(
            GeneratedArtifact(
                image_path=image_path,
                width=width,
                height=height,
                seed=seed,
                metadata=_item_metadata(item),
            )
        )
    return results


def _extract_image_bytes(item: Mapping[str, Any]) -> bytes:
    if "b64_json" in item and isinstance(item["b64_json"], str):
        return base64.b64decode(item["b64_json"])
    if "image_base64" in item and isinstance(item["image_base64"], str):
        return base64.b64decode(item["image_base64"])
    if "url" in item and isinstance(item["url"], str):
        return _download_bytes(item["url"])
    raise RuntimeError("OpenAI response did not include image data.")


def _download_bytes(url: str) -> bytes:
    req = Request(url, method="GET")
    with urlopen(req, timeout=60.0) as response:
        return response.read()


def _item_metadata(item: Mapping[str, Any]) -> Mapping[str, Any] | None:
    metadata: dict[str, Any] = {}
    revised_prompt = item.get("revised_prompt")
    if revised_prompt:
        metadata["revised_prompt"] = revised_prompt
    return metadata or None


def _build_image_path(out_dir: str | None, idx: int, output_format: str | None, stamp: int | None = None) -> Path:
    base_dir = Path(out_dir) if out_dir else Path(".")
    base_dir.mkdir(parents=True, exist_ok=True)
    timestamp = stamp or int(time.time() * 1000)
    ext = _extension_from_format(output_format)
    return base_dir / f"artifact-{timestamp}-{idx:02d}.{ext}"


def _extension_from_format(output_format: str | None) -> str:
    if not output_format:
        return "png"
    normalized = output_format.strip().lower()
    if normalized.startswith("image/"):
        normalized = normalized.split("/", 1)[1]
    if normalized in {"jpeg", "jpg"}:
        return "jpg"
    if normalized == "webp":
        return "webp"
    return "png"


def _resolve_size(size: str | None) -> tuple[int | None, int | None]:
    normalized = (size or "").strip().lower()
    if not normalized or normalized == "auto":
        return None, None
    if normalized in {"portrait", "tall"}:
        return 1024, 1536
    if normalized in {"landscape", "wide"}:
        return 1536, 1024
    if normalized in {"square", "1:1"}:
        return 1024, 1024
    if "x" in normalized:
        parts = normalized.split("x", 1)
        try:
            return int(parts[0]), int(parts[1])
        except Exception:
            return None, None
    return None, None


def _summarize_response(response: Mapping[str, Any], status_code: int, count: int) -> Mapping[str, Any]:
    summary = {
        "status_code": status_code,
        "created": response.get("created"),
        "data_count": count,
    }
    if "usage" in response:
        summary["usage"] = response.get("usage")
    return summary


def _safe_nonnegative_int(value: Any) -> int | None:
    try:
        number = int(round(float(value)))
    except Exception:
        return None
    if number < 0:
        return None
    return number


def _read_usage_value(usage: Mapping[str, Any], keys: tuple[str, ...]) -> int | None:
    for key in keys:
        if key not in usage:
            continue
        parsed = _safe_nonnegative_int(usage.get(key))
        if parsed is not None:
            return parsed
    return None


def _extract_usage_pair(usage: Mapping[str, Any]) -> tuple[int | None, int | None]:
    input_tokens = _read_usage_value(
        usage,
        (
            "input_tokens",
            "prompt_tokens",
            "prompt_token_count",
            "promptTokenCount",
            "tokens_in",
            "tokensIn",
            "inputTokenCount",
            "input_text_tokens",
        ),
    )
    output_tokens = _read_usage_value(
        usage,
        (
            "output_tokens",
            "completion_tokens",
            "completion_token_count",
            "completionTokenCount",
            "tokens_out",
            "tokensOut",
            "outputTokenCount",
            "output_text_tokens",
            "candidates_token_count",
            "candidatesTokenCount",
        ),
    )
    total_tokens = _read_usage_value(
        usage,
        (
            "total_tokens",
            "total_token_count",
            "totalTokenCount",
            "totalTokens",
            "token_count",
            "tokenCount",
        ),
    )
    if output_tokens is None and total_tokens is not None and input_tokens is not None and total_tokens >= input_tokens:
        output_tokens = total_tokens - input_tokens
    return input_tokens, output_tokens


def _aggregate_usage(values: Iterable[Any]) -> Mapping[str, int] | None:
    total_input = 0
    total_output = 0
    has_input = False
    has_output = False
    for value in values:
        if not isinstance(value, Mapping):
            continue
        input_tokens, output_tokens = _extract_usage_pair(value)
        if input_tokens is not None:
            total_input += input_tokens
            has_input = True
        if output_tokens is not None:
            total_output += output_tokens
            has_output = True
    if not has_input and not has_output:
        return None
    usage: dict[str, int] = {}
    if has_input:
        usage["input_tokens"] = total_input
    if has_output:
        usage["output_tokens"] = total_output
    if has_input and has_output:
        usage["total_tokens"] = total_input + total_output
    return usage


def fetch_reasoning_summary(
    prompt: str,
    model: str,
    *,
    effort: str = "low",
    summary: str = "auto",
    enable_web_search: bool = False,
    api_base: str | None = None,
    timeout_s: float = 30.0,
) -> str | None:
    api_key = _get_api_key()
    if not api_key:
        return None
    endpoint = f"{(api_base or 'https://api.openai.com/v1').rstrip('/')}/responses"
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "reasoning": {"effort": effort, "summary": summary},
    }
    if enable_web_search:
        payload["tools"] = [{"type": "web_search"}]
    _, response = _post_json(endpoint, payload, api_key, timeout_s)
    return _extract_reasoning_summary(response)


def _extract_reasoning_summary(response: Mapping[str, Any]) -> str | None:
    output = response.get("output")
    if not isinstance(output, list):
        return None
    for item in output:
        if not isinstance(item, Mapping):
            continue
        if item.get("type") != "reasoning":
            continue
        summary = item.get("summary")
        if isinstance(summary, list):
            for entry in summary:
                if isinstance(entry, Mapping) and entry.get("type") == "summary_text":
                    text = entry.get("text")
                    if isinstance(text, str) and text.strip():
                        return text.strip()
        if isinstance(summary, str) and summary.strip():
            return summary.strip()
    return None
