"""Flux / BFL provider."""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..runs.receipts import ImageRequest
from .base import GeneratedArtifact, ProviderResponse


class FluxProvider:
    name = "flux"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        api_key = _resolve_api_key()
        options = dict(request.provider_options or {})
        endpoint_url, endpoint_label = _resolve_endpoint(options, request.model)
        width, height, size_warnings = _resolve_flux_dims(request.size)

        poll_interval = float(options.get("poll_interval", 0.5))
        poll_timeout = float(options.get("poll_timeout", 120.0))
        request_timeout = float(options.get("request_timeout", 30.0))
        download_timeout = float(options.get("download_timeout", 60.0))

        warnings: list[str] = []
        for warning in size_warnings:
            _append_warning(warnings, warning)
        if endpoint_label == "flux-2":
            _append_warning(warnings, "Flux model flux-2 is deprecated; using flux-2-flex.")
        if request.inputs.mask is not None:
            _append_warning(warnings, "FLUX mask inputs are not supported; ignoring mask.")

        headers = {
            "accept": "application/json",
            "x-key": api_key,
            "Content-Type": "application/json",
        }

        provider_request: dict[str, Any] = {
            "endpoint": endpoint_url,
            "model": request.model,
            "prompt": request.prompt,
        }
        provider_response: dict[str, Any] = {}
        payload_manifests: list[dict[str, Any]] = []

        results: list[GeneratedArtifact] = []
        output_format = _normalize_flux_output_format(request.output_format)
        if output_format is None:
            if request.output_format:
                _append_warning(warnings, f"FLUX output_format '{request.output_format}' unsupported; using jpeg.")
            output_format = "jpeg"
        generation_options = _sanitize_flux_options(options, endpoint_label=endpoint_label, warnings=warnings)
        option_output_format = generation_options.pop("output_format", None)
        if isinstance(option_output_format, str) and option_output_format:
            output_format = option_output_format
        input_images, input_image_manifest = _resolve_flux_input_images(
            request,
            endpoint_label=endpoint_label,
            warnings=warnings,
        )
        for idx in range(max(1, int(request.n))):
            payload: dict[str, Any] = {
                "prompt": request.prompt,
                "width": width,
                "height": height,
            }
            if request.seed is not None:
                payload["seed"] = request.seed
            if output_format:
                payload["output_format"] = output_format
            for key, value in generation_options.items():
                payload[key] = value
            for key, value in input_images.items():
                payload[key] = value
            payload_manifests.append(_flux_payload_manifest(payload, input_image_manifest))

            result = _generate_one(
                endpoint_url=endpoint_url,
                payload=payload,
                headers=headers,
                poll_interval=poll_interval,
                poll_timeout=poll_timeout,
                request_timeout=request_timeout,
                download_timeout=download_timeout,
            )
            provider_response = dict(result["result_payload"])
            image_path = _build_image_path(request.out_dir, idx, output_format)
            image_path.write_bytes(result["image_bytes"])
            results.append(
                GeneratedArtifact(
                    image_path=image_path,
                    width=width,
                    height=height,
                    seed=request.seed,
                    metadata={"request_id": result["request_id"], "payload": payload},
                )
            )

        if not results:
            raise RuntimeError("Flux returned no images.")
        if len(payload_manifests) == 1:
            provider_request["payload"] = payload_manifests[0]
        elif payload_manifests:
            provider_request["payloads"] = payload_manifests

        return ProviderResponse(
            results=results,
            provider_request=provider_request,
            provider_response=provider_response,
            warnings=warnings,
        )


API_BASE_URL = "https://api.bfl.ai/v1"
DEFAULT_ENDPOINT = "flux-2-flex"
READY_STATUSES = {"ready"}
FAILURE_STATUSES = {"error", "failed", "request moderated", "content moderated", "task not found"}
_CONTROL_KEYS = {
    "endpoint",
    "url",
    "model",
    "poll_interval",
    "poll_timeout",
    "request_timeout",
    "download_timeout",
}
_FLUX_ALLOWED_OPTION_KEYS = {
    "output_format",
    "safety_tolerance",
    "steps",
    "guidance",
    "prompt_upsampling",
}
_FLUX_MAX_AREA = 4_000_000
_FLUX_MIN_SIDE = 64
_FLUX_MAX_INPUT_IMAGES_DEFAULT = 8
_FLUX_MAX_INPUT_IMAGES_KLEIN = 4


def _resolve_api_key() -> str:
    api_key = os.getenv("BFL_API_KEY") or os.getenv("FLUX_API_KEY")
    if not api_key:
        raise RuntimeError("BFL_API_KEY (or FLUX_API_KEY) must be set for Flux.")
    return api_key


