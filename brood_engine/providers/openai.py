"""OpenAI image provider."""

from __future__ import annotations

import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from ..runs.receipts import ImageRequest
from ..utils import getenv_flag
from .base import GeneratedArtifact, ProviderResponse


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
        stream_requested = request.stream or getenv_flag("OPENAI_IMAGE_STREAM", False)
        if stream_requested:
            warnings.append("OpenAI image streaming is not implemented; falling back to non-streaming mode.")

        if use_responses:
            return self._generate_with_responses(request, api_key, warnings)
        return self._generate_with_images_api(request, api_key, warnings)

    def _generate_with_images_api(
        self, request: ImageRequest, api_key: str, warnings: list[str]
    ) -> ProviderResponse:
        payload = _build_images_payload(request)
        endpoint = f"{self.api_base}/images/generations"
        status_code, response = _post_json(endpoint, payload, api_key, self.timeout_s)
        image_items = _extract_image_items(response)
        if not image_items:
            raise RuntimeError("OpenAI Images API returned no image data.")

        width, height = _resolve_size(request.size)
        stamp = int(time.time() * 1000)
        results = _write_image_items(image_items, request, stamp, width, height)
        provider_response = _summarize_response(response, status_code, len(results))
        return ProviderResponse(
            results=results,
            provider_request={"endpoint": endpoint, "payload": payload},
            provider_response=provider_response,
            warnings=warnings,
        )

    def _generate_with_responses(
        self, request: ImageRequest, api_key: str, warnings: list[str]
    ) -> ProviderResponse:
        responses: list[Mapping[str, Any]] = []
        payloads: list[Mapping[str, Any]] = []
        width, height = _resolve_size(request.size)
        stamp = int(time.time() * 1000)
        results: list[GeneratedArtifact] = []
        endpoint = f"{self.api_base}/responses"
        target = max(int(request.n), 1)
        status_code = 0
        while len(results) < target:
            payload = _build_responses_payload(request)
            payloads.append(payload)
            status_code, response = _post_json(endpoint, payload, api_key, self.timeout_s)
            responses.append(response)
            image_blobs = _extract_response_images(response)
            if not image_blobs:
                raise RuntimeError("OpenAI Responses API returned no image data.")
            for image_blob in image_blobs:
                if len(results) >= target:
                    break
                image_path = _build_image_path(request.out_dir, len(results), request.output_format, stamp)
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
        return ProviderResponse(
            results=results,
            provider_request={"endpoint": endpoint, "payloads": payloads},
            provider_response=provider_response,
            warnings=warnings,
        )


def _get_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")


def _build_images_payload(request: ImageRequest) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": request.model or "gpt-image-1",
        "prompt": request.prompt,
        "n": max(int(request.n), 1),
        "size": request.size,
    }
    if request.seed is not None:
        payload["seed"] = request.seed
    if request.output_format:
        payload["output_format"] = request.output_format
    if request.background:
        payload["background"] = request.background
    if request.user:
        payload["user"] = request.user
    _merge_provider_options(payload, request.provider_options)
    return payload


def _build_responses_payload(request: ImageRequest) -> dict[str, Any]:
    model = _responses_model(request)
    tool: dict[str, Any] = {"type": "image_generation"}
    if request.size:
        tool["size"] = request.size
    if request.background:
        tool["background"] = request.background
    if request.output_format:
        tool["format"] = request.output_format
    if request.seed is not None:
        tool["seed"] = request.seed
    if request.model:
        tool["model"] = request.model
    _merge_provider_options(tool, request.provider_options)
    payload = {
        "model": model,
        "input": request.prompt,
        "tools": [tool],
        "tool_choice": {"type": "image_generation"},
    }
    return payload


def _responses_model(request: ImageRequest) -> str:
    options = request.provider_options
    if isinstance(options, Mapping):
        responses_model = options.get("responses_model")
        if isinstance(responses_model, str) and responses_model.strip():
            return responses_model
    env_model = os.getenv("OPENAI_RESPONSES_MODEL")
    if env_model:
        return env_model
    return "gpt-4o-mini"


def _merge_provider_options(target: dict[str, Any], options: Mapping[str, Any]) -> None:
    for key, value in options.items():
        if key in target:
            continue
        target[key] = value


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


def _write_image_items(
    items: Iterable[Mapping[str, Any]],
    request: ImageRequest,
    stamp: int,
    width: int | None,
    height: int | None,
) -> list[GeneratedArtifact]:
    results: list[GeneratedArtifact] = []
    for idx, item in enumerate(items):
        image_bytes = _extract_image_bytes(item)
        image_path = _build_image_path(request.out_dir, idx, request.output_format, stamp)
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


def fetch_reasoning_summary(
    prompt: str,
    model: str,
    *,
    effort: str = "low",
    summary: str = "auto",
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
