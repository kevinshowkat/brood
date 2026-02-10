"""Multi-provider image harness runner.

The harness runs multi-step pipelines against one or more input images, writing:
- `harness_manifest.json` (portable summary for UIs)
- `telemetry.jsonl` (append-only detailed events)
- per-step receipts + images under `variants/<variant_id>/...`

This is intentionally "engine-adjacent" instead of driving the interactive CLI,
so it can be used in batch runs and extended with new providers/models.
"""

from __future__ import annotations

import importlib
import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence

from PIL import Image

from ..models.registry import ModelRegistry
from ..pricing.estimator import PricingEstimator
from ..providers import default_registry
from ..providers.base import ProviderRegistry
from ..runs.events import EventWriter
from ..runs.receipts import ImageInputs, ImageRequest, ResolvedRequest, build_receipt, write_receipt
from ..utils import now_utc_iso
from .catalog import CatalogEntry, merged_catalog


HARNESS_SCHEMA = "brood.image_harness"
HARNESS_SCHEMA_VERSION = 1


@dataclass(frozen=True)
class HarnessRunResult:
    manifest_path: Path
    run_dir: Path
    run_id: str


def run_harness(
    *,
    out_dir: str | Path,
    task: Mapping[str, Any],
    inputs: Sequence[str | Path],
    pipelines: Sequence[Mapping[str, Any]],
    catalog_paths: Sequence[str | Path] | None = None,
    provider_plugins: Sequence[str] | None = None,
) -> HarnessRunResult:
    run_dir = Path(out_dir).expanduser()
    run_dir.mkdir(parents=True, exist_ok=True)
    run_id = str(uuid.uuid4())
    events_path = run_dir / "telemetry.jsonl"
    events = EventWriter(events_path, run_id)

    catalog = merged_catalog(catalog_paths)
    pricing = PricingEstimator()
    registry = _build_provider_registry(provider_plugins)

    input_items = [_normalize_input_path(p) for p in inputs]
    inputs_meta = []
    for p in input_items:
        w, h = _image_dims(p)
        inputs_meta.append(
            {
                "input_id": f"i{len(inputs_meta)+1:02d}",
                "path": str(p),
                "width": w,
                "height": h,
            }
        )

    events.emit("harness_started", schema=HARNESS_SCHEMA, schema_version=HARNESS_SCHEMA_VERSION, task=dict(task))

    variants_out = []
    for pipeline in pipelines:
        variant_id = str(pipeline.get("id") or pipeline.get("name") or "").strip() or f"variant-{len(variants_out)+1}"
        variant_label = str(pipeline.get("label") or variant_id)
        steps = pipeline.get("steps") if isinstance(pipeline.get("steps"), list) else []
        variant_dir = run_dir / "variants" / _safe_slug(variant_id)
        variant_dir.mkdir(parents=True, exist_ok=True)

        events.emit("variant_started", variant_id=variant_id, label=variant_label)
        variant_results = []
        variant_cost_total = 0.0
        variant_cost_complete = True
        variant_latency_total_s = 0.0

        for idx, input_meta in enumerate(inputs_meta):
            input_path = Path(input_meta["path"])
            sample_id = input_meta["input_id"]
            sample_dir = variant_dir / sample_id
            sample_dir.mkdir(parents=True, exist_ok=True)

            cur_path = input_path
            cur_meta = {"width": input_meta["width"], "height": input_meta["height"]}
            receipts = []
            step_summaries = []

            events.emit("sample_started", variant_id=variant_id, sample_id=sample_id, input_path=str(input_path))
            for step_idx, step in enumerate(steps, start=1):
                if not isinstance(step, Mapping):
                    continue
                step_type = str(step.get("type") or "").strip()
                step_dir = sample_dir / f"step-{step_idx:02d}-{_safe_slug(step_type or 'step')}"
                step_dir.mkdir(parents=True, exist_ok=True)

                events.emit(
                    "step_started",
                    variant_id=variant_id,
                    sample_id=sample_id,
                    step_index=step_idx,
                    step_type=step_type,
                    input_path=str(cur_path),
                )
                step_started = time.monotonic()
                cost_usd: float | None = None
                usage = None
                output_paths: list[str] = []
                warnings: list[str] = []

                if step_type in {"local_resize", "resize"}:
                    out_fmt = str(step.get("format") or step.get("output_format") or "jpeg").lower()
                    quality = int(step.get("quality") or 84)
                    max_dim = int(step.get("max_dim_px") or 1024)
                    out_path = step_dir / f"resized.{_ext_for_format(out_fmt)}"
                    cur_path, new_meta = _local_resize_and_encode(
                        cur_path,
                        out_path,
                        max_dim_px=max_dim,
                        output_format=out_fmt,
                        quality=quality,
                    )
                    cur_meta = new_meta
                    output_paths = [str(cur_path)]
                    cost_usd = 0.0
                elif step_type in {"local_reencode", "reencode"}:
                    out_fmt = str(step.get("format") or step.get("output_format") or "jpeg").lower()
                    quality = int(step.get("quality") or 84)
                    out_path = step_dir / f"reencoded.{_ext_for_format(out_fmt)}"
                    cur_path = _local_reencode(cur_path, out_path, output_format=out_fmt, quality=quality)
                    w, h = _image_dims(cur_path)
                    cur_meta = {"width": w, "height": h}
                    output_paths = [str(cur_path)]
                    cost_usd = 0.0
                elif step_type in {"model", "provider"}:
                    provider_name = str(step.get("provider") or "").strip()
                    model_name = str(step.get("model") or "").strip() or None
                    prompt = _render_prompt_template(str(step.get("prompt") or ""), task)
                    size = str(step.get("size") or "") or None
                    n_images = int(step.get("n") or 1)
                    seed = step.get("seed")
                    seed_val = int(seed) if isinstance(seed, int) or (isinstance(seed, str) and seed.isdigit()) else None
                    output_format = str(step.get("output_format") or step.get("format") or "png") or None
                    provider_options = step.get("provider_options") if isinstance(step.get("provider_options"), Mapping) else {}

                    inputs_spec = step.get("inputs") if isinstance(step.get("inputs"), Mapping) else {}
                    use_init_image = bool(inputs_spec.get("init_image", True))
                    init_image = str(cur_path) if use_init_image else None
                    reference_images = inputs_spec.get("reference_images")
                    refs: list[str] = []
                    if isinstance(reference_images, list):
                        refs = [str(v) for v in reference_images if v]
                    elif isinstance(reference_images, (str, Path)):
                        refs = [str(reference_images)]

                    provider = registry.get(provider_name) if provider_name else None
                    if not provider:
                        raise RuntimeError(f"Unknown provider '{provider_name}' in pipeline '{variant_id}'.")

                    request = ImageRequest(
                        prompt=prompt,
                        size=size or _dims_to_size_hint(cur_meta.get("width"), cur_meta.get("height")),
                        n=max(1, n_images),
                        seed=seed_val,
                        output_format=output_format,
                        provider=provider_name,
                        provider_options=dict(provider_options),
                        inputs=ImageInputs(init_image=init_image, reference_images=refs),
                        out_dir=str(step_dir),
                        model=model_name,
                    )

                    pricing_key = _resolve_pricing_key(step, provider_name, model_name, catalog)
                    cost_est = pricing.estimate_image_cost_with_params(
                        pricing_key,
                        size=request.size,
                        provider_options=request.provider_options,
                    )
                    if cost_est.cost_per_image_usd is not None:
                        cost_usd = cost_est.cost_per_image_usd * max(1, n_images)

                    response = provider.generate(request)
                    warnings = list(response.warnings or [])
                    usage = _extract_usage_hint(response.provider_response)

                    results = list(response.results or [])
                    if not results:
                        raise RuntimeError(f"Provider '{provider_name}' returned no images.")

                    # Promote the first artifact as the next step's input.
                    primary = results[0]
                    cur_path = Path(primary.image_path)
                    w = primary.width
                    h = primary.height
                    if w is None or h is None:
                        w, h = _image_dims(cur_path)
                    cur_meta = {"width": w, "height": h}
                    output_paths = [str(Path(r.image_path)) for r in results]

                    receipts_for_step = _write_step_receipts(
                        step_dir=step_dir,
                        request=request,
                        provider_name=provider_name,
                        model_name=model_name,
                        size=request.size,
                        provider_options=request.provider_options,
                        response=response,
                        latency_s=0.0,  # filled below
                        cost_total_usd=cost_usd,
                        pricing_key=pricing_key,
                    )
                    receipts.extend(receipts_for_step)
                else:
                    warnings.append(f"Unknown step type '{step_type}' ignored.")

                elapsed_s = max(time.monotonic() - step_started, 0.0)
                if step_type in {"model", "provider"}:
                    if cost_usd is None:
                        variant_cost_complete = False
                    else:
                        variant_cost_total += float(cost_usd)
                    variant_latency_total_s += elapsed_s
                    # Update receipts with measured latency (best effort).
                    _patch_step_receipts_latency(receipts, step_dir, elapsed_s)

                step_summary = {
                    "index": step_idx,
                    "type": step_type,
                    "output_paths": output_paths,
                    "latency_s": elapsed_s,
                    "cost_total_usd": cost_usd,
                    "usage": usage,
                    "warnings": warnings,
                }
                step_summaries.append(step_summary)
                events.emit(
                    "step_finished",
                    variant_id=variant_id,
                    sample_id=sample_id,
                    step_index=step_idx,
                    step_type=step_type,
                    output_paths=output_paths,
                    latency_s=elapsed_s,
                    cost_total_usd=cost_usd,
                    usage=usage,
                    warnings=warnings,
                )

            events.emit("sample_finished", variant_id=variant_id, sample_id=sample_id, output_path=str(cur_path))
            variant_results.append(
                {
                    "sample_id": sample_id,
                    "input_path": str(input_path),
                    "final_path": str(cur_path),
                    "final_width": cur_meta.get("width"),
                    "final_height": cur_meta.get("height"),
                    "steps": step_summaries,
                    "receipts": receipts,
                }
            )

        events.emit(
            "variant_finished",
            variant_id=variant_id,
            label=variant_label,
            cost_total_usd=variant_cost_total if variant_cost_complete else None,
            cost_total_usd_estimated=variant_cost_total,
            cost_total_usd_complete=variant_cost_complete,
            latency_total_s=variant_latency_total_s,
        )

        variants_out.append(
            {
                "variant_id": variant_id,
                "label": variant_label,
                "dir": str(variant_dir),
                "steps": steps,
                "results": variant_results,
                "summary": {
                    "cost_total_usd": variant_cost_total if variant_cost_complete else None,
                    "cost_total_usd_estimated": variant_cost_total,
                    "cost_total_usd_complete": variant_cost_complete,
                    "latency_total_s": variant_latency_total_s,
                },
            }
        )

    manifest = {
        "schema": HARNESS_SCHEMA,
        "schema_version": HARNESS_SCHEMA_VERSION,
        "run_id": run_id,
        "created_at": now_utc_iso(),
        "task": dict(task),
        "inputs": inputs_meta,
        "variants": variants_out,
        "notes": {
            "catalog_paths": [str(Path(p).expanduser()) for p in (catalog_paths or [])],
            "provider_plugins": list(provider_plugins or []),
        },
    }
    manifest_path = run_dir / "harness_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    events.emit("harness_finished", manifest_path=str(manifest_path))
    return HarnessRunResult(manifest_path=manifest_path, run_dir=run_dir, run_id=run_id)


