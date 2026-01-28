"""Flux (BFL) adapter."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Iterator, List, Mapping, Optional
from urllib.parse import urlparse

try:
    import requests  # type: ignore
except Exception:  # pragma: no cover
    requests = None  # type: ignore

from forge_image_api.core.contracts import ImageRequest, ResolvedRequest
from .base import ProviderAdapter, ProviderImage, ProviderResponse, ProviderStreamEvent


API_BASE_URL = "https://api.bfl.ai/v1"
DEFAULT_ENDPOINT = "flux-2-flex"
DEFAULT_POLL_INTERVAL = 0.5
DEFAULT_POLL_TIMEOUT = 120.0
DEFAULT_REQUEST_TIMEOUT = 30.0
DEFAULT_DOWNLOAD_TIMEOUT = 60.0
READY_STATUSES = {"ready"}
FAILURE_STATUSES = {"error", "failed", "request moderated", "content moderated", "task not found"}
CONTROL_KEYS = {
    "endpoint",
    "url",
    "model",
    "poll_interval",
    "poll_timeout",
    "request_timeout",
    "download_timeout",
}


@dataclass
class _FluxResult:
    image_bytes: bytes
    mime_type: Optional[str]
    request_id: str
    result_payload: Mapping[str, Any]


def _resolve_api_key() -> str:
    api_key = os.getenv("BFL_API_KEY") or os.getenv("FLUX_API_KEY")
    if not api_key:
        raise RuntimeError("BFL_API_KEY (or FLUX_API_KEY) must be set for Flux.")
    return api_key


def _resolve_endpoint(options: Mapping[str, Any]) -> tuple[str, str]:
    endpoint_option = options.get("endpoint") or options.get("url") or options.get("model")
    suffix = str(endpoint_option or DEFAULT_ENDPOINT).strip()
    if suffix.lower().startswith("http"):
        return suffix, suffix.rsplit("/", 1)[-1]
    suffix = suffix.lstrip("/")
    return f"{API_BASE_URL}/{suffix}", suffix


def _determine_extension(sample_url: str, output_format: str) -> str:
    parsed = urlparse(sample_url)
    suffix = parsed.path.rsplit(".", 1)[-1].lower() if "." in parsed.path else ""
    if suffix in {"png", "jpg", "jpeg", "webp"}:
        return "jpg" if suffix == "jpeg" else suffix
    return "jpg" if output_format == "jpeg" else output_format


def _generate_one(
    *,
    endpoint_url: str,
    payload: Mapping[str, Any],
    headers: Mapping[str, str],
    poll_interval: float,
    poll_timeout: float,
    request_timeout: float,
    download_timeout: float,
) -> _FluxResult:
    if requests is None:
        raise RuntimeError("requests package not installed. Run: pip install requests")

    def _summarize_error(response) -> str:
        detail = ""
        try:
            detail = json.dumps(response.json(), ensure_ascii=True)
        except Exception:
            try:
                detail = response.text or ""
            except Exception:
                detail = ""
        detail = detail.strip().replace("\n", " ")
        if len(detail) > 500:
            detail = detail[:500].rstrip() + "..."
        return detail

    def _raise_for_status(response, label: str) -> None:
        try:
            response.raise_for_status()
        except Exception as exc:
            detail = _summarize_error(response)
            url = getattr(response, "url", "")
            parts = [f"Flux {label} failed ({response.status_code})"]
            if url:
                parts.append(f"url={url}")
            if detail:
                parts.append(detail)
            raise RuntimeError(": ".join(parts)) from exc

    session = requests.Session()
    request_response = session.post(
        endpoint_url,
        headers=headers,
        json=payload,
        timeout=request_timeout,
    )
    _raise_for_status(request_response, "request")
    request_json = request_response.json()
    request_id = request_json.get("id")
    polling_url = request_json.get("polling_url")
    if not request_id or not polling_url:
        raise RuntimeError(f"Flux request missing id or polling_url: {request_json}")

    started = time.time()
    last_payload: Mapping[str, Any] = {}
    while time.time() - started < poll_timeout:
        poll_response = session.get(polling_url, headers=headers, timeout=request_timeout)
        _raise_for_status(poll_response, "poll")
        payload_json = poll_response.json()
        last_payload = payload_json
        status = str(payload_json.get("status") or "").lower()
        if status in READY_STATUSES:
            result = payload_json.get("result") or {}
            sample = result.get("sample") or result.get("output") or payload_json.get("sample")
            if not sample:
                raise RuntimeError("Flux result missing sample URL.")
            image_response = session.get(sample, timeout=download_timeout)
            _raise_for_status(image_response, "download")
            mime_type = image_response.headers.get("content-type")
            return _FluxResult(
                image_bytes=image_response.content,
                mime_type=mime_type,
                request_id=request_id,
                result_payload=payload_json,
            )
        if status in FAILURE_STATUSES:
            raise RuntimeError(f"Flux generation failed: {payload_json}")
        time.sleep(poll_interval)

    raise RuntimeError(f"Flux polling timed out after {poll_timeout:.1f}s.")


class FluxAdapter:
    name = "flux"

    def generate(self, request: ImageRequest, resolved: ResolvedRequest) -> ProviderResponse:
        api_key = _resolve_api_key()
        options = dict(request.provider_options or {})
        if resolved.model and not any(key in options for key in ("endpoint", "url", "model")):
            options["model"] = resolved.model
        endpoint_url, endpoint_label = _resolve_endpoint(options)

        poll_interval = float(options.get("poll_interval", DEFAULT_POLL_INTERVAL))
        poll_timeout = float(options.get("poll_timeout", DEFAULT_POLL_TIMEOUT))
        request_timeout = float(options.get("request_timeout", DEFAULT_REQUEST_TIMEOUT))
        download_timeout = float(options.get("download_timeout", DEFAULT_DOWNLOAD_TIMEOUT))

        headers = {
            "accept": "application/json",
            "x-key": api_key,
            "Content-Type": "application/json",
        }

        images: List[ProviderImage] = []
        raw_request = {
            "endpoint": endpoint_url,
            "model": resolved.model,
            "prompt": resolved.prompt,
        }
        raw_response: Dict[str, Any] = {}

        for idx in range(max(1, resolved.n)):
            payload: Dict[str, Any] = {
                "prompt": resolved.prompt,
                "width": resolved.provider_params.get("width"),
                "height": resolved.provider_params.get("height"),
            }
            output_format = resolved.provider_params.get("output_format")
            if output_format:
                payload["output_format"] = output_format
            if resolved.seed is not None:
                payload["seed"] = resolved.seed
            payload.update({k: v for k, v in options.items() if k not in CONTROL_KEYS})

            result = _generate_one(
                endpoint_url=endpoint_url,
                payload=payload,
                headers=headers,
                poll_interval=poll_interval,
                poll_timeout=poll_timeout,
                request_timeout=request_timeout,
                download_timeout=download_timeout,
            )
            raw_response = dict(result.result_payload)
            images.append(
                ProviderImage(
                    image_bytes=result.image_bytes,
                    mime_type=result.mime_type,
                    provider_request_id=result.request_id,
                    metadata={"payload": payload, "result": result.result_payload},
                )
            )

        if not images:
            raise RuntimeError("Flux returned no images.")

        return ProviderResponse(
            images=images,
            model=resolved.model,
            usage=None,
            raw_request=raw_request,
            raw_response=raw_response,
            warnings=resolved.warnings,
        )

    def stream(self, request: ImageRequest, resolved: ResolvedRequest) -> Iterator[ProviderStreamEvent]:
        yield ProviderStreamEvent(
            type="log",
            index=0,
            message="Flux uses submit-and-poll; streaming emits log events only.",
        )
        response = self.generate(request, resolved)
        for idx, image in enumerate(response.images):
            yield ProviderStreamEvent(type="final", index=idx, image=image)
