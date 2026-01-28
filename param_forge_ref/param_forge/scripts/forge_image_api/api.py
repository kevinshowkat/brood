"""Public API for PARAM FORGE."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
import time
import uuid
from typing import Iterable, Iterator, List, Optional

from forge_image_api.core.contracts import ImageEvent, ImageInputs, ImageRequest, ImageResult
from forge_image_api.core.receipts import build_receipt, write_receipt
from forge_image_api.core.router import resolve_provider
from forge_image_api.core.solver import resolve_request
from forge_image_api.core.utils import ensure_out_dir, utc_timestamp
from forge_image_api.core.streaming import wrap_final_results
from forge_image_api.providers import get_adapter
from forge_image_api.providers.base import ProviderImage, ProviderResponse, ProviderStreamEvent


def _extension_from_mime(mime_type: Optional[str], fallback: str) -> str:
    if mime_type:
        mime = mime_type.lower()
        if mime.endswith("/jpeg") or mime.endswith("/jpg"):
            return "jpg"
        if mime.endswith("/png"):
            return "png"
        if mime.endswith("/webp"):
            return "webp"
        if "/" in mime:
            return mime.split("/", 1)[1]
    if fallback == "jpeg":
        return "jpg"
    return fallback


def _write_image(out_dir: Path, provider: str, index: int, image: ProviderImage, output_format: str, stamp: str) -> Path:
    ext = _extension_from_mime(image.mime_type, output_format)
    filename = f"{provider}-{stamp}-{index:02d}.{ext}"
    path = out_dir / filename
    path.write_bytes(image.image_bytes)
    return path


def _utc_iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _unique_stamp() -> str:
    return f"{utc_timestamp()}-{uuid.uuid4().hex[:6]}"


def _finalize_results(
    *,
    request: ImageRequest,
    resolved_provider: str,
    resolved,
    provider_response,
    out_dir: Path,
    stamp: str,
    render_seconds: Optional[float] = None,
    render_started_at: Optional[str] = None,
    render_completed_at: Optional[str] = None,
) -> List[ImageResult]:
    results: List[ImageResult] = []
    for idx, image in enumerate(provider_response.images):
        image_path = _write_image(out_dir, resolved_provider, idx, image, resolved.output_format, stamp)
        receipt_path = out_dir / f"receipt-{resolved_provider}-{stamp}-{idx:02d}.json"
        result_metadata = {
            "provider_metadata": image.metadata,
            "provider_request_id": image.provider_request_id,
        }
        if render_seconds is not None:
            result_metadata["render_seconds"] = float(render_seconds)
        if render_started_at is not None:
            result_metadata["render_started_at"] = render_started_at
        if render_completed_at is not None:
            result_metadata["render_completed_at"] = render_completed_at
        receipt_payload = build_receipt(
            request=request,
            resolved=resolved,
            provider_request=provider_response.raw_request,
            provider_response=provider_response.raw_response,
            warnings=list(resolved.warnings),
            image_path=image_path,
            receipt_path=receipt_path,
            result_metadata=result_metadata,
        )
        write_receipt(receipt_path, receipt_payload)
        results.append(
            ImageResult(
                image_path=image_path,
                receipt_path=receipt_path,
                provider=resolved_provider,
                model=provider_response.model,
                provider_request_id=image.provider_request_id,
                width=image.width,
                height=image.height,
                seed=image.seed,
                usage=provider_response.usage,
                metadata=image.metadata,
            )
        )
    return results


def generate(
    *,
    prompt: str,
    size: str = "1024x1024",
    n: int = 1,
    seed: Optional[int] = None,
    output_format: Optional[str] = None,
    background: Optional[str] = None,
    provider: Optional[str] = None,
    provider_options: Optional[dict] = None,
    out_dir: Optional[str | Path] = None,
    user: Optional[str] = None,
    model: Optional[str] = None,
) -> List[ImageResult]:
    request = ImageRequest(
        prompt=prompt,
        mode="generate",
        size=size,
        n=n,
        seed=seed,
        output_format=output_format,
        background=background,
        provider=provider,
        provider_options=provider_options or {},
        user=user,
        out_dir=Path(out_dir) if out_dir else None,
        model=model,
    )
    resolved_provider = resolve_provider(provider)
    out_path = ensure_out_dir(request.out_dir)
    request.out_dir = out_path
    resolved = resolve_request(request, resolved_provider)
    adapter = get_adapter(resolved_provider)
    started_at = datetime.now(timezone.utc)
    started_monotonic = time.monotonic()
    response = adapter.generate(request, resolved)
    elapsed = time.monotonic() - started_monotonic
    completed_at = datetime.now(timezone.utc)
    stamp = _unique_stamp()
    return _finalize_results(
        request=request,
        resolved_provider=resolved_provider,
        resolved=resolved,
        provider_response=response,
        out_dir=out_path,
        stamp=stamp,
        render_seconds=elapsed,
        render_started_at=_utc_iso(started_at),
        render_completed_at=_utc_iso(completed_at),
    )


def edit(
    *,
    prompt: str,
    init_image,
    mask: Optional[object] = None,
    size: str = "1024x1024",
    n: int = 1,
    seed: Optional[int] = None,
    output_format: Optional[str] = None,
    background: Optional[str] = None,
    provider: Optional[str] = None,
    provider_options: Optional[dict] = None,
    out_dir: Optional[str | Path] = None,
    user: Optional[str] = None,
    model: Optional[str] = None,
) -> List[ImageResult]:
    inputs = ImageInputs(init_image=init_image, mask=mask)
    request = ImageRequest(
        prompt=prompt,
        mode="edit",
        size=size,
        n=n,
        seed=seed,
        output_format=output_format,
        background=background,
        inputs=inputs,
        provider=provider,
        provider_options=provider_options or {},
        user=user,
        out_dir=Path(out_dir) if out_dir else None,
        model=model,
    )
    resolved_provider = resolve_provider(provider)
    out_path = ensure_out_dir(request.out_dir)
    request.out_dir = out_path
    resolved = resolve_request(request, resolved_provider)
    adapter = get_adapter(resolved_provider)
    started_at = datetime.now(timezone.utc)
    started_monotonic = time.monotonic()
    response = adapter.generate(request, resolved)
    elapsed = time.monotonic() - started_monotonic
    completed_at = datetime.now(timezone.utc)
    stamp = _unique_stamp()
    return _finalize_results(
        request=request,
        resolved_provider=resolved_provider,
        resolved=resolved,
        provider_response=response,
        out_dir=out_path,
        stamp=stamp,
        render_seconds=elapsed,
        render_started_at=_utc_iso(started_at),
        render_completed_at=_utc_iso(completed_at),
    )


def stream(
    *,
    prompt: str,
    size: str = "1024x1024",
    n: int = 1,
    seed: Optional[int] = None,
    output_format: Optional[str] = None,
    background: Optional[str] = None,
    provider: Optional[str] = None,
    provider_options: Optional[dict] = None,
    out_dir: Optional[str | Path] = None,
    user: Optional[str] = None,
    model: Optional[str] = None,
    partial_images: Optional[int] = None,
) -> Iterator[ImageEvent]:
    request = ImageRequest(
        prompt=prompt,
        mode="generate",
        size=size,
        n=n,
        seed=seed,
        output_format=output_format,
        background=background,
        provider=provider,
        provider_options=provider_options or {},
        user=user,
        out_dir=Path(out_dir) if out_dir else None,
        stream=True,
        partial_images=partial_images,
        model=model,
    )
    resolved_provider = resolve_provider(provider)
    out_path = ensure_out_dir(request.out_dir)
    request.out_dir = out_path
    resolved = resolve_request(request, resolved_provider)
    adapter = get_adapter(resolved_provider)
    stamp = _unique_stamp()

    if resolved.stream:
        started_at = datetime.now(timezone.utc)
        started_monotonic = time.monotonic()
        for event in adapter.stream(request, resolved):
            if event.type == "partial" and event.image_bytes is not None:
                yield ImageEvent(type="partial", index=event.index, image_bytes=event.image_bytes)
            elif event.type == "log":
                yield ImageEvent(type="log", index=event.index, message=event.message, data=event.data)
            elif event.type == "error":
                yield ImageEvent(type="error", index=event.index, message=event.message)
                return
            elif event.type == "final" and event.image is not None:
                elapsed = time.monotonic() - started_monotonic
                completed_at = datetime.now(timezone.utc)
                provider_response = ProviderResponse(
                    images=[event.image],
                    model=resolved.model,
                    usage=event.image.metadata.get("usage") if event.image.metadata else None,
                    raw_request={},
                    raw_response={},
                    warnings=resolved.warnings,
                )
                results = _finalize_results(
                    request=request,
                    resolved_provider=resolved_provider,
                    resolved=resolved,
                    provider_response=provider_response,
                    out_dir=out_path,
                    stamp=stamp,
                    render_seconds=elapsed,
                    render_started_at=_utc_iso(started_at),
                    render_completed_at=_utc_iso(completed_at),
                )
                if results:
                    yield ImageEvent(type="final", index=event.index, result=results[0])
        return

    results = generate(
        prompt=prompt,
        size=size,
        n=n,
        seed=seed,
        output_format=output_format,
        background=background,
        provider=provider,
        provider_options=provider_options,
        out_dir=out_dir,
        user=user,
        model=model,
    )
    yield from wrap_final_results(results)
