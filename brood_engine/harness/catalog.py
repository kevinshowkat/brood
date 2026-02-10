"""Model capability catalog for image harness runs.

This catalog is intentionally descriptive (not prescriptive). Providers can and
do change their supported params; this is meant to reflect what Brood currently
implements + any operator-supplied overrides.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping, Sequence

from ..models.registry import ModelRegistry, ModelSpec


@dataclass(frozen=True)
class ModelApiSpec:
    operations: tuple[str, ...] = ("generate",)
    supports_init_image: bool = False
    supports_mask: bool = False
    supports_reference_images: bool = False
    supported_output_formats: tuple[str, ...] = ("png", "jpeg", "webp")
    size_notes: str | None = None
    provider_options: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class CatalogEntry:
    provider: str
    model: str
    capabilities: tuple[str, ...] = ()
    context_window: int | None = None
    pricing_key: str | None = None
    api: ModelApiSpec = field(default_factory=ModelApiSpec)
    aliases: tuple[str, ...] = ()


def build_default_catalog() -> dict[tuple[str, str], CatalogEntry]:
    """Return the built-in catalog derived from `ModelRegistry` plus provider heuristics."""

    registry = ModelRegistry()
    out: dict[tuple[str, str], CatalogEntry] = {}
    for spec in registry.list():
        if not isinstance(spec, ModelSpec):
            continue
        api = _default_api_for(spec)
        entry = CatalogEntry(
            provider=spec.provider,
            model=spec.name,
            capabilities=tuple(spec.capabilities),
            context_window=spec.context_window,
            pricing_key=spec.pricing_key,
            api=api,
            aliases=tuple(_default_aliases(spec)),
        )
        out[(entry.provider, entry.model)] = entry
    return out


def load_catalog_overrides(paths: Sequence[str | Path] | None) -> dict[tuple[str, str], CatalogEntry]:
    """Load operator-supplied overrides.

    Schema (minimal):
    {
      "schema_version": 1,
      "models": [
        {
          "provider": "stability",
          "model": "sd3-large",
          "capabilities": ["image", "edit"],
          "pricing_key": "stability-sd3-large",
          "api": {
            "operations": ["generate", "edit", "upscale"],
            "supports_init_image": true,
            "supports_mask": true,
            "supports_reference_images": false,
            "supported_output_formats": ["png", "jpeg"],
            "size_notes": "supports 512-2048; multiples of 64",
            "provider_options": {"cfg_scale": "float"}
          },
          "aliases": ["Stability SD3 Large"]
        }
      ]
    }
    """

    if not paths:
        return {}
    overrides: dict[tuple[str, str], CatalogEntry] = {}
    for raw_path in paths:
        path = Path(raw_path).expanduser()
        if not path.exists():
            continue
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        models = payload.get("models")
        if not isinstance(models, list):
            continue
        for item in models:
            if not isinstance(item, dict):
                continue
            provider = str(item.get("provider") or "").strip()
            model = str(item.get("model") or "").strip()
            if not provider or not model:
                continue
            capabilities = item.get("capabilities") or ()
            if isinstance(capabilities, list):
                capabilities_tuple = tuple(str(v) for v in capabilities if v)
            elif isinstance(capabilities, tuple):
                capabilities_tuple = tuple(str(v) for v in capabilities if v)
            else:
                capabilities_tuple = ()
            pricing_key = item.get("pricing_key")
            pricing_key = str(pricing_key).strip() if isinstance(pricing_key, str) and pricing_key.strip() else None

            aliases_raw = item.get("aliases") or ()
            if isinstance(aliases_raw, list):
                aliases = tuple(str(v) for v in aliases_raw if v)
            elif isinstance(aliases_raw, tuple):
                aliases = tuple(str(v) for v in aliases_raw if v)
            else:
                aliases = ()

            api_payload = item.get("api") if isinstance(item.get("api"), dict) else {}
            api = _parse_api_spec(api_payload)

            overrides[(provider, model)] = CatalogEntry(
                provider=provider,
                model=model,
                capabilities=capabilities_tuple,
                context_window=None,
                pricing_key=pricing_key,
                api=api,
                aliases=aliases,
            )
    return overrides


def merged_catalog(extra_paths: Sequence[str | Path] | None = None) -> dict[tuple[str, str], CatalogEntry]:
    """Return default catalog merged with operator overrides (last write wins)."""

    base = build_default_catalog()
    base.update(load_catalog_overrides(extra_paths))
    return base


def _parse_api_spec(payload: Mapping[str, Any]) -> ModelApiSpec:
    ops = payload.get("operations") or ("generate",)
    if isinstance(ops, list):
        operations = tuple(str(v) for v in ops if v)
    elif isinstance(ops, tuple):
        operations = tuple(str(v) for v in ops if v)
    else:
        operations = ("generate",)

    formats = payload.get("supported_output_formats") or ("png", "jpeg", "webp")
    if isinstance(formats, list):
        supported_output_formats = tuple(str(v) for v in formats if v)
    elif isinstance(formats, tuple):
        supported_output_formats = tuple(str(v) for v in formats if v)
    else:
        supported_output_formats = ("png", "jpeg", "webp")

    provider_options_raw = payload.get("provider_options") if isinstance(payload.get("provider_options"), dict) else {}
    provider_options: dict[str, str] = {}
    for key, value in provider_options_raw.items():
        if not key:
            continue
        provider_options[str(key)] = str(value) if value is not None else ""

    return ModelApiSpec(
        operations=operations or ("generate",),
        supports_init_image=bool(payload.get("supports_init_image")),
        supports_mask=bool(payload.get("supports_mask")),
        supports_reference_images=bool(payload.get("supports_reference_images")),
        supported_output_formats=supported_output_formats or ("png", "jpeg", "webp"),
        size_notes=str(payload.get("size_notes")) if payload.get("size_notes") is not None else None,
        provider_options=provider_options,
    )


def _default_api_for(spec: ModelSpec) -> ModelApiSpec:
    provider = (spec.provider or "").lower()
    capabilities = set(spec.capabilities or ())

    # Default to "generate" unless we know Brood passes image inputs to the provider.
    operations = ["generate"]
    supports_init_image = False
    supports_reference_images = False
    supports_mask = False
    size_notes = None
    supported_output_formats = ("png", "jpeg", "webp")
    provider_options: dict[str, str] = {}

    if provider == "gemini":
        # Brood uses google-genai chat parts which support inline images.
        supports_init_image = True
        supports_reference_images = True
        operations = ["generate", "edit"]
        size_notes = "size: 1K/2K/4K (via provider_options.image_size); aspect_ratio snapped to nearest supported ratio"
        provider_options = {
            "image_size": "1K|2K|4K (Google tier hint)",
            "aspect_ratio": "1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9",
            "safety_settings": "list[SafetySetting] (defaults HarmBlockThreshold=OFF)",
        }
    elif provider == "imagen":
        size_notes = "size: 1K/2K/4K (via provider_options.image_size); Imagen forbids 4:5 (snaps to 3:4)"
        provider_options = {
            "image_size": "1K|2K|4K (Google tier hint)",
            "aspect_ratio": "same as Gemini (4:5 snaps)",
            "add_watermark": "bool (seed ignored when true)",
            "person_generation": "string|enum (Imagen setting)",
        }
    elif provider == "flux":
        size_notes = "size snapped to multiples of 16; presets: square/portrait/landscape"
        provider_options = {
            "endpoint": "flux-2-flex|flux-2-pro|... or full URL",
            "poll_interval": "seconds (default 0.5)",
            "poll_timeout": "seconds (default 120)",
            "request_timeout": "seconds (default 30)",
            "download_timeout": "seconds (default 60)",
        }
    elif provider == "openai":
        # Brood currently implements images/generations and responses tool, not images/edits.
        size_notes = "size: '1024x1024'|'portrait'|'landscape'|'square' or WxH; edits not implemented"
        provider_options = {
            "responses_model": "Responses API backing model when OPENAI_IMAGE_USE_RESPONSES=1",
        }
        supported_output_formats = ("png", "jpeg", "webp")
    elif provider == "dryrun":
        size_notes = "offline placeholder; supports WxH and portrait/landscape/square presets"

    if "edit" in capabilities and "edit" not in operations:
        operations.append("edit")
    return ModelApiSpec(
        operations=tuple(operations),
        supports_init_image=supports_init_image,
        supports_mask=supports_mask,
        supports_reference_images=supports_reference_images,
        supported_output_formats=supported_output_formats,
        size_notes=size_notes,
        provider_options=provider_options,
    )


def _default_aliases(spec: ModelSpec) -> list[str]:
    # Keep this small and tasteful: operators can extend via catalog overrides.
    aliases: list[str] = []
    if spec.provider == "gemini" and spec.name == "gemini-2.5-flash-image":
        aliases.append("Gemini 2.5 Flash Image")
    if spec.provider == "gemini" and spec.name == "gemini-3-pro-image-preview":
        aliases.append("Gemini 3 Pro Image Preview")
    if spec.provider == "openai" and spec.name == "gpt-image-1":
        aliases.append("GPT Image 1")
    if spec.provider == "imagen" and spec.name == "imagen-4.0-ultra":
        aliases.append("Imagen 4 Ultra")
    return aliases

