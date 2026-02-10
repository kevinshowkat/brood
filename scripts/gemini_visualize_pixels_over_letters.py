#!/usr/bin/env python3
"""
Generate "Pixels > Letters" README visuals using Gemini 3 Pro Image Preview.

This script is meant to turn the profile README blurb into image-first assets:
  - a wide banner (hero)
  - a single infographic ("3 pillars")
  - optional "letters vs pixels" compare card
  - optional pipeline diagram

It uses the existing Brood Gemini provider (google-genai) for image generation,
then composes crisp text/layout locally with Pillow so the typography is
accurate and GitHub-friendly.

Requirements:
  - GEMINI_API_KEY or GOOGLE_API_KEY
  - pip install google-genai

Examples:
  python scripts/gemini_visualize_pixels_over_letters.py --out media/pixels_over_letters
  python scripts/gemini_visualize_pixels_over_letters.py --scenes banner,infographic --provider gemini
  python scripts/gemini_visualize_pixels_over_letters.py --provider dryrun --out /tmp/pixels_over_letters
"""

from __future__ import annotations

import argparse
import json
import sys
import textwrap
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping

from PIL import Image, ImageDraw, ImageFilter, ImageFont

# Ensure repo root is on sys.path when running as `python scripts/...`.
_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from brood_engine.providers.dryrun import DryRunProvider
from brood_engine.providers.gemini import GeminiProvider
from brood_engine.runs.receipts import ImageRequest


DEFAULT_BRIEF = (
    "Pixels > letters when it comes to LLM input. Portfolio of open-source multimodal developer tools: "
    "image-input-first creative IDEs (visual canvases for steering AI edits from reference images), "
    "reproducible image generation workflows (run receipts, evals, preference testing), and "
    "LLM observability (OpenTelemetry)."
)

DEFAULT_KEYWORDS = [
    "image IDE",
    "image-input-first",
    "visual prompting",
    "reference-image editing",
    "image generation",
    "text-to-image",
    "multimodal dev tools",
    "model routing",
    "model evals",
    "preference testing",
    "run receipts",
    "observability",
    "OpenTelemetry",
    "developer tools",
]


@dataclass(frozen=True)
class GeminiScene:
    key: str
    ratio: str
    prompt: str


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")