def list_catalog_rows(
    extra_catalog_paths: Sequence[str | Path] | None = None,
) -> list[dict[str, Any]]:
    catalog = merged_catalog(extra_catalog_paths)
    pricing_tables = PricingEstimator().tables
    rows: list[dict[str, Any]] = []
    for (provider, model), entry in sorted(catalog.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        row = {
            "provider": provider,
            "model": model,
            "aliases": list(entry.aliases),
            "capabilities": list(entry.capabilities),
            "operations": list(entry.api.operations),
            "supports_init_image": entry.api.supports_init_image,
            "supports_mask": entry.api.supports_mask,
            "supports_reference_images": entry.api.supports_reference_images,
            "supported_output_formats": list(entry.api.supported_output_formats),
            "size_notes": entry.api.size_notes,
            "provider_options": dict(entry.api.provider_options),
            "pricing_key": entry.pricing_key,
            "pricing": dict(pricing_tables.get(entry.pricing_key, {})) if entry.pricing_key else {},
        }
        rows.append(row)
    return rows


def _normalize_input_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if not path.exists():
        raise FileNotFoundError(str(path))
    return path


def _safe_slug(value: str) -> str:
    cleaned = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(value))
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned[:64] or "x"


def _ext_for_format(fmt: str) -> str:
    fmt = (fmt or "").lower().strip()
    if fmt in {"jpg", "jpeg"}:
        return "jpg"
    if fmt == "png":
        return "png"
    if fmt == "webp":
        return "webp"
    return "png"


