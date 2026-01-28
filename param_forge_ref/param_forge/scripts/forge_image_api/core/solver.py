"""Resolve provider-specific parameters from a normalized request."""

from __future__ import annotations

import math
import re
from dataclasses import replace
from typing import Any, Dict, List, Optional, Tuple

from .contracts import ImageRequest, ResolvedRequest
from .capabilities import get_capabilities


_DIM_RE = re.compile(r"^\s*(\d+)\s*[xX]\s*(\d+)\s*$")
_RATIO_RE = re.compile(r"^\s*(\d+)\s*[:/]\s*(\d+)\s*$")

_OPENAI_SIZES = {
    "1024x1024": (1024, 1024),
    "1536x1024": (1536, 1024),
    "1024x1536": (1024, 1536),
}

_GEMINI_RATIOS = {
    "1:1": 1.0,
    "2:3": 2.0 / 3.0,
    "3:2": 3.0 / 2.0,
    "3:4": 3.0 / 4.0,
    "4:3": 4.0 / 3.0,
    "4:5": 4.0 / 5.0,
    "5:4": 5.0 / 4.0,
    "9:16": 9.0 / 16.0,
    "16:9": 16.0 / 9.0,
    "21:9": 21.0 / 9.0,
}


def _parse_dims(value: str) -> Optional[Tuple[int, int]]:
    if not value:
        return None
    match = _DIM_RE.match(value)
    if not match:
        return None
    w = int(match.group(1))
    h = int(match.group(2))
    if w <= 0 or h <= 0:
        return None
    return w, h


def _parse_ratio(value: str) -> Optional[Tuple[int, int]]:
    if not value:
        return None
    match = _RATIO_RE.match(value)
    if not match:
        return None
    w = int(match.group(1))
    h = int(match.group(2))
    if w <= 0 or h <= 0:
        return None
    return w, h


def _normalize_format(value: Optional[str], default: Optional[str]) -> Optional[str]:
    if not value:
        return default
    lowered = value.strip().lower()
    if lowered.startswith("image/"):
        lowered = lowered.split("/", 1)[1]
    if lowered in {"jpg", "jpeg"}:
        return "jpeg"
    if lowered in {"png", "webp"}:
        return lowered
    return default


def _provider_default_output_format(provider: str, model: Optional[str]) -> str:
    provider_key = provider.strip().lower()
    if provider_key == "openai":
        return "png"
    if provider_key == "gemini":
        return "png"
    if provider_key == "imagen":
        return "png"
    if provider_key == "flux":
        return "jpeg"
    return "png"


def _choose_openai_size(size: str, warnings: List[str]) -> Tuple[str, Optional[int], Optional[int]]:
    if not size:
        return "1024x1024", 1024, 1024
    normalized = size.strip().lower()
    if normalized in {"auto", "default"}:
        return "auto", None, None
    if normalized in {"portrait", "tall"}:
        return "1024x1536", 1024, 1536
    if normalized in {"landscape", "wide"}:
        return "1536x1024", 1536, 1024
    if normalized in {"square", "1:1"}:
        return "1024x1024", 1024, 1024

    dims = _parse_dims(normalized)
    if dims:
        size_key = f"{dims[0]}x{dims[1]}"
        if size_key in _OPENAI_SIZES:
            return size_key, dims[0], dims[1]
        target_ratio = dims[0] / dims[1]
    else:
        ratio = _parse_ratio(normalized)
        if ratio:
            target_ratio = ratio[0] / ratio[1]
        else:
            return "1024x1024", 1024, 1024

    best_key = "1024x1024"
    best_delta = float("inf")
    for key, (w, h) in _OPENAI_SIZES.items():
        delta = abs((w / h) - target_ratio)
        if delta < best_delta:
            best_delta = delta
            best_key = key
    warnings.append(f"OpenAI size snapped to {best_key}.")
    w, h = _OPENAI_SIZES[best_key]
    return best_key, w, h


def _nearest_gemini_ratio(size: str, warnings: List[str]) -> Optional[str]:
    if not size:
        return None
    normalized = size.strip().lower()
    if normalized in {"portrait", "tall"}:
        return "9:16"
    if normalized in {"landscape", "wide"}:
        return "16:9"
    if normalized in {"square", "1:1"}:
        return "1:1"
    if _RATIO_RE.match(normalized):
        ratio = _parse_ratio(normalized)
        if ratio:
            candidate = f"{ratio[0]}:{ratio[1]}"
            if candidate in _GEMINI_RATIOS:
                return candidate
            target_ratio = ratio[0] / ratio[1]
        else:
            return None
    else:
        dims = _parse_dims(normalized)
        if not dims:
            return None
        target_ratio = dims[0] / dims[1]

    best_key, best_delta = None, float("inf")
    for key, val in _GEMINI_RATIOS.items():
        delta = abs(val - target_ratio)
        if delta < best_delta:
            best_key, best_delta = key, delta
    if best_key and best_key not in {normalized}:
        warnings.append(f"Gemini aspect ratio snapped to {best_key}.")
    return best_key


def _resolve_image_size_hint(size: str | None) -> str:
    if not size:
        return "2K"
    normalized = size.strip().lower()
    if normalized in {"1k", "2k", "4k"}:
        return normalized.upper()
    dims = _parse_dims(normalized)
    if dims:
        longest = max(dims)
        if longest >= 3600:
            return "4K"
        if longest >= 1800:
            return "2K"
        return "1K"
    return "2K"


def _snap_multiple(value: int, multiple: int) -> int:
    return int(round(value / multiple) * multiple)