def _find_font_path(prefer_mono: bool = False) -> Path | None:
    # macOS first (this repo is typically run on macOS for the desktop app).
    candidates = []
    if prefer_mono:
        candidates.extend(
            [
                "/System/Library/Fonts/SFNSMono.ttf",
                "/System/Library/Fonts/SFNSMonoItalic.ttf",
                "/Library/Fonts/Arial Unicode.ttf",
            ]
        )
    else:
        candidates.extend(
            [
                "/System/Library/Fonts/SFNS.ttf",
                "/System/Library/Fonts/SFNSRounded.ttf",
                "/System/Library/Fonts/Supplemental/Arial.ttf",
                "/Library/Fonts/Arial.ttf",
            ]
        )
    # Linux fallbacks (useful for CI/servers).
    candidates.extend(
        [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf" if prefer_mono else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
    )
    for entry in candidates:
        path = Path(entry)
        if path.exists():
            return path
    return None


def _load_font(size: int, *, prefer_mono: bool = False, font_path: str | None = None) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    path = Path(font_path) if font_path else _find_font_path(prefer_mono=prefer_mono)
    if path and path.exists():
        try:
            return ImageFont.truetype(str(path), size=size)
        except Exception:
            pass
    return ImageFont.load_default()


def _center_crop_to_ratio(image: Image.Image, *, ratio: float) -> Image.Image:
    w, h = image.size
    if w <= 0 or h <= 0:
        return image
    current = w / h
    if abs(current - ratio) < 1e-6:
        return image
    if current > ratio:
        # Too wide; crop width.
        new_w = int(h * ratio)
        x0 = max((w - new_w) // 2, 0)
        return image.crop((x0, 0, x0 + new_w, h))
    # Too tall; crop height.
    new_h = int(w / ratio)
    y0 = max((h - new_h) // 2, 0)
    return image.crop((0, y0, w, y0 + new_h))


def _resize_to(image: Image.Image, *, size: tuple[int, int]) -> Image.Image:
    return image.resize(size, resample=Image.Resampling.LANCZOS)


def _make_background(size: tuple[int, int]) -> Image.Image:
    w, h = size
    top = (7, 10, 14)  # near-black blue
    bottom = (5, 17, 18)  # near-black teal
    base = Image.new("RGB", size, top)
    draw = ImageDraw.Draw(base)
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        draw.line((0, y, w, y), fill=(r, g, b))

    # Subtle grid overlay.
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    step = 80
    grid = (255, 255, 255, 18)
    for x in range(0, w + 1, step):
        od.line((x, 0, x, h), fill=grid, width=1)
    for y in range(0, h + 1, step):
        od.line((0, y, w, y), fill=grid, width=1)

    # Accent blobs (blurred).
    blob = Image.new("RGBA", size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    bd.ellipse((-200, -200, int(w * 0.6), int(h * 0.9)), fill=(0, 255, 176, 55))
    bd.ellipse((int(w * 0.55), int(h * 0.2), int(w * 1.2), int(h * 1.2)), fill=(255, 92, 92, 35))
    blob = blob.filter(ImageFilter.GaussianBlur(radius=140))

    out = base.convert("RGBA")
    out = Image.alpha_composite(out, blob)
    out = Image.alpha_composite(out, overlay)
    return out.convert("RGB")


def _draw_title(draw: ImageDraw.ImageDraw, *, x: int, y: int, font: ImageFont.ImageFont) -> None:
    # Render "Pixels > Letters" with a tiny bit of color semantics.
    pixels_color = (0, 255, 176)
    op_color = (245, 247, 250)
    letters_color = (160, 170, 190)
    text_pixels = "Pixels"
    text_op = " > "
    text_letters = "Letters"

    draw.text((x, y), text_pixels, font=font, fill=pixels_color)
    w1 = draw.textbbox((x, y), text_pixels, font=font)[2] - draw.textbbox((x, y), text_pixels, font=font)[0]
    draw.text((x + w1, y), text_op, font=font, fill=op_color)
    w2 = draw.textbbox((0, 0), text_op, font=font)[2] - draw.textbbox((0, 0), text_op, font=font)[0]
    draw.text((x + w1 + w2, y), text_letters, font=font, fill=letters_color)


def _compose_infographic(
    *,
    out_path: Path,
    brief: str,
    keywords: list[str],
    icon_canvas: Path,
    icon_receipts: Path,
    icon_telemetry: Path,
    include_tags: bool,
    font_path: str | None,
) -> None:
    size = (1600, 900)
    img = _make_background(size)
    draw = ImageDraw.Draw(img)

    title_font = _load_font(96, font_path=font_path)
    subtitle_font = _load_font(30, font_path=font_path)
    h_font = _load_font(34, font_path=font_path)
    body_font = _load_font(22, font_path=font_path)
    tag_font = _load_font(20, font_path=font_path, prefer_mono=True)

    margin_x = 80
    title_y = 70
    _draw_title(draw, x=margin_x, y=title_y, font=title_font)

    subtitle = "Multimodal dev tools that treat reference images as first-class input."
    subtitle_y = title_y + 110
    draw.text((margin_x, subtitle_y), subtitle, font=subtitle_font, fill=(230, 235, 242))

    # Brief excerpt (kept short so it doesn't turn into a wall of text).
    brief_excerpt = textwrap.shorten(" ".join(brief.split()), width=150, placeholder="…")
    brief_y = subtitle_y + 46
    draw.text((margin_x, brief_y), brief_excerpt, font=body_font, fill=(190, 200, 215))

    # 3 columns.
    w, _ = size
    col_area_top = 310
    col_area_bottom = 740 if include_tags else 820
    col_w = int((w - 2 * margin_x) / 3)
    icon_box = 240

    def paste_icon(src_path: Path, cx: int, top: int) -> None:
        icon = Image.open(src_path).convert("RGB")
        icon = _center_crop_to_ratio(icon, ratio=1.0)
        icon = _resize_to(icon, size=(icon_box, icon_box))
        # Card
        pad = 18
        card_w = icon_box + pad * 2
        card_h = icon_box + pad * 2
        x0 = cx - card_w // 2
        y0 = top
        card = Image.new("RGBA", (card_w, card_h), (255, 255, 255, 14))
        cd = ImageDraw.Draw(card)
        cd.rounded_rectangle((0, 0, card_w - 1, card_h - 1), radius=22, outline=(0, 255, 176, 70), width=2)
        card = card.filter(ImageFilter.GaussianBlur(radius=0))
        img.paste(card.convert("RGB"), (x0, y0))
        img.paste(icon, (x0 + pad, y0 + pad))

    centers = [margin_x + col_w // 2 + col_w * i for i in range(3)]
    icon_top = col_area_top
    paste_icon(icon_canvas, centers[0], icon_top)
    paste_icon(icon_receipts, centers[1], icon_top)
    paste_icon(icon_telemetry, centers[2], icon_top)

    headings = ["Creative IDEs", "Receipts + Evals", "Observability"]
    bodies = [
        "Steer edits and generations from reference images.",
        "Replays, receipts, and preference tests you can trust.",
        "OpenTelemetry-style visibility for multimodal pipelines.",
    ]

    text_top = icon_top + icon_box + 54
    for idx, cx in enumerate(centers):
        heading = headings[idx]
        body = bodies[idx]
        hb = draw.textbbox((0, 0), heading, font=h_font)
        hw = hb[2] - hb[0]
        draw.text((cx - hw // 2, text_top), heading, font=h_font, fill=(245, 247, 250))
        wrapped = textwrap.fill(body, width=34)
        lines = wrapped.splitlines()
        y = text_top + 44
        for line in lines:
            bb = draw.textbbox((0, 0), line, font=body_font)
            lw = bb[2] - bb[0]
            draw.text((cx - lw // 2, y), line, font=body_font, fill=(195, 205, 220))
            y += 30

    if include_tags and keywords:
        # Tags row (wrapped).
        tag_y = col_area_bottom + 18
        x = margin_x
        max_x = w - margin_x
        pill_pad_x = 12
        pill_pad_y = 8
        pill_h = 34
        for raw in keywords:
            tag = raw.strip()
            if not tag:
                continue
            tb = draw.textbbox((0, 0), tag, font=tag_font)
            tw = tb[2] - tb[0]
            pill_w = tw + pill_pad_x * 2
            if x + pill_w > max_x:
                x = margin_x
                tag_y += pill_h + 12
            # Pill (RGBA overlay -> composite), so we can use subtle alpha on fill/outline.
            overlay = Image.new("RGBA", img.size, (0, 0, 0, 0))
            od = ImageDraw.Draw(overlay)
            od.rounded_rectangle(
                (x, tag_y, x + pill_w, tag_y + pill_h),
                radius=14,
                fill=(255, 255, 255, 18),
                outline=(255, 255, 255, 70),
                width=1,
            )
            od.text((x + pill_pad_x, tag_y + pill_pad_y), tag, font=tag_font, fill=(235, 240, 248, 255))
            img_rgba = img.convert("RGBA")
            img = Image.alpha_composite(img_rgba, overlay).convert("RGB")
            draw = ImageDraw.Draw(img)
            x += pill_w + 12

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, format="PNG", optimize=True)


def _compose_banner(
    *,
    out_path: Path,
    icon_canvas: Path,
    icon_receipts: Path,
    icon_telemetry: Path,
    font_path: str | None,
) -> None:
    size = (1200, 400)
    img = _make_background(size)
    draw = ImageDraw.Draw(img)

    title_font = _load_font(72, font_path=font_path)
    sub_font = _load_font(22, font_path=font_path)

    margin = 52
    _draw_title(draw, x=margin, y=92, font=title_font)
    draw.text(
        (margin, 190),
        "Pixels-first multimodal dev tools: canvas, receipts, telemetry.",
        font=sub_font,
        fill=(200, 210, 225),
    )

    # Icon strip (right side).
    icons = [icon_canvas, icon_receipts, icon_telemetry]
    icon_size = 88
    gap = 18
    x = size[0] - margin - (icon_size * 3 + gap * 2)
    y = size[1] - margin - icon_size
    for p in icons:
        icon = Image.open(p).convert("RGB")
        icon = _center_crop_to_ratio(icon, ratio=1.0)
        icon = _resize_to(icon, size=(icon_size, icon_size))
        img.paste(icon, (x, y))
        # Outline box.
        draw.rounded_rectangle(
            (x - 6, y - 6, x + icon_size + 6, y + icon_size + 6),
            radius=18,
            outline=(0, 255, 176),
            width=2,
        )
        x += icon_size + gap

    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path, format="PNG", optimize=True)


def _parse_scenes(value: str) -> list[str]:
    raw = (value or "").strip()
    if not raw:
        return ["all"]
    parts = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return parts or ["all"]


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


def _export_final_card(raw_path: Path, final_path: Path, *, w: int, h: int) -> None:
    img = Image.open(raw_path).convert("RGB")
    img = _center_crop_to_ratio(img, ratio=w / h)
    img = _resize_to(img, size=(w, h))
    final_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(final_path, format="PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate Pixels > Letters README visuals (Gemini).")
    parser.add_argument("--out", type=str, default="", help="Output directory (default: media/pixels_over_letters/<timestamp>).")
    parser.add_argument("--provider", type=str, default="gemini", help="Provider: gemini or dryrun (default: gemini).")
    parser.add_argument("--model", type=str, default="gemini-3-pro-image-preview", help="Gemini image model.")
    parser.add_argument("--image-size", type=str, default="2K", help="Gemini image_size hint: 1K/2K/4K (default: 2K).")
    parser.add_argument("--n", type=int, default=1, help="Candidates per Gemini scene (default: 1).")
    parser.add_argument("--scenes", type=str, default="all", help="Comma list: all,banner,infographic,compare,pipeline (default: all).")
    parser.add_argument("--brief", type=str, default=DEFAULT_BRIEF, help="Creative brief text.")
    parser.add_argument("--keywords", type=str, default="", help="Comma-separated keywords for tag pills (default: uses script defaults).")
    parser.add_argument("--no-tags", action="store_true", help="Disable keyword pill tags on the infographic.")
    parser.add_argument("--font", type=str, default="", help="Optional path to a .ttf/.ttc font to use for overlay text.")
    args = parser.parse_args()

    base_out = Path(args.out) if args.out else (Path("media") / "pixels_over_letters" / _now_stamp())
    raw_dir = base_out / "raw"
    final_dir = base_out / "final"
    raw_dir.mkdir(parents=True, exist_ok=True)
    final_dir.mkdir(parents=True, exist_ok=True)

    scenes = _parse_scenes(args.scenes)
    include_all = "all" in scenes
    want_banner = include_all or "banner" in scenes
    want_infographic = include_all or "infographic" in scenes
    want_compare = include_all or "compare" in scenes
    want_pipeline = include_all or "pipeline" in scenes

    brief = str(args.brief or "").strip() or DEFAULT_BRIEF
    keywords = []
    if args.keywords.strip():
        keywords = [k.strip() for k in args.keywords.split(",") if k.strip()]
    else:
        keywords = list(DEFAULT_KEYWORDS)
    include_tags = not bool(args.no_tags)
    font_path = args.font.strip() or None

    provider = _pick_provider(args.provider)

    manifest: dict[str, Any] = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "provider": str(args.provider),
        "model": str(args.model),
        "image_size": str(args.image_size),
        "n": int(args.n),
        "out_dir": str(base_out),
        "brief": brief,
        "keywords": keywords,
        "scenes": {},
        "final": {},
    }

    # Icons (used by banner + infographic).
    icon_paths: dict[str, Path] = {}
    if want_banner or want_infographic:
        icon_style = (
            "Style guide: crisp minimal vector icon, high contrast, black background, white line art, "
            "single accent color acid green. No readable text, no logos, no watermarks."
        )
        icon_scenes = [
            GeminiScene(
                key="icon_canvas",
                ratio="1:1",
                prompt=(
                    f"{icon_style}\n"
                    f"Brief: {brief}\n"
                    "Icon concept: a creative canvas with two stacked reference images, a selection lasso, "
                    "and a transform handle, implying 'steer edits from reference images'."
                ),
            ),
            GeminiScene(
                key="icon_receipts",
                ratio="1:1",
                prompt=(
                    f"{icon_style}\n"
                    f"Brief: {brief}\n"
                    "Icon concept: a receipt/document with checkboxes, a replay arrow, and a tiny comparison chart, "
                    "implying 'run receipts, evals, preference tests'."
                ),
            ),
            GeminiScene(
                key="icon_telemetry",
                ratio="1:1",
                prompt=(
                    f"{icon_style}\n"
                    f"Brief: {brief}\n"
                    "Icon concept: an observability trace timeline with spans and dots, plus a small metric sparkline, "
                    "implying 'OpenTelemetry for multimodal pipelines'."
                ),
            ),
        ]
        for scene in icon_scenes:
            payload = _generate_with_provider(
                provider,
                out_dir=raw_dir,
                model=args.model,
                ratio=scene.ratio,
                image_size=args.image_size,
                prompt=scene.prompt,
                n=1,
                key=scene.key,
            )
            manifest["scenes"][scene.key] = payload
            icon_paths[scene.key] = Path(payload["outputs"][0])

    # Compare card.
    if want_compare:
        prompt = (
            "Design a clean split-screen infographic (no readable text).\n"
            f"Brief: {brief}\n"
            "Left side represents letters: a dense paragraph + code block rendered as abstract grey lines.\n"
            "Right side represents pixels: a 2x2 grid of abstract image thumbnails (no faces, no logos).\n"
            "Both sides funnel into the same stylized LLM 'brain' icon in the center-bottom.\n"
            "High-contrast minimal vector design, black background, white lines, one acid-green accent.\n"
            "No watermarks, no extra text."
        )
        payload = _generate_with_provider(
            provider,
            out_dir=raw_dir,
            model=args.model,
            ratio="16:9",
            image_size=args.image_size,
            prompt=prompt,
            n=max(1, int(args.n)),
            key="compare",
        )
        manifest["scenes"]["compare"] = payload
        # Export first candidate to a stable final size.
        _export_final_card(Path(payload["outputs"][0]), final_dir / "compare.png", w=1600, h=900)
        manifest["final"]["compare"] = str((final_dir / "compare.png"))

    # Pipeline diagram.
    if want_pipeline:
        prompt = (
            "Design a horizontal pipeline diagram (no readable text).\n"
            f"Brief: {brief}\n"
            "Top row: stack of reference images icon -> magic wand/action icon -> output image icon.\n"
            "Bottom row: receipt/document icon -> evaluation/scales icon -> observability trace timeline icon.\n"
            "Use simple arrows connecting each stage. Clean minimal vector design, black background, white line art, "
            "one acid-green accent. No logos, no watermarks."
        )
        payload = _generate_with_provider(
            provider,
            out_dir=raw_dir,
            model=args.model,
            ratio="16:9",
            image_size=args.image_size,
            prompt=prompt,
            n=max(1, int(args.n)),
            key="pipeline",
        )
        manifest["scenes"]["pipeline"] = payload
        _export_final_card(Path(payload["outputs"][0]), final_dir / "pipeline.png", w=1600, h=900)
        manifest["final"]["pipeline"] = str((final_dir / "pipeline.png"))

    # Compose infographic + banner from icons.
    if want_infographic:
        _compose_infographic(
            out_path=final_dir / "infographic.png",
            brief=brief,
            keywords=keywords,
            icon_canvas=icon_paths["icon_canvas"],
            icon_receipts=icon_paths["icon_receipts"],
            icon_telemetry=icon_paths["icon_telemetry"],
            include_tags=include_tags,
            font_path=font_path,
        )
        manifest["final"]["infographic"] = str((final_dir / "infographic.png"))

    if want_banner:
        _compose_banner(
            out_path=final_dir / "banner.png",
            icon_canvas=icon_paths["icon_canvas"],
            icon_receipts=icon_paths["icon_receipts"],
            icon_telemetry=icon_paths["icon_telemetry"],
            font_path=font_path,
        )
        manifest["final"]["banner"] = str((final_dir / "banner.png"))

    # README snippet for GitHub markdown.
    def rel_for_readme(path: str) -> str:
        p = Path(path)
        try:
            return str(p.resolve().relative_to(Path.cwd().resolve())).replace("\\", "/")
        except Exception:
            return str(p).replace("\\", "/")

    snippet = []
    snippet.append("<!-- Generated by scripts/gemini_visualize_pixels_over_letters.py -->")
    snippet.append("")
    if "banner" in manifest["final"]:
        rel = rel_for_readme(manifest["final"]["banner"])
        snippet.append(f'<p align="left"><img src="{rel}" alt="Pixels > Letters banner"></p>')
        snippet.append("")
    if "infographic" in manifest["final"]:
        rel = rel_for_readme(manifest["final"]["infographic"])
        snippet.append(f'<p align="left"><img src="{rel}" alt="Pixels > Letters infographic"></p>')
        snippet.append("")
    if "compare" in manifest["final"]:
        rel = rel_for_readme(manifest["final"]["compare"])
        snippet.append(f'<p align="left"><img src="{rel}" alt="Letters vs Pixels"></p>')
        snippet.append("")
    if "pipeline" in manifest["final"]:
        rel = rel_for_readme(manifest["final"]["pipeline"])
        snippet.append(f'<p align="left"><img src="{rel}" alt="Pipeline diagram"></p>')
        snippet.append("")

    (base_out / "README_snippet.md").write_text("\n".join(snippet).strip() + "\n", encoding="utf-8")
    _write_json(base_out / "manifest.json", manifest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