def _dims_to_size_hint(width: Any, height: Any) -> str:
    try:
        w = int(width)
        h = int(height)
    except Exception:
        return "1024x1024"
    return f"{max(1, w)}x{max(1, h)}"


def _image_dims(path: Path) -> tuple[int | None, int | None]:
    try:
        with Image.open(path) as img:
            w, h = img.size
            return int(w), int(h)
    except Exception:
        return None, None


def _local_resize_and_encode(
    input_path: Path,
    out_path: Path,
    *,
    max_dim_px: int,
    output_format: str,
    quality: int,
) -> tuple[Path, dict[str, int | None]]:
    with Image.open(input_path) as img:
        img = img.convert("RGB")
        w, h = img.size
        max_dim = max(1, int(max_dim_px))
        scale = min(1.0, max_dim / max(1, max(w, h)))
        new_w = max(1, int(round(w * scale)))
        new_h = max(1, int(round(h * scale)))
        if (new_w, new_h) != (w, h):
            img = img.resize((new_w, new_h), Image.LANCZOS)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _save_image(img, out_path, output_format=output_format, quality=quality)
        return out_path, {"width": new_w, "height": new_h}


def _local_reencode(input_path: Path, out_path: Path, *, output_format: str, quality: int) -> Path:
    with Image.open(input_path) as img:
        img = img.convert("RGB")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        _save_image(img, out_path, output_format=output_format, quality=quality)
        return out_path


