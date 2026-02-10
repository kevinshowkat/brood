#!/usr/bin/env python3
"""
Generate StarCraft-themed Intent onboarding icons using Gemini 3 Pro Image Preview.

This repo currently draws Intent onboarding glyphs procedurally in:
  desktop/src/canvas_app.js

This script generates image-based replacements (PNGs) so you can swap them in
later (e.g., drawImage instead of stroke paths).

Requirements:
  - GEMINI_API_KEY (or GOOGLE_API_KEY)
  - pip install google-genai

Example:
  python scripts/gemini_generate_intent_icons.py \
    --out desktop/src/assets/intent-icons-sc \
    --model gemini-3-pro-image-preview \
    --image-size 1K \
    --n 3
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

from PIL import Image

# Ensure repo root is on sys.path when running as `python scripts/...`.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from brood_engine.providers.dryrun import DryRunProvider
from brood_engine.providers.gemini import GeminiProvider
from brood_engine.runs.receipts import ImageRequest


@dataclass(frozen=True)
class IconSpec:
    key: str
    filename_stem: str
    prompt: str
    kind: str  # "usecase" | "token" | "start" | "cursor"


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _pick_provider(name: str) -> Any:
    normalized = (name or "").strip().lower()
    if normalized == "dryrun":
        return DryRunProvider()
    if normalized == "gemini":
        return GeminiProvider()
    raise SystemExit(f"Unknown provider: {name}. Expected gemini or dryrun.")


def _generate_with_provider(
    provider: Any,
    *,
    out_dir: Path,
    model: str,
    ratio: str,
    image_size: str,
    prompt: str,
    n: int,
    key: str,
) -> dict[str, Any]:
    out_dir.mkdir(parents=True, exist_ok=True)
    request = ImageRequest(
        prompt=prompt,
        size=ratio,
        n=max(1, int(n)),
        output_format="png",
        provider="gemini",
        model=model,
        provider_options={
            "aspect_ratio": ratio,
            "image_size": image_size,
        },
        out_dir=str(out_dir),
    )
    response = provider.generate(request)
    outputs: list[str] = []
    for idx, artifact in enumerate(response.results, start=1):
        src = Path(artifact.image_path)
        dst = out_dir / f"{key}-{idx:02d}.png"
        try:
            if dst.exists():
                dst.unlink()
            src.rename(dst)
        except Exception:
            # Cross-device rename fallback or provider gave a non-Path type.
            dst.write_bytes(src.read_bytes())
            try:
                src.unlink()
            except Exception:
                pass
        outputs.append(str(dst))
    return {
        "key": key,
        "model": model,
        "ratio": ratio,
        "image_size": image_size,
        "prompt": prompt,
        "warnings": list(response.warnings or []),
        "provider_request": response.provider_request,
        "provider_response": response.provider_response,
        "outputs": outputs,
    }


def _avg_rgb(pixels: list[tuple[int, int, int]]) -> tuple[float, float, float]:
    if not pixels:
        return (0.0, 0.0, 0.0)
    r = sum(p[0] for p in pixels) / len(pixels)
    g = sum(p[1] for p in pixels) / len(pixels)
    b = sum(p[2] for p in pixels) / len(pixels)
    return (r, g, b)


def _color_dist(a: tuple[float, float, float], b: tuple[float, float, float]) -> float:
    return ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) ** 0.5


def _sample_corner_rgb(img: Image.Image, corner: str, *, sample: int) -> list[tuple[int, int, int]]:
    w, h = img.size
    s = max(1, min(int(sample), w, h))
    if corner == "tl":
        box = (0, 0, s, s)
    elif corner == "tr":
        box = (w - s, 0, w, s)
    elif corner == "bl":
        box = (0, h - s, s, h)
    else:
        box = (w - s, h - s, w, h)
    crop = img.crop(box).convert("RGB")
    return list(crop.getdata())


def _remove_corner_background(
    img: Image.Image,
    *,
    corner_sample: int = 14,
    t0: float = 10.0,
    t1: float = 46.0,
) -> tuple[Image.Image, dict[str, Any]]:
    """
    Best-effort background removal for "flat background" icon renders.

    We estimate background from corner samples, then fade alpha based on distance.
    """
    src = img.convert("RGBA")
    rgb = src.convert("RGB")

    corners = {
        "tl": _avg_rgb(_sample_corner_rgb(rgb, "tl", sample=corner_sample)),
        "tr": _avg_rgb(_sample_corner_rgb(rgb, "tr", sample=corner_sample)),
        "bl": _avg_rgb(_sample_corner_rgb(rgb, "bl", sample=corner_sample)),
        "br": _avg_rgb(_sample_corner_rgb(rgb, "br", sample=corner_sample)),
    }
    bg = _avg_rgb([(int(c[0]), int(c[1]), int(c[2])) for c in corners.values()])

    # If corners disagree heavily, background probably isn't flat; still run but record it.
    max_dev = max(_color_dist(bg, c) for c in corners.values())

    w, h = src.size
    px = src.load()
    changed = 0
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a == 0:
                continue
            d = _color_dist((float(r), float(g), float(b)), bg)
            if d <= t0:
                na = 0
            elif d >= t1:
                na = a
            else:
                # Smooth fade on edges.
                na = int(a * (d - t0) / max(1e-6, (t1 - t0)))
            if na != a:
                px[x, y] = (r, g, b, na)
                changed += 1

    meta = {
        "bg_rgb": [round(bg[0], 2), round(bg[1], 2), round(bg[2], 2)],
        "corner_rgb": {k: [round(v[0], 2), round(v[1], 2), round(v[2], 2)] for k, v in corners.items()},
        "corner_max_dev": round(float(max_dev), 3),
        "pixels_alpha_changed": int(changed),
        "params": {"corner_sample": int(corner_sample), "t0": float(t0), "t1": float(t1)},
    }
    return src, meta


def _alpha_bbox(img: Image.Image, *, alpha_threshold: int = 10) -> tuple[int, int, int, int] | None:
    rgba = img.convert("RGBA")
    w, h = rgba.size
    px = rgba.load()
    min_x, min_y = w, h
    max_x, max_y = -1, -1
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > alpha_threshold:
                if x < min_x:
                    min_x = x
                if y < min_y:
                    min_y = y
                if x > max_x:
                    max_x = x
                if y > max_y:
                    max_y = y
    if max_x < min_x or max_y < min_y:
        return None
    return (min_x, min_y, max_x + 1, max_y + 1)


def _center_fit_square(
    img: Image.Image,
    *,
    out_size: int,
    pad_frac: float = 0.16,
    alpha_threshold: int = 10,
) -> Image.Image:
    rgba = img.convert("RGBA")
    bbox = _alpha_bbox(rgba, alpha_threshold=alpha_threshold)
    if bbox:
        cropped = rgba.crop(bbox)
    else:
        cropped = rgba

    # Add padding around the cropped content.
    cw, ch = cropped.size
    pad = int(round(max(cw, ch) * max(0.0, float(pad_frac))))
    canvas = Image.new("RGBA", (cw + pad * 2, ch + pad * 2), (0, 0, 0, 0))
    canvas.paste(cropped, (pad, pad), cropped)

    # Now fit into output square.
    w, h = canvas.size
    scale = out_size / max(1, max(w, h))
    tw = max(1, int(round(w * scale)))
    th = max(1, int(round(h * scale)))
    resized = canvas.resize((tw, th), resample=Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (out_size, out_size), (0, 0, 0, 0))
    ox = (out_size - tw) // 2
    oy = (out_size - th) // 2
    out.paste(resized, (ox, oy), resized)
    return out


def _parse_icon_list(value: str) -> list[str]:
    raw = (value or "").strip()
    if not raw:
        return ["all"]
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return parts or ["all"]


def _specs() -> list[IconSpec]:
    style = (
        "Style guide:\n"
        "- StarCraft-inspired RTS sci-fi HUD icon style (Terran/Protoss vibes), BUT original design.\n"
        "- Strong iconic silhouette that reads at 32px, thick strokes, no hairline detail.\n"
        "- Cinematic high-end polish: subtle bevels, luminous edge highlights, tasteful bloom/halo glow.\n"
        "- Emotional tone: awe-inspiring, triumphant, and joy-forward (radiant, celebratory energy).\n"
        "- Designed to sit on a dark brushed-metal HUD plate: must pop with bright cores + glowing outlines.\n"
        "- Pure black background (#000000) so we can remove it to transparency.\n"
        "- White line art with neon teal accents (#00f5a0). Use neon green/red only for yes/no.\n"
        "- No readable text, no letters, no numbers, no logos, no watermarks.\n"
        "- Centered composition, square 1:1.\n"
    )
    return [
        IconSpec(
            key="usecase_game_dev_assets",
            filename_stem="intent-usecase-game-dev-assets",
            kind="usecase",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A futuristic game controller PLUS a small pixel-grid tile (3x3 squares) in a corner,\n"
                "  clearly implying 'game assets / sprites'.\n"
                "- Industrial Terran UI styling, heroic badge-like framing.\n"
            ),
        ),
        IconSpec(
            key="usecase_streaming_content",
            filename_stem="intent-usecase-streaming-content",
            kind="usecase",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A broadcast/camera or play-triangle symbol with radiating signal waves.\n"
                "- Should read as 'streaming / creator graphics' (avoid lightning-only ambiguity).\n"
                "- Sleek Protoss-style holographic energy accents, radiant celebratory glow.\n"
            ),
        ),
        IconSpec(
            key="usecase_uiux_prototyping",
            filename_stem="intent-usecase-uiux-prototyping",
            kind="usecase",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A holographic UI window frame with a visible grid/wireframe.\n"
                "- A cursor arrow selecting a rectangle (UI prototyping vibe).\n"
                "- Make it feel like an exalted command-console schematic, joyful luminous highlights.\n"
            ),
        ),
        IconSpec(
            key="usecase_ecommerce_pod",
            filename_stem="intent-usecase-ecommerce-pod",
            kind="usecase",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- An industrial sci-fi shipping crate / cargo box PLUS a simple price tag shape.\n"
                "- Clearly reads as 'products / ecommerce / merch'.\n"
                "- Premium, proud, 'flagship merch drop' energy.\n"
            ),
        ),
        IconSpec(
            key="usecase_content_engine",
            filename_stem="intent-usecase-content-engine",
            kind="usecase",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A gear PLUS a simple connected-node pipeline motif (3 dots connected by lines).\n"
                "- Reads as 'automation / process / pipeline', not generic settings.\n"
                "- Sacred-tech / cathedral-of-machines vibe; uplifting glow.\n"
            ),
        ),
        IconSpec(
            key="token_yes",
            filename_stem="intent-token-yes",
            kind="token",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A circular HUD confirm button with a checkmark.\n"
                "- Neon green glow accents (not teal), beveled sci-fi ring, feels like a joyous 'victory confirm'.\n"
            ),
        ),
        IconSpec(
            key="token_no",
            filename_stem="intent-token-no",
            kind="token",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A circular HUD cancel button with an X.\n"
                "- Neon red glow accents, beveled sci-fi ring, dramatic but still clean.\n"
            ),
        ),
        IconSpec(
            key="start_lock",
            filename_stem="intent-start-lock",
            kind="start",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A circular HUD execute/start button with a play triangle.\n"
                "- Add subtle bracket/lock-frame motif so it reads as 'commit/lock' not media playback.\n"
                "- Teal/green accents, triumphant 'go time' glow.\n"
            ),
        ),
        IconSpec(
            key="cursor_intent",
            filename_stem="intent-cursor",
            kind="cursor",
            prompt=(
                f"{style}\n"
                "Icon concept:\n"
                "- A sharp sci-fi cursor pointer arrow.\n"
                "- Neon teal glow with dark outline and inner highlight.\n"
                "- No extra symbols.\n"
            ),
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Intent onboarding icons (Gemini).")
    parser.add_argument(
        "--out",
        type=str,
        default="",
        help="Output directory (default: desktop/src/assets/intent-icons-sc/<timestamp>).",
    )
    parser.add_argument("--provider", type=str, default="gemini", help="Provider: gemini or dryrun (default: gemini).")
    parser.add_argument("--model", type=str, default="gemini-3-pro-image-preview", help="Gemini image model.")
    parser.add_argument("--image-size", type=str, default="1K", help="Gemini image_size hint: 1K/2K/4K (default: 1K).")
    parser.add_argument("--n", type=int, default=1, help="Candidates per icon (default: 1).")
    parser.add_argument(
        "--icons",
        type=str,
        default="all",
        help="Comma list: all or specific keys (usecase_game_dev_assets,...,cursor_intent).",
    )
    parser.add_argument("--final-size", type=int, default=256, help="Processed square icon size (default: 256).")
    parser.add_argument("--cursor-sizes", type=str, default="32,64", help="Comma list of cursor sizes to export.")
    parser.add_argument("--no-bg-remove", action="store_true", help="Skip background removal.")
    parser.add_argument("--bg-t0", type=float, default=10.0, help="BG removal: fully transparent distance threshold.")
    parser.add_argument("--bg-t1", type=float, default=46.0, help="BG removal: fully opaque distance threshold.")
    parser.add_argument("--pad-frac", type=float, default=0.16, help="Pad fraction around cropped content (default: 0.16).")

    args = parser.parse_args()

    stamp = _now_stamp()
    base_out = Path(args.out) if str(args.out).strip() else Path("desktop/src/assets/intent-icons-sc") / stamp
    raw_dir = base_out / "raw"
    icon_dir = base_out / "icons"
    raw_dir.mkdir(parents=True, exist_ok=True)
    icon_dir.mkdir(parents=True, exist_ok=True)

    want = set(_parse_icon_list(args.icons))
    provider = _pick_provider(str(args.provider))

    cursor_sizes: list[int] = []
    for part in str(args.cursor_sizes).split(","):
        p = part.strip()
        if not p:
            continue
        try:
            cursor_sizes.append(max(8, int(p)))
        except Exception:
            raise SystemExit(f"Invalid --cursor-sizes entry: {part!r}")
    if not cursor_sizes:
        cursor_sizes = [32, 64]

    specs = _specs()
    if "all" not in want:
        specs = [s for s in specs if s.key.lower() in want]
        missing = sorted(k for k in want if k != "all" and k not in {s.key for s in _specs()})
        if missing:
            raise SystemExit(f"Unknown icon keys: {', '.join(missing)}")

    manifest: dict[str, Any] = {
        "schema": "brood.intent_icons_generate",
        "schema_version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "provider": str(args.provider),
        "model": str(args.model),
        "image_size": str(args.image_size),
        "n": int(args.n),
        "out_dir": str(base_out),
        "processing": {
            "final_size": int(args.final_size),
            "pad_frac": float(args.pad_frac),
            "bg_remove": (not bool(args.no_bg_remove)),
            "bg_t0": float(args.bg_t0),
            "bg_t1": float(args.bg_t1),
            "cursor_sizes": cursor_sizes,
        },
        "icons": {},
    }

    for spec in specs:
        key = spec.key
        payload = _generate_with_provider(
            provider,
            out_dir=raw_dir,
            model=str(args.model),
            ratio="1:1",
            image_size=str(args.image_size),
            prompt=spec.prompt,
            n=int(args.n),
            key=spec.filename_stem,
        )

        processed: list[dict[str, Any]] = []
        bg_meta_by_output: dict[str, Any] = {}
        for idx, raw_path_str in enumerate(payload["outputs"], start=1):
            raw_path = Path(raw_path_str)
            img = Image.open(raw_path)

            if args.no_bg_remove:
                rgba = img.convert("RGBA")
                bg_meta = {"skipped": True}
            else:
                rgba, bg_meta = _remove_corner_background(img, t0=float(args.bg_t0), t1=float(args.bg_t1))
            bg_meta_by_output[str(raw_path)] = bg_meta

            # Export processed square icon(s).
            out_size = max(32, int(args.final_size))
            fitted = _center_fit_square(rgba, out_size=out_size, pad_frac=float(args.pad_frac))

            if idx == 1:
                stem = spec.filename_stem
            else:
                stem = f"{spec.filename_stem}-cand{idx:02d}"

            out_path = icon_dir / f"{stem}.png"
            fitted.save(out_path, format="PNG", optimize=True)

            variants: list[str] = [str(out_path)]
            if spec.kind == "cursor":
                for cs in cursor_sizes:
                    cimg = fitted.resize((cs, cs), resample=Image.Resampling.LANCZOS)
                    cpath = icon_dir / f"{stem}-{cs}.png"
                    cimg.save(cpath, format="PNG", optimize=True)
                    variants.append(str(cpath))

            processed.append(
                {
                    "candidate": idx,
                    "raw": str(raw_path),
                    "processed": variants,
                }
            )

        manifest["icons"][key] = {
            "key": key,
            "kind": spec.kind,
            "filename_stem": spec.filename_stem,
            "prompt": spec.prompt,
            "scene": payload,
            "bg_remove_meta": bg_meta_by_output,
            "artifacts": processed,
        }

    _write_json(base_out / "manifest.json", manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