def _resolve_endpoint(options: Mapping[str, Any], model: str | None) -> tuple[str, str]:
    endpoint_option = options.get("endpoint") or options.get("url") or options.get("model") or model
    suffix = str(endpoint_option or DEFAULT_ENDPOINT).strip()
    if suffix.lower().startswith("http"):
        return suffix, suffix.rsplit("/", 1)[-1]
    suffix = suffix.lstrip("/")
    if suffix.lower() == "flux-2":
        suffix = "flux-2-flex"
    return f"{API_BASE_URL}/{suffix}", suffix


def _resolve_flux_dims(size: str | None) -> tuple[int, int, list[str]]:
    warnings: list[str] = []
    normalized = (size or "1024x1024").strip().lower()
    width, height = 1024, 1024
    if normalized in {"portrait", "tall"}:
        width, height = 1024, 1536
    elif normalized in {"landscape", "wide"}:
        width, height = 1536, 1024
    elif normalized in {"square", "1:1"}:
        width, height = 1024, 1024
    elif "x" in normalized:
        parts = normalized.split("x", 1)
        try:
            width = int(parts[0])
            height = int(parts[1])
        except Exception:
            width, height = 1024, 1024
    width = max(_FLUX_MIN_SIDE, width)
    height = max(_FLUX_MIN_SIDE, height)

    snapped_w = _snap_multiple(width, 16)
    snapped_h = _snap_multiple(height, 16)
    if (snapped_w, snapped_h) != (width, height):
        warnings.append(f"FLUX size snapped to {snapped_w}x{snapped_h} (multiples of 16).")

    scaled_w, scaled_h = _clamp_flux_area(snapped_w, snapped_h)
    if (scaled_w, scaled_h) != (snapped_w, snapped_h):
        warnings.append(f"FLUX size scaled down to {scaled_w}x{scaled_h} (max {_FLUX_MAX_AREA} pixels).")
    return scaled_w, scaled_h, warnings


def _snap_multiple(value: int, multiple: int) -> int:
    if value <= 0:
        return multiple
    return max(multiple, int(round(value / multiple) * multiple))


def _clamp_flux_area(width: int, height: int) -> tuple[int, int]:
    w = max(_FLUX_MIN_SIDE, int(width))
    h = max(_FLUX_MIN_SIDE, int(height))
    if w * h <= _FLUX_MAX_AREA:
        return w, h
    scale = (_FLUX_MAX_AREA / float(w * h)) ** 0.5
    w = _snap_multiple(max(_FLUX_MIN_SIDE, int(w * scale)), 16)
    h = _snap_multiple(max(_FLUX_MIN_SIDE, int(h * scale)), 16)
    while w * h > _FLUX_MAX_AREA:
        if w >= h and w > _FLUX_MIN_SIDE:
            w -= 16
        elif h > _FLUX_MIN_SIDE:
            h -= 16
        else:
            break
    return max(_FLUX_MIN_SIDE, w), max(_FLUX_MIN_SIDE, h)


def _is_flux_flex_endpoint(endpoint_label: str) -> bool:
    return "flex" in str(endpoint_label or "").strip().lower()


