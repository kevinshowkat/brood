"""Flux / BFL provider."""

from __future__ import annotations

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
        width, height, size_warning = _resolve_flux_dims(request.size)

        poll_interval = float(options.get("poll_interval", 0.5))
        poll_timeout = float(options.get("poll_timeout", 120.0))
        request_timeout = float(options.get("request_timeout", 30.0))
        download_timeout = float(options.get("download_timeout", 60.0))

        warnings: list[str] = []
        if size_warning:
            warnings.append(size_warning)
        if endpoint_label == "flux-2":
            warnings.append("Flux model flux-2 is deprecated; using flux-2-flex.")

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

        results: list[GeneratedArtifact] = []
        output_format = (request.output_format or "jpg").strip().lower()
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
            for key, value in options.items():
                if key in _CONTROL_KEYS:
                    continue
                payload[key] = value

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


def _resolve_flux_dims(size: str | None) -> tuple[int, int, str | None]:
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
    snapped_w = _snap_multiple(width, 16)
    snapped_h = _snap_multiple(height, 16)
    warning = None
    if (snapped_w, snapped_h) != (width, height):
        warning = f"FLUX size snapped to {snapped_w}x{snapped_h} (multiples of 16)."
    return snapped_w, snapped_h, warning


def _snap_multiple(value: int, multiple: int) -> int:
    return int(round(value / multiple) * multiple)


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