def _save_image(img: Image.Image, out_path: Path, *, output_format: str, quality: int) -> None:
    fmt = (output_format or "png").strip().lower()
    if fmt in {"jpg", "jpeg"}:
        img.save(out_path, format="JPEG", quality=max(1, min(int(quality), 95)), optimize=True, progressive=True)
        return
    if fmt == "webp":
        img.save(out_path, format="WEBP", quality=max(1, min(int(quality), 95)))
        return
    img.save(out_path, format="PNG")


def _render_prompt_template(prompt: str, task: Mapping[str, Any]) -> str:
    # Minimal template support. Keep it deterministic; avoid Jinja.
    task_prompt = str(task.get("prompt") or task.get("instruction") or "").strip()
    return (
        (prompt or "")
        .replace("{task_prompt}", task_prompt)
        .replace("{task}", task_prompt)
        .strip()
        or task_prompt
    )


def _resolve_pricing_key(step: Mapping[str, Any], provider: str, model: str | None) -> str | None:
    explicit = step.get("pricing_key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    if not model:
        return None
    registry = ModelRegistry()
    spec = registry.get(model)
    if spec and str(spec.provider).lower() == str(provider).lower():
        return spec.pricing_key
    return None


def _resolve_pricing_key(
    step: Mapping[str, Any],
    provider: str,
    model: str | None,
    catalog: Mapping[tuple[str, str], CatalogEntry],
) -> str | None:
    explicit = step.get("pricing_key")
    if isinstance(explicit, str) and explicit.strip():
        return explicit.strip()
    if model:
        entry = catalog.get((provider, model))
        if entry and entry.pricing_key:
            return entry.pricing_key
        registry = ModelRegistry()
        spec = registry.get(model)
        if spec and str(spec.provider).lower() == str(provider).lower():
            return spec.pricing_key
    return None


def _extract_usage_hint(provider_response: Mapping[str, Any]) -> Mapping[str, Any] | None:
    usage = provider_response.get("usage") if isinstance(provider_response, Mapping) else None
    if isinstance(usage, Mapping):
        return dict(usage)
    return None


def _write_step_receipts(
    *,
    step_dir: Path,
    request: ImageRequest,
    provider_name: str,
    model_name: str | None,
    size: str,
    provider_options: Mapping[str, Any],
    response: Any,
    latency_s: float,
    cost_total_usd: float | None,
    pricing_key: str | None,
) -> list[str]:
    receipts: list[str] = []
    results = list(getattr(response, "results", []) or [])
    warnings = list(getattr(response, "warnings", []) or [])
    provider_request = getattr(response, "provider_request", {}) or {}
    provider_response = getattr(response, "provider_response", {}) or {}
    for idx, result in enumerate(results, start=1):
        artifact_id = f"{idx:02d}-{uuid.uuid4().hex[:8]}"
        receipt_path = step_dir / f"receipt-{artifact_id}.json"
        width = getattr(result, "width", None)
        height = getattr(result, "height", None)
        if width is None or height is None:
            try:
                width, height = _image_dims(Path(result.image_path))
            except Exception:
                width, height = None, None
        output_format = (request.output_format or "png").strip().lower() or "png"
        resolved = ResolvedRequest(
            provider=provider_name,
            model=model_name,
            size=size,
            width=width,
            height=height,
            output_format=output_format,
            background=None,
            seed=getattr(result, "seed", None),
            n=max(1, int(request.n)),
            user=None,
            prompt=request.prompt,
            inputs=request.inputs,
            stream=False,
            partial_images=None,
            provider_params=dict(provider_options),
            warnings=warnings,
        )
        metadata = {
            "cost_total_usd": cost_total_usd,
            "latency_s": latency_s,
            "pricing_key": pricing_key,
        }
        payload = build_receipt(
            request=request,
            resolved=resolved,
            provider_request=provider_request,
            provider_response=provider_response,
            warnings=warnings,
            image_path=Path(result.image_path),
            receipt_path=receipt_path,
            result_metadata=metadata,
        )
        write_receipt(receipt_path, payload)
        receipts.append(str(receipt_path))
    return receipts


def _patch_step_receipts_latency(receipt_paths: list[str], step_dir: Path, latency_s: float) -> None:
    # Best-effort: receipts are per-step; patch those inside the current step_dir.
    for receipt in receipt_paths:
        try:
            path = Path(receipt)
            if step_dir not in path.parents:
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                continue
            meta = payload.get("result_metadata")
            if not isinstance(meta, dict):
                meta = {}
            meta["latency_s"] = float(latency_s)
            payload["result_metadata"] = meta
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        except Exception:
            continue


def _build_provider_registry(plugins: Sequence[str] | None) -> ProviderRegistry:
    base = default_registry()
    if not plugins:
        return base
    providers = list(base.providers())
    providers.extend(_load_provider_plugins(plugins))
    return ProviderRegistry(providers)


def _load_provider_plugins(specs: Sequence[str]) -> list[Any]:
    loaded: list[Any] = []
    for spec in specs:
        raw = str(spec or "").strip()
        if not raw or ":" not in raw:
            continue
        module_name, attr = raw.split(":", 1)
        try:
            module = importlib.import_module(module_name)
            target = getattr(module, attr)
            provider = target() if callable(target) else None
            if provider and getattr(provider, "name", None) and hasattr(provider, "generate"):
                loaded.append(provider)
        except Exception:
            continue
    return loaded