def _normalize_flux_output_format(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    if not text:
        return None
    if text.startswith("image/"):
        text = text.split("/", 1)[1]
    if text in {"jpg", "jpeg"}:
        return "jpeg"
    if text == "png":
        return "png"
    return None


def _normalize_flux_safety_tolerance(value: Any, warnings: list[str]) -> int | None:
    try:
        number = int(round(float(value)))
    except Exception:
        _append_warning(warnings, f"FLUX safety_tolerance '{value}' unsupported; ignoring.")
        return None
    clamped = max(0, min(5, number))
    if clamped != number:
        _append_warning(warnings, f"FLUX safety_tolerance clamped to {clamped}.")
    return clamped


def _normalize_flux_steps(value: Any, warnings: list[str]) -> int | None:
    try:
        number = int(round(float(value)))
    except Exception:
        _append_warning(warnings, f"FLUX steps '{value}' unsupported; ignoring.")
        return None
    clamped = max(1, min(50, number))
    if clamped != number:
        _append_warning(warnings, f"FLUX steps clamped to {clamped}.")
    return clamped


def _normalize_flux_guidance(value: Any, warnings: list[str]) -> float | None:
    try:
        number = float(value)
    except Exception:
        _append_warning(warnings, f"FLUX guidance '{value}' unsupported; ignoring.")
        return None
    clamped = max(1.5, min(10.0, number))
    if abs(clamped - number) > 1e-9:
        _append_warning(warnings, f"FLUX guidance clamped to {clamped:g}.")
    return clamped


def _normalize_flux_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on"}:
            return True
        if lowered in {"0", "false", "no", "off"}:
            return False
    return None


def _sanitize_flux_options(
    options: Mapping[str, Any], *, endpoint_label: str, warnings: list[str]
) -> dict[str, Any]:
    sanitized: dict[str, Any] = {}
    flex_endpoint = _is_flux_flex_endpoint(endpoint_label)
    for raw_key, value in options.items():
        key = str(raw_key or "").strip().lower()
        if not key:
            continue
        if key in _CONTROL_KEYS:
            continue
        if key not in _FLUX_ALLOWED_OPTION_KEYS:
            _append_warning(warnings, f"FLUX ignored unsupported provider option '{key}'.")
            continue
        if key == "output_format":
            normalized = _normalize_flux_output_format(value)
            if normalized is None:
                _append_warning(warnings, f"FLUX output_format '{value}' unsupported; ignoring.")
                continue
            sanitized[key] = normalized
            continue
        if key == "safety_tolerance":
            normalized = _normalize_flux_safety_tolerance(value, warnings)
            if normalized is not None:
                sanitized[key] = normalized
            continue
        if key == "steps":
            if not flex_endpoint:
                _append_warning(warnings, "FLUX ignored steps for non-flex endpoint.")
                continue
            normalized = _normalize_flux_steps(value, warnings)
            if normalized is not None:
                sanitized[key] = normalized
            continue
        if key == "guidance":
            if not flex_endpoint:
                _append_warning(warnings, "FLUX ignored guidance for non-flex endpoint.")
                continue
            normalized = _normalize_flux_guidance(value, warnings)
            if normalized is not None:
                sanitized[key] = normalized
            continue
        if key == "prompt_upsampling":
            normalized = _normalize_flux_bool(value)
            if normalized is None:
                _append_warning(warnings, f"FLUX prompt_upsampling '{value}' unsupported; ignoring.")
                continue
            sanitized[key] = normalized
            continue
    return sanitized


def _append_warning(warnings: list[str], message: str) -> None:
    if message in warnings:
        return
    warnings.append(message)


def _resolve_flux_input_images(
    request: ImageRequest,
    *,
    endpoint_label: str,
    warnings: list[str],
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    raw_inputs: list[tuple[str, Any]] = []
    if request.inputs.init_image is not None:
        raw_inputs.append(("init_image", request.inputs.init_image))
    for index, value in enumerate(request.inputs.reference_images):
        raw_inputs.append((f"reference_images[{index}]", value))
    if not raw_inputs:
        return {}, []

    max_images = _flux_input_image_limit(endpoint_label)
    if len(raw_inputs) > max_images:
        _append_warning(
            warnings,
            f"FLUX accepted first {max_images} input images; dropped {len(raw_inputs) - max_images} extra references.",
        )
        raw_inputs = raw_inputs[:max_images]

    payload_fields: dict[str, str] = {}
    manifest: list[dict[str, Any]] = []
    for index, (role, value) in enumerate(raw_inputs):
        key = "input_image" if index == 0 else f"input_image_{index + 1}"
        payload_fields[key] = _coerce_flux_input_image(value)
        manifest.append(_describe_flux_input_image(role=role, key=key, value=value))
    return payload_fields, manifest


def _flux_input_image_limit(endpoint_label: str) -> int:
    normalized = str(endpoint_label or "").strip().lower()
    if "klein" in normalized:
        return _FLUX_MAX_INPUT_IMAGES_KLEIN
    return _FLUX_MAX_INPUT_IMAGES_DEFAULT


def _coerce_flux_input_image(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, Path):
        return base64.b64encode(value.expanduser().read_bytes()).decode("ascii")
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise RuntimeError("FLUX input image value is empty.")
        lowered = text.lower()
        if lowered.startswith("http://") or lowered.startswith("https://") or lowered.startswith("data:image/"):
            return text
        path = Path(text).expanduser()
        if path.exists() and path.is_file():
            return base64.b64encode(path.read_bytes()).decode("ascii")
        return text
    raise RuntimeError(f"Unsupported FLUX input image type: {type(value)}")


def _describe_flux_input_image(*, role: str, key: str, value: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {"key": key, "role": role}
    if isinstance(value, Path):
        path = value.expanduser()
        payload["source"] = "path"
        payload["path"] = str(path)
        payload["name"] = path.name
        return payload
    if isinstance(value, str):
        text = value.strip()
        lowered = text.lower()
        if lowered.startswith("http://") or lowered.startswith("https://"):
            payload["source"] = "url"
            payload["url"] = text
            return payload
        if lowered.startswith("data:image/"):
            payload["source"] = "data_url"
            return payload
        path = Path(text).expanduser()
        if path.exists() and path.is_file():
            payload["source"] = "path"
            payload["path"] = str(path)
            payload["name"] = path.name
            return payload
        payload["source"] = "base64"
        payload["length"] = len(text)
        return payload
    if isinstance(value, (bytes, bytearray)):
        payload["source"] = "bytes"
        payload["length"] = len(value)
        return payload
    payload["source"] = type(value).__name__
    return payload


def _flux_payload_manifest(
    payload: Mapping[str, Any],
    input_images: list[dict[str, Any]],
) -> dict[str, Any]:
    manifest = dict(payload)
    redacted_keys = [key for key in manifest if str(key).startswith("input_image")]
    for key in redacted_keys:
        manifest.pop(key, None)
    if input_images:
        manifest["input_images"] = input_images
    return manifest


def _generate_one(
    *,
    endpoint_url: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
    poll_interval: float,
    poll_timeout: float,
    request_timeout: float,
    download_timeout: float,
) -> dict[str, Any]:
    status_code, request_json = _post_json(endpoint_url, payload, headers, request_timeout)
    request_id = request_json.get("id")
    polling_url = request_json.get("polling_url")
    if not request_id or not polling_url:
        raise RuntimeError(f"Flux request missing id or polling_url: {request_json}")

    started = time.time()
    last_payload: Mapping[str, Any] = {}
    while time.time() - started < poll_timeout:
        status_code, payload_json = _get_json(polling_url, headers, request_timeout)
        last_payload = payload_json
        status = str(payload_json.get("status") or "").lower()
        if status in READY_STATUSES:
            result = payload_json.get("result") or {}
            sample = result.get("sample") or result.get("output") or payload_json.get("sample")
            if not sample:
                raise RuntimeError("Flux result missing sample URL.")
            image_bytes = _download_bytes(sample, headers, download_timeout)
            return {
                "image_bytes": image_bytes,
                "request_id": request_id,
                "result_payload": payload_json,
            }
        if status in FAILURE_STATUSES:
            raise RuntimeError(f"Flux generation failed: {payload_json}")
        time.sleep(poll_interval)

    raise RuntimeError(f"Flux polling timed out after {poll_timeout:.1f}s.")


def _post_json(
    url: str, payload: Mapping[str, Any], headers: Mapping[str, str], timeout_s: float
) -> tuple[int, dict[str, Any]]:
    body = json.dumps(payload).encode("utf-8")
    req = Request(url, data=body, headers=dict(headers), method="POST")
    try:
        with urlopen(req, timeout=timeout_s) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"Flux request failed ({exc.code}): {raw}") from exc
    except URLError as exc:
        raise RuntimeError(f"Flux request failed: {exc}") from exc
    try:
        payload_json: dict[str, Any] = json.loads(raw)
    except Exception:
        payload_json = {"raw": raw}
    return status_code, payload_json


def _get_json(
    url: str, headers: Mapping[str, str], timeout_s: float
) -> tuple[int, dict[str, Any]]:
    req = Request(url, headers=dict(headers), method="GET")
    try:
        with urlopen(req, timeout=timeout_s) as response:
            status_code = int(getattr(response, "status", 200))
            raw = response.read().decode("utf-8")
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else str(exc)
        raise RuntimeError(f"Flux poll failed ({exc.code}): {raw}") from exc
    except URLError as exc:
        raise RuntimeError(f"Flux poll failed: {exc}") from exc
    try:
        payload_json: dict[str, Any] = json.loads(raw)
    except Exception:
        payload_json = {"raw": raw}
    return status_code, payload_json


def _download_bytes(url: str, headers: Mapping[str, str], timeout_s: float) -> bytes:
    req = Request(url, headers=dict(headers), method="GET")
    with urlopen(req, timeout=timeout_s) as response:
        return response.read()


def _build_image_path(out_dir: str | None, idx: int, output_format: str) -> Path:
    base_dir = Path(out_dir) if out_dir else Path(".")
    base_dir.mkdir(parents=True, exist_ok=True)
    stamp = int(time.time() * 1000)
    ext = output_format.strip().lower()
    if ext == "jpeg":
        ext = "jpg"
    if ext not in {"png", "jpg", "webp"}:
        ext = "jpg"
    return base_dir / f"artifact-{stamp}-{idx:02d}.{ext}"