def _resolve_flux_dims(size: str, warnings: List[str]) -> Tuple[int, int]:
    dims = _parse_dims(size)
    if dims:
        w, h = dims
    else:
        ratio = _parse_ratio(size)
        if ratio:
            base = 1024
            w = int(base * (ratio[0] / ratio[1]))
            h = base
            if w < h:
                w, h = h, w
        elif size.strip().lower() in {"portrait", "tall"}:
            w, h = 1024, 1536
        elif size.strip().lower() in {"landscape", "wide"}:
            w, h = 1536, 1024
        else:
            w, h = 1024, 1024
    snapped_w = _snap_multiple(w, 16)
    snapped_h = _snap_multiple(h, 16)
    if (snapped_w, snapped_h) != (w, h):
        warnings.append(f"FLUX size snapped to {snapped_w}x{snapped_h} (multiples of 16).")
    return snapped_w, snapped_h


def resolve_request(request: ImageRequest, provider: str) -> ResolvedRequest:
    warnings: List[str] = []
    provider = provider.strip().lower()
    caps = get_capabilities(provider)

    requested_format = _normalize_format(request.output_format, None)
    output_format = requested_format or _provider_default_output_format(provider, request.model)
    model = request.model or request.provider_options.get("model") if request.provider_options else request.model

    if provider == "openai":
        size_value, width, height = _choose_openai_size(request.size, warnings)
        provider_params: Dict[str, Any] = {
            "size": size_value,
            "quality": request.provider_options.get("quality", "high") if request.provider_options else "high",
            "moderation": request.provider_options.get("moderation", "low") if request.provider_options else "low",
        }
        if request.provider_options:
            for key in ("input_fidelity", "output_compression"):
                if key in request.provider_options:
                    provider_params[key] = request.provider_options[key]
        return ResolvedRequest(
            provider=provider,
            model=model or "gpt-image-1.5",
            size=size_value,
            width=width,
            height=height,
            output_format=output_format,
            background=request.background,
            seed=request.seed,
            n=request.n,
            user=request.user,
            prompt=request.prompt,
            inputs=request.inputs,
            stream=request.stream and caps.supports_stream,
            partial_images=request.partial_images,
            provider_params=provider_params,
            warnings=warnings,
        )

    if provider == "gemini":
        ratio = _nearest_gemini_ratio(request.size, warnings)
        image_size = None
        if request.provider_options and request.provider_options.get("image_size"):
            image_size = _resolve_image_size_hint(str(request.provider_options.get("image_size")))
        if image_size is None:
            image_size = _resolve_image_size_hint(request.size)
        provider_params = {
            "aspect_ratio": ratio,
            "image_size": image_size,
        }
        return ResolvedRequest(
            provider=provider,
            model=model or "gemini-2.5-flash-image",
            size=request.size,
            width=None,
            height=None,
            output_format=output_format,
            background=request.background,
            seed=request.seed,
            n=request.n,
            user=request.user,
            prompt=request.prompt,
            inputs=request.inputs,
            stream=False,
            partial_images=None,
            provider_params=provider_params,
            warnings=warnings,
        )

    if provider == "imagen":
        ratio = _nearest_gemini_ratio(request.size, warnings)
        if ratio == "4:5":
            warnings.append("Imagen does not support 4:5; using 3:4 instead.")
            ratio = "3:4"
        image_size = _resolve_image_size_hint(request.size)
        add_watermark = True
        if request.provider_options and request.provider_options.get("add_watermark") is not None:
            add_watermark = bool(request.provider_options.get("add_watermark"))
        seed = request.seed
        if seed is not None and add_watermark:
            warnings.append("Imagen seed ignored because add_watermark=true.")
            seed = None
        provider_params = {
            "image_size": image_size,
            "aspect_ratio": ratio,
            "add_watermark": add_watermark,
        }
        if request.provider_options:
            if "person_generation" in request.provider_options:
                provider_params["person_generation"] = request.provider_options["person_generation"]
        return ResolvedRequest(
            provider=provider,
            model=model or "imagen-4.0-ultra",
            size=request.size,
            width=None,
            height=None,
            output_format=output_format,
            background=request.background,
            seed=seed,
            n=request.n,
            user=request.user,
            prompt=request.prompt,
            inputs=request.inputs,
            stream=False,
            partial_images=None,
            provider_params=provider_params,
            warnings=warnings,
        )

    if provider == "flux":
        width, height = _resolve_flux_dims(request.size, warnings)
        provider_params = {
            "width": width,
            "height": height,
        }
        if request.output_format:
            provider_params["output_format"] = output_format
        if request.seed is not None:
            provider_params["seed"] = request.seed
        flux_model = model
        if not flux_model and request.provider_options:
            flux_model = request.provider_options.get("model")
        if not flux_model:
            flux_model = "flux-2-flex"
        if str(flux_model).strip().lower() == "flux-2":
            warnings.append("Flux model flux-2 is deprecated; using flux-2-flex.")
            flux_model = "flux-2-flex"
        return ResolvedRequest(
            provider=provider,
            model=flux_model,
            size=f"{width}x{height}",
            width=width,
            height=height,
            output_format=output_format,
            background=request.background,
            seed=request.seed,
            n=request.n,
            user=request.user,
            prompt=request.prompt,
            inputs=request.inputs,
            stream=request.stream,
            partial_images=None,
            provider_params=provider_params,
            warnings=warnings,
        )

    raise ValueError(f"Unsupported provider: {provider}")
