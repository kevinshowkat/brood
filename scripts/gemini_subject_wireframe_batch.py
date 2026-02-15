#!/usr/bin/env python3
"""Batch subject-only wireframe renders via Gemini 2.5 Flash image edit.

This tool is intentionally practical (not "scalable"):
- One Gemini image-edit call per input image.
- Prompt asks Gemini to isolate the main subject and remove the background.
- If Gemini returns an opaque image, a fallback key pass removes black background
  into alpha so the output remains "subject only".

Example:
  python scripts/gemini_subject_wireframe_batch.py \
    --input-dir ./images \
    --image-size 2K
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Ensure repo root is importable when running as `python scripts/...`.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from brood_engine.providers.gemini import GeminiProvider
from brood_engine.runs.receipts import ImageInputs, ImageRequest


SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _safe_slug(value: str) -> str:
    lowered = str(value or "").strip().lower()
    slug = re.sub(r"[^a-z0-9]+", "-", lowered).strip("-")
    return slug or "item"


def _collect_images(input_dir: Path, *, recursive: bool) -> list[Path]:
    if recursive:
        candidates = sorted(p for p in input_dir.rglob("*") if p.is_file())
    else:
        candidates = sorted(p for p in input_dir.iterdir() if p.is_file())
    return [p for p in candidates if p.suffix.lower() in SUPPORTED_EXTS]


def _build_prompt(*, extra_style: str) -> str:
    base = (
        "Transform the provided photo into a tactical neon wireframe portrait.\n"
        "Hard requirements:\n"
        "1) Identify the primary foreground subject/object only.\n"
        "2) Remove all background, environment, shadows, and unrelated objects.\n"
        "3) Preserve only a readable high-level silhouette and pose from the source image.\n"
        "4) Render the subject as a detailed neon green holographic wireframe mesh,\n"
        "   with thin bright edge lines and subtle glow, similar to an RTS unit HUD render.\n"
        "   Use Brood HUD green exactly: rgba(82, 255, 148, 0.95) / #52FF94 for the dominant line color.\n"
        "5) Final palette must be exactly two colors:\n"
        "   - pure black (#000000) for all non-wireframe/background pixels\n"
        "   - HUD green (#52FF94) for all wireframe lines/highlights\n"
        "   Do not output any other hue, tint, or grayscale shade.\n"
        "6) Remove all source photo colors (skin tones, clothing colors, logos, materials). Only monochrome\n"
        "   green wire lines/shapes in the HUD green family are allowed.\n"
        "7) It is acceptable to simplify the subject significantly; prioritize clean wire readability over detail.\n"
        "8) Output one centered subject only.\n"
        "9) Use a pure black (#000000) background always (no transparency).\n"
        "10) No text, labels, frames, UI chrome, or watermark."
    )
    extra = str(extra_style or "").strip()
    if not extra:
        return base
    return f"{base}\nAdditional style constraints:\n{extra}"


def _safe_nonnegative_int(value: Any) -> int | None:
    try:
        parsed = int(round(float(value)))
    except Exception:
        return None
    if parsed < 0:
        return None
    return parsed


def _as_mapping(value: Any) -> Mapping[str, Any] | None:
    if isinstance(value, Mapping):
        return value
    if value is None:
        return None
    if hasattr(value, "model_dump"):
        try:
            dumped = value.model_dump()
            if isinstance(dumped, Mapping):
                return dumped
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        raw = getattr(value, "__dict__", None)
        if isinstance(raw, Mapping):
            return raw
    return None


def _extract_usage_pair(payload: Any) -> tuple[int | None, int | None]:
    root = _as_mapping(payload)
    if not root:
        return None, None
    queue: list[Mapping[str, Any]] = [root]
    seen: set[int] = set()
    while queue and len(seen) < 120:
        cur = queue.pop(0)
        ident = id(cur)
        if ident in seen:
            continue
        seen.add(ident)

        def pick(keys: tuple[str, ...]) -> int | None:
            for key in keys:
                if key not in cur:
                    continue
                parsed = _safe_nonnegative_int(cur.get(key))
                if parsed is not None:
                    return parsed
            return None

        in_tokens = pick(
            (
                "input_tokens",
                "prompt_tokens",
                "promptTokenCount",
                "inputTokenCount",
                "tokens_in",
            )
        )
        out_tokens = pick(
            (
                "output_tokens",
                "completion_tokens",
                "candidatesTokenCount",
                "outputTokenCount",
                "tokens_out",
            )
        )
        total = pick(("totalTokenCount", "total_tokens", "totalTokens", "token_count"))
        if in_tokens is not None or out_tokens is not None:
            if out_tokens is None and total is not None and in_tokens is not None and total >= in_tokens:
                out_tokens = total - in_tokens
            return in_tokens, out_tokens

        for key in ("usage", "usage_metadata", "usageMetadata"):
            nested = _as_mapping(cur.get(key))
            if nested:
                queue.append(nested)
        for value in cur.values():
            nested = _as_mapping(value)
            if nested:
                queue.append(nested)
    return None, None


def _has_meaningful_alpha(img: Image.Image) -> bool:
    rgba = img.convert("RGBA")
    alpha = np.asarray(rgba, dtype=np.uint8)[:, :, 3]
    transparent = int(np.count_nonzero(alpha < 250))
    total = int(alpha.shape[0] * alpha.shape[1])
    if total <= 0:
        return False
    return (transparent / total) >= 0.004


def _key_black_background(
    img: Image.Image,
    *,
    key_low: float,
    key_high: float,
    blur_radius: float,
) -> Image.Image:
    rgba = img.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.float32)
    rgb = arr[:, :, :3]

    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

    # Keep bright structure + green-dominant lines while dropping black bg.
    alpha_lum = np.clip((lum - key_low) / max(1e-6, (key_high - key_low)), 0.0, 1.0)
    green_dom = g - ((r + b) * 0.5)
    alpha_green = np.clip((green_dom - 10.0) / 52.0, 0.0, 1.0)
    alpha = np.maximum(alpha_lum, alpha_green)

    in_alpha = arr[:, :, 3] / 255.0
    alpha = np.clip(alpha * in_alpha, 0.0, 1.0)

    out = arr.copy()
    out[:, :, 3] = np.clip(alpha * 255.0, 0.0, 255.0)
    keyed = Image.fromarray(out.astype(np.uint8), mode="RGBA")
    if blur_radius > 0:
        # Light feathering avoids crunchy aliasing on line edges.
        a = keyed.getchannel("A").filter(ImageFilter.GaussianBlur(radius=float(blur_radius)))
        keyed.putalpha(a)
    return keyed


def _parse_bg_color(value: str) -> tuple[int, int, int]:
    raw = str(value or "").strip()
    if not raw:
        return (11, 15, 22)
    if raw.startswith("#"):
        hexv = raw[1:]
        if len(hexv) == 3:
            try:
                return tuple(int(ch * 2, 16) for ch in hexv)  # type: ignore[return-value]
            except Exception:
                return (11, 15, 22)
        if len(hexv) == 6:
            try:
                return (int(hexv[0:2], 16), int(hexv[2:4], 16), int(hexv[4:6], 16))
            except Exception:
                return (11, 15, 22)
    parts = re.split(r"[, ]+", raw)
    if len(parts) >= 3:
        try:
            r = max(0, min(255, int(float(parts[0]))))
            g = max(0, min(255, int(float(parts[1]))))
            b = max(0, min(255, int(float(parts[2]))))
            return (r, g, b)
        except Exception:
            pass
    return (11, 15, 22)


def _flatten_to_bg(img: Image.Image, bg_rgb: tuple[int, int, int]) -> Image.Image:
    rgba = img.convert("RGBA")
    base = Image.new("RGB", rgba.size, bg_rgb)
    base.paste(rgba, mask=rgba.getchannel("A"))
    return base


def _wireframe_quality_metrics(img: Image.Image) -> dict[str, float]:
    rgba = img.convert("RGBA")
    arr = np.asarray(rgba, dtype=np.float32)
    rgb = arr[:, :, :3]
    alpha = arr[:, :, 3] / 255.0
    r = rgb[:, :, 0]
    g = rgb[:, :, 1]
    b = rgb[:, :, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    green_dom = g - ((r + b) * 0.5)

    if _has_meaningful_alpha(rgba):
        mask = alpha > 0.12
    else:
        mask = (lum > 22.0) | (green_dom > 16.0)

    total = float(mask.shape[0] * mask.shape[1]) if mask.size else 1.0
    coverage = float(np.count_nonzero(mask)) / max(1.0, total)
    bright = (g > 108.0) & (green_dom > 24.0) & mask
    bright_ratio = float(np.count_nonzero(bright)) / max(1.0, total)
    mean_green = float(g[mask].mean()) if np.count_nonzero(mask) > 0 else 0.0
    return {
        "coverage": coverage,
        "bright_ratio": bright_ratio,
        "mean_green": mean_green,
    }


def _wireframe_retry_prompt(base_prompt: str) -> str:
    return (
        f"{base_prompt}\n"
        "Critical correction pass:\n"
        "- Cover the entire subject silhouette with continuous wireframe detail.\n"
        "- Do not leave large unrendered patches of the subject.\n"
        "- Ensure all major limbs/parts/panels receive visible wire lines.\n"
        "- Keep line visibility strong enough to read at thumbnail size."
    )


def _move_or_copy(src: Path, dst: Path) -> None:
    if dst.exists():
        dst.unlink()
    try:
        src.rename(dst)
    except Exception:
        dst.write_bytes(src.read_bytes())
        try:
            src.unlink()
        except Exception:
            pass


def _make_unique_path(path: Path) -> Path:
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    counter = 2
    while True:
        candidate = parent / f"{stem}-{counter}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def _render_contact_sheet(images: list[Path], out_path: Path) -> None:
    if not images:
        return
    thumb_w = 320
    thumb_h = 220
    cols = 4
    rows = (len(images) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * thumb_w, rows * thumb_h), (3, 11, 8))
    draw = ImageDraw.Draw(sheet)
    for idx, path in enumerate(images):
        tile = Image.open(path).convert("RGBA")
        tile.thumbnail((thumb_w - 14, thumb_h - 34), Image.Resampling.LANCZOS)
        base = Image.new("RGB", tile.size, (0, 0, 0))
        base.paste(tile, mask=tile.getchannel("A"))
        x = (idx % cols) * thumb_w + (thumb_w - base.width) // 2
        y = (idx // cols) * thumb_h + 6
        sheet.paste(base, (x, y))
        label = path.stem[:38]
        draw.text((x, (idx // cols) * thumb_h + thumb_h - 24), label, fill=(124, 234, 160))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, quality=92)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    default_input = _REPO_ROOT / "images"
    parser = argparse.ArgumentParser(description="Batch Gemini subject-only neon wireframe converter")
    parser.add_argument("--input-dir", default=str(default_input), help="Input directory with source images")
    parser.add_argument("--out-dir", default=None, help="Output directory (default: sibling timestamped folder)")
    parser.add_argument("--model", default="gemini-2.5-flash-image", help="Gemini image model")
    parser.add_argument("--image-size", default="2K", help="Gemini image_size hint (1K/2K/4K)")
    parser.add_argument("--limit", type=int, default=0, help="Optional max images to process")
    parser.add_argument("--sleep-ms", type=float, default=130.0, help="Delay between API calls")
    parser.add_argument("--recursive", action="store_true", help="Recursively scan input-dir")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite output files if names collide")
    parser.add_argument("--style-prompt", default="", help="Extra style line appended to the base prompt")
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=2,
        help="Max generation attempts per image (retries partial wireframes). Default: 2",
    )
    parser.add_argument(
        "--min-coverage",
        type=float,
        default=0.018,
        help="Minimum subject wire coverage ratio before accepting an attempt. Default: 0.018",
    )
    parser.add_argument(
        "--min-bright-ratio",
        type=float,
        default=0.0035,
        help="Minimum bright-line ratio before accepting an attempt. Default: 0.0035",
    )
    parser.add_argument("--no-key-bg", action="store_true", help="Disable fallback black-background key pass")
    parser.add_argument("--key-low", type=float, default=15.0, help="Luma lower bound for black key")
    parser.add_argument("--key-high", type=float, default=74.0, help="Luma upper bound for black key")
    parser.add_argument("--key-blur", type=float, default=0.55, help="Alpha blur radius after keying")
    parser.add_argument(
        "--picker-bg",
        default="#000000",
        help="Background color to flatten outputs onto (hex or 'r,g,b'). Default: #000000",
    )
    parser.add_argument(
        "--keep-alpha",
        action="store_true",
        help="Keep transparent output instead of flattening to picker background.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(list(argv or sys.argv[1:]))
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        print("Missing GEMINI_API_KEY (or GOOGLE_API_KEY).", file=sys.stderr)
        return 2

    input_dir = Path(args.input_dir).expanduser().resolve()
    if not input_dir.exists() or not input_dir.is_dir():
        print(f"Input directory not found: {input_dir}", file=sys.stderr)
        return 2

    files = _collect_images(input_dir, recursive=bool(args.recursive))
    if args.limit and args.limit > 0:
        files = files[: int(args.limit)]
    if not files:
        print(f"No supported images found in: {input_dir}", file=sys.stderr)
        return 2

    if args.out_dir:
        out_dir = Path(args.out_dir).expanduser().resolve()
    else:
        out_dir = input_dir.parent / f"{input_dir.name}_gemini_wire_subject_{_now_stamp()}"
    raw_dir = out_dir / "_raw_provider_outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    provider = GeminiProvider()
    prompt = _build_prompt(extra_style=str(args.style_prompt))
    picker_bg = _parse_bg_color(str(args.picker_bg))

    records: list[dict[str, Any]] = []
    outputs: list[Path] = []
    total_in = 0
    total_out = 0
    processed = 0

    print(f"Input: {input_dir}")
    print(f"Output: {out_dir}")
    print(f"Model: {args.model}")
    print(f"Count: {len(files)}")

    for idx, src in enumerate(files, start=1):
        item_label = f"[{idx}/{len(files)}]"
        print(f"{item_label} {src.name}")
        per_item_raw = raw_dir / f"{idx:03d}_{_safe_slug(src.stem)}"
        per_item_raw.mkdir(parents=True, exist_ok=True)

        try:
            with Image.open(src) as ref:
                width, height = ref.size
            max_attempts = max(1, int(args.max_attempts))
            attempts_meta: list[dict[str, Any]] = []
            chosen_response = None
            chosen_rendered = None
            chosen_metrics = None
            chosen_used_key_pass = False
            chosen_score = -1.0

            for attempt in range(1, max_attempts + 1):
                attempt_prompt = prompt if attempt == 1 else _wireframe_retry_prompt(prompt)
                req = ImageRequest(
                    prompt=attempt_prompt,
                    size=f"{width}x{height}",
                    n=1,
                    output_format="png",
                    provider="gemini",
                    model=str(args.model),
                    provider_options={"image_size": str(args.image_size)},
                    inputs=ImageInputs(init_image=str(src)),
                    out_dir=str(per_item_raw),
                )
                response = provider.generate(req)
                if not response.results:
                    raise RuntimeError("Gemini returned no images.")
                raw_img_path = Path(response.results[0].image_path)
                rendered_attempt = Image.open(raw_img_path).convert("RGBA")
                used_key_pass_attempt = False
                if (not args.no_key_bg) and (not _has_meaningful_alpha(rendered_attempt)):
                    rendered_attempt = _key_black_background(
                        rendered_attempt,
                        key_low=float(args.key_low),
                        key_high=float(args.key_high),
                        blur_radius=float(args.key_blur),
                    )
                    used_key_pass_attempt = True

                metrics = _wireframe_quality_metrics(rendered_attempt)
                coverage = float(metrics.get("coverage") or 0.0)
                bright_ratio = float(metrics.get("bright_ratio") or 0.0)
                score = (coverage * 0.68) + (bright_ratio * 0.32)
                attempts_meta.append(
                    {
                        "attempt": attempt,
                        "used_key_pass": used_key_pass_attempt,
                        "metrics": metrics,
                    }
                )

                if score > chosen_score:
                    chosen_score = score
                    chosen_response = response
                    chosen_rendered = rendered_attempt
                    chosen_metrics = metrics
                    chosen_used_key_pass = used_key_pass_attempt

                if coverage >= float(args.min_coverage) and bright_ratio >= float(args.min_bright_ratio):
                    break

            if chosen_response is None or chosen_rendered is None:
                raise RuntimeError("Failed to produce a wireframe render.")

            out_name = f"{src.stem}_wire_subject.png"
            final_path = out_dir / out_name
            if (not args.overwrite) and final_path.exists():
                final_path = _make_unique_path(final_path)
            if args.keep_alpha:
                chosen_rendered.save(final_path, format="PNG")
            else:
                _flatten_to_bg(chosen_rendered, picker_bg).save(final_path, format="PNG")

            in_tokens, out_tokens = _extract_usage_pair(chosen_response.provider_response)
            if in_tokens:
                total_in += int(in_tokens)
            if out_tokens:
                total_out += int(out_tokens)

            outputs.append(final_path)
            processed += 1
            rec = {
                "input": str(src),
                "output": str(final_path),
                "warnings": list(chosen_response.warnings or []),
                "used_key_pass": chosen_used_key_pass,
                "flattened_to_picker_bg": not bool(args.keep_alpha),
                "attempts": attempts_meta,
                "chosen_metrics": chosen_metrics,
                "usage": {
                    "input_tokens": in_tokens,
                    "output_tokens": out_tokens,
                },
                "provider_response": chosen_response.provider_response,
            }
            records.append(rec)
        except Exception as exc:
            records.append(
                {
                    "input": str(src),
                    "error": str(exc),
                }
            )
            print(f"  error: {exc}", file=sys.stderr)

        if idx < len(files) and float(args.sleep_ms) > 0:
            time.sleep(max(0.0, float(args.sleep_ms) / 1000.0))

    contact_path = out_dir / "contact_sheet.jpg"
    try:
        _render_contact_sheet(outputs, contact_path)
    except Exception as exc:
        print(f"warning: failed to render contact sheet: {exc}", file=sys.stderr)

    manifest = {
        "tool": "gemini_subject_wireframe_batch",
        "version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "settings": {
            "input_dir": str(input_dir),
            "out_dir": str(out_dir),
            "model": str(args.model),
            "image_size": str(args.image_size),
            "recursive": bool(args.recursive),
            "prompt": prompt,
            "keying": {
                "enabled": not bool(args.no_key_bg),
                "key_low": float(args.key_low),
                "key_high": float(args.key_high),
                "key_blur": float(args.key_blur),
            },
            "picker_bg": {
                "value": str(args.picker_bg),
                "rgb": [int(picker_bg[0]), int(picker_bg[1]), int(picker_bg[2])],
                "keep_alpha": bool(args.keep_alpha),
            },
        },
        "summary": {
            "requested_count": len(files),
            "success_count": processed,
            "failure_count": len(files) - processed,
            "input_tokens_total": total_in,
            "output_tokens_total": total_out,
            "contact_sheet": str(contact_path) if contact_path.exists() else None,
        },
        "items": records,
    }
    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(f"Done. success={processed} failure={len(files) - processed}")
    print(f"Manifest: {manifest_path}")
    if contact_path.exists():
        print(f"Contact sheet: {contact_path}")
    print(f"Token usage: in={total_in} out={total_out}")
    return 0 if processed > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
