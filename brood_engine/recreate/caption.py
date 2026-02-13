"""Prompt inference for recreate flow.

Goal: allow `/recreate <image>` to work well even when the reference image has no
embedded prompt metadata (most screenshots). We first try to extract any prompt
stored inside the file, then fall back to a lightweight vision caption call when
API keys are available.
"""

from __future__ import annotations

import base64
import json
import os
import sys
import subprocess
import tempfile
from urllib.parse import urlparse
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from PIL import Image


@dataclass(frozen=True)
class PromptInference:
    prompt: str
    source: str
    model: str | None = None


@dataclass(frozen=True)
class DescriptionInference:
    description: str
    source: str
    model: str | None = None


@dataclass(frozen=True)
class TextInference:
    text: str
    source: str
    model: str | None = None


@dataclass(frozen=True)
class DnaExtractionInference:
    palette: list[str]
    colors: list[str]
    materials: list[str]
    summary: str
    source: str
    model: str | None = None


@dataclass(frozen=True)
class SoulExtractionInference:
    emotion: str
    summary: str
    source: str
    model: str | None = None


def infer_prompt(reference_path: Path) -> PromptInference:
    try:
        with Image.open(reference_path) as image:
            info = image.info
        prompt = info.get("parameters") or info.get("prompt")
        if prompt:
            extracted = _extract_prompt_from_metadata(str(prompt))
            if extracted:
                return PromptInference(prompt=extracted, source="metadata", model=None)
    except Exception:
        pass
    inferred = _infer_prompt_with_vision(reference_path)
    if inferred is not None:
        return inferred
    return PromptInference(
        prompt=f"Recreate an image similar to {reference_path.name}.",
        source="fallback",
        model=None,
    )


def infer_description(reference_path: Path, *, max_chars: int = 48) -> DescriptionInference | None:
    """Return a short vision description for HUD readouts (not a generation prompt)."""
    max_chars = int(max(12, min(max_chars, 120)))
    # Prefer OpenAI when available (no extra deps).
    openai = _describe_with_openai(reference_path, max_chars=max_chars)
    if openai is not None:
        return openai
    # Fall back to Gemini if the optional dependency is installed.
    gemini = _describe_with_gemini(reference_path, max_chars=max_chars)
    if gemini is not None:
        return gemini
    return None


def infer_diagnosis(reference_path: Path) -> TextInference | None:
    """Return a creative-director style critique of an image.

    This is intentionally NOT a neutral description; it's meant to call out what's
    working, what's not, and what to change next.
    """
    openai = _diagnose_with_openai(reference_path)
    if openai is not None:
        return openai
    # Fall back to Gemini if OpenAI isn't configured/available.
    gemini = _diagnose_with_gemini(reference_path)
    if gemini is not None:
        return gemini
    return None


def infer_canvas_context(reference_path: Path) -> TextInference | None:
    """Return compact background context for a canvas snapshot.

    Used by desktop "always-on" vision to anticipate what a user might do next.
    """
    openai = _canvas_context_with_openai(reference_path)
    if openai is not None:
        return openai
    gemini = _canvas_context_with_gemini(reference_path)
    if gemini is not None:
        return gemini
    return None


def infer_argument(path_a: Path, path_b: Path) -> TextInference | None:
    """Return a debate between two image directions."""
    gemini = _argue_with_gemini(path_a, path_b)
    if gemini is not None:
        return gemini
    openai = _argue_with_openai(path_a, path_b)
    if openai is not None:
        return openai
    return None


def infer_dna_signature(reference_path: Path) -> DnaExtractionInference | None:
    """Extract a compact colors/materials "DNA" signature from an image."""
    openai = _extract_dna_with_openai(reference_path)
    if openai is not None:
        return openai
    gemini = _extract_dna_with_gemini(reference_path)
    if gemini is not None:
        return gemini
    return None


def infer_soul_signature(reference_path: Path) -> SoulExtractionInference | None:
    """Extract the dominant emotional "soul" signature from an image."""
    openai = _extract_soul_with_openai(reference_path)
    if openai is not None:
        return openai
    gemini = _extract_soul_with_gemini(reference_path)
    if gemini is not None:
        return gemini
    return None


def _extract_prompt_from_metadata(raw: str) -> str:
    """Try to pull a usable positive prompt from common embedded formats."""
    text = str(raw or "").strip()
    if not text:
        return ""
    # Stable Diffusion PNG "parameters" field often includes settings; keep just the prompt section.
    lowered = text.lower()
    for marker in ("negative prompt:", "\nsteps:", "\r\nsteps:", "steps:"):
        idx = lowered.find(marker)
        if idx > 0:
            text = text[:idx].strip()
            break
    # Collapse whitespace for readability.
    text = " ".join(text.split())
    return text


def _infer_prompt_with_vision(reference_path: Path) -> PromptInference | None:
    # Prefer OpenAI when available (no extra deps).
    openai = _caption_with_openai(reference_path)
    if openai is not None:
        return openai
    # Fall back to Gemini if the optional dependency is installed.
    gemini = _caption_with_gemini(reference_path)
    if gemini is not None:
        return gemini
    return None


def _caption_instruction() -> str:
    # The output should be directly usable as a generation prompt, not a generic caption.
    return (
        "Write ONE text-to-image prompt that would recreate the attached image as closely as possible. "
        "Include subject, environment, composition, perspective/camera, lighting, color palette, and style/medium. "
        "Do not mention that you are looking at an image or screenshot. Do not include commentary or formatting. "
        "Output only the prompt."
    )


def _description_instruction(max_chars: int) -> str:
    # The output should be HUD-short, not a paragraph.
    return (
        f"Write a short label for the attached image in 3-6 words (<= {max_chars} characters). "
        "Name the main thing and one key attribute (material, color, category, or action). "
        "No punctuation. No quotes. No branding. Do not copy text that appears in the image. "
        "Avoid generic filler words like image, photo, screenshot, label, subject. "
        "Output ONLY the label."
    )


def _diagnose_instruction() -> str:
    return (
        "Diagnose this image like an honest creative director.\n"
        "Do NOT describe the image. Diagnose what's working and what isn't, using specific visual evidence.\n"
        "Write in plain, easy English. Short lines. Lots of whitespace. No jargon.\n"
        "Think like a tiny council first:\n"
        "1) Art director (taste, composition)\n"
        "2) Commercial lens (clarity, conversion)\n"
        "Then write ONE merged answer.\n\n"
        "If it looks like a product photo meant to sell something, judge it as a product shot "
        "(lighting, background, crop, color accuracy, reflections/shadows, edge cutout quality, legibility).\n"
        "Otherwise, judge it by the most likely use case (ad, poster, UI, editorial, etc).\n\n"
        "Format (keep under ~180 words):\n"
        "USE CASE (guess): <product shot | ad | poster | UI | editorial | other>\n\n"
        "TOP ISSUE:\n"
        "<one sentence>\n\n"
        "WHAT'S WORKING:\n"
        "- <2-4 bullets>\n\n"
        "WHAT TO FIX NEXT:\n"
        "- <3-5 bullets>\n\n"
        "NEXT TEST:\n"
        "- <2 bullets>\n\n"
        "Rules: keep bullets to one line each. Be concrete about composition/hierarchy, focal point, color, "
        "lighting, depth, typography/legibility (if present), and realism/materials. No generic praise."
    )


def _canvas_context_instruction() -> str:
    return (
        "You are Brood's always-on background vision.\n"
        "Analyze the attached CANVAS SNAPSHOT (it may contain multiple photos arranged in a grid).\n"
        "Output compact, machine-readable notes we can use for future action recommendations.\n\n"
        "Format (keep under ~210 words):\n"
        "CANVAS:\n"
        "<one sentence summary>\n\n"
        "USE CASE (guess):\n"
        "<one short line: what the user is likely trying to do (e.g., product listing, ad creative, editorial still, UI screenshot, moodboard)>\n\n"
        "SUBJECTS:\n"
        "- <2-6 bullets>\n\n"
        "STYLE:\n"
        "- <3-7 short tags>\n\n"
        "NEXT ACTIONS:\n"
        "- <Action>: <why>  (max 5)\n\n"
        "Actions must be chosen from: Combine, Bridge, Swap DNA, Recast, Variations, Background: White, Background: Sweep, Crop: Square, Annotate.\n"
        "Rules: infer the use case from both the image and any recent edits. No fluff, no marketing language. "
        "Be specific about composition, lighting, color, materials. NEXT ACTIONS should serve the hypothesized use case."
    )


def _argue_instruction() -> str:
    return (
        "Argue between two creative directions based on Image A and Image B.\n"
        "You are not neutral: make the strongest case for each, using specific visual evidence.\n"
        "Write in plain, easy English. Short lines. Lots of whitespace. No jargon.\n"
        "If these are product shots, judge them as product shots; otherwise use the most likely use case.\n\n"
        "Format (keep under ~220 words):\n"
        "IMAGE A WINS IF:\n"
        "- <3-5 bullets>\n\n"
        "IMAGE B WINS IF:\n"
        "- <3-5 bullets>\n\n"
        "MY PICK:\n"
        "<A or B> — <one sentence>\n\n"
        "WHY:\n"
        "<2-3 short sentences>\n\n"
        "NEXT TEST:\n"
        "- <2 bullets>\n"
    )


def _dna_extract_instruction() -> str:
    return (
        "Extract this image's visual DNA for transfer.\n"
        "Focus only on COLORS and MATERIALS that are visually dominant.\n"
        "Respond with JSON only (no markdown):\n"
        "{\n"
        '  "palette": ["#RRGGBB", "..."],\n'
        '  "colors": ["short color phrases"],\n'
        '  "materials": ["short material phrases"],\n'
        '  "summary": "one short sentence for edit transfer"\n'
        "}\n"
        "Rules: 3-8 palette entries. 2-8 colors. 2-8 materials. "
        "Summary must be <= 16 words and directly usable in an edit instruction."
    )


def _soul_extract_instruction() -> str:
    return (
        "Extract this image's dominant emotional soul.\n"
        "Respond with JSON only (no markdown):\n"
        "{\n"
        '  "emotion": "single dominant emotion phrase",\n'
        '  "summary": "one short sentence for edit transfer"\n'
        "}\n"
        "Rules: emotion should be concise and concrete (e.g., serene tension, triumphant warmth). "
        "Summary must be <= 14 words and directly usable in an edit instruction."
    )


def _prepare_vision_image(reference_path: Path, *, max_dim: int = 1024) -> tuple[bytes, str]:
    """Return (bytes, mime_type) for sending to vision models.

    We downscale and re-encode to JPEG to keep payload sizes reasonable for screenshots.
    """
    try:
        with Image.open(reference_path) as image:
            # Flatten alpha for JPEG.
            rgba = image.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
            background.alpha_composite(rgba)
            rgb = background.convert("RGB")
            rgb.thumbnail((max_dim, max_dim))
            buf = BytesIO()
            rgb.save(buf, format="JPEG", quality=90)
            return buf.getvalue(), "image/jpeg"
    except Exception:
        # PIL doesn't support HEIC/HEIF out of the box. On macOS we can use `sips`
        # to convert to a JPEG that vision models reliably accept.
        if sys.platform == "darwin" and reference_path.suffix.lower() in {".heic", ".heif"}:
            try:
                with tempfile.TemporaryDirectory() as tmpdir:
                    out_path = Path(tmpdir) / "vision.jpg"
                    cmd = [
                        "/usr/bin/sips",
                        "-Z",
                        str(int(max_dim)),
                        "-s",
                        "format",
                        "jpeg",
                        "-s",
                        "formatOptions",
                        "90",
                        str(reference_path),
                        "--out",
                        str(out_path),
                    ]
                    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    data = out_path.read_bytes()
                    if data:
                        return data, "image/jpeg"
            except Exception:
                # Fall through to raw bytes.
                pass

        data = reference_path.read_bytes()
        mime = _guess_mime(reference_path)
        return data, mime


def _guess_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in {".jpg", ".jpeg"}:
        return "image/jpeg"
    if suffix == ".webp":
        return "image/webp"
    return "image/png"


def _clean_caption(text: str) -> str:
    cleaned = " ".join(str(text or "").split()).strip()
    if cleaned.startswith(("\"", "'")) and cleaned.endswith(("\"", "'")) and len(cleaned) >= 2:
        cleaned = cleaned[1:-1].strip()
    # Keep prompts compact; users can refine if needed.
    if len(cleaned) > 800:
        cleaned = cleaned[:800].rstrip()
    return cleaned


def _strip_generic_description_words(text: str) -> str:
    """Remove generic filler words that tend to make HUD labels noisy."""
    stop = {
        "image",
        "photo",
        "screenshot",
        "label",
        "subject",
        "hud",
        # Repo/app name; the instruction explicitly says "No branding".
        "brood",
    }
    words = [w for w in str(text or "").split() if w]
    kept: list[str] = []
    for w in words:
        if w.lower() in stop:
            continue
        kept.append(w)
    return " ".join(kept).strip()


def _clean_description(text: str, *, max_chars: int) -> str:
    cleaned = " ".join(str(text or "").split()).strip()
    if cleaned.lower().startswith(("description:", "label:", "caption:")) and ":" in cleaned:
        cleaned = cleaned.split(":", 1)[1].strip()
    if cleaned.startswith(("\"", "'")) and cleaned.endswith(("\"", "'")) and len(cleaned) >= 2:
        cleaned = cleaned[1:-1].strip()
    # Keep it HUD-short (and model-proof against punctuation-y answers).
    cleaned = cleaned.replace(".", " ").replace(",", " ").replace(":", " ").replace(";", " ")
    cleaned = " ".join(cleaned.split()).strip()
    stripped = _strip_generic_description_words(cleaned)
    if stripped:
        cleaned = stripped
    if len(cleaned) > max_chars:
        clipped = cleaned[: max_chars + 1].strip()
        if " " in clipped:
            clipped = clipped.rsplit(" ", 1)[0].strip()
        cleaned = clipped[:max_chars].strip()
    return cleaned


def _openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")


def _openai_api_base() -> str:
    """Return the OpenAI API base URL (without trailing slash).

    Supports both legacy `OPENAI_API_BASE` and the newer `OPENAI_BASE_URL` env var
    used by official SDKs. If the configured base is just a host (no path), we
    append `/v1` so callers can safely add endpoint paths like `/responses`.
    """
    raw = os.getenv("OPENAI_API_BASE") or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    base = str(raw).strip().rstrip("/")
    try:
        parsed = urlparse(base)
        if parsed.scheme and parsed.netloc and parsed.path in {"", "/"}:
            base = f"{base}/v1"
    except Exception:
        # If parsing fails, keep the string as-is.
        pass
    return base.rstrip("/")


def _caption_with_openai(reference_path: Path) -> PromptInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = os.getenv("BROOD_CAPTION_MODEL") or os.getenv("OPENAI_CAPTION_MODEL") or "gpt-4o-mini"
    image_bytes, mime = _prepare_vision_image(reference_path)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _caption_instruction()},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        "max_output_tokens": 220,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=35.0)
    except Exception:
        return None
    text = _extract_openai_output_text(response)
    cleaned = _clean_caption(text)
    if not cleaned:
        return None
    return PromptInference(prompt=cleaned, source="openai_vision", model=model)


def _describe_with_openai(reference_path: Path, *, max_chars: int) -> DescriptionInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    requested_model = os.getenv("BROOD_DESCRIBE_MODEL") or os.getenv("OPENAI_DESCRIBE_MODEL") or "gpt-5-nano"
    image_bytes, mime = _prepare_vision_image(reference_path)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    endpoint = f"{_openai_api_base()}/responses"

    models_to_try = [requested_model]
    # Robustness: if the requested model is unavailable/unsupported, fall back to a known vision-capable model.
    if requested_model != "gpt-4o-mini":
        models_to_try.append("gpt-4o-mini")

    for model in models_to_try:
        base_payload: dict[str, Any] = {
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": _description_instruction(max_chars)},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
            # Note: some reasoning-capable models spend tokens on hidden reasoning. Keep this
            # relatively high so we still get a short visible label.
            "max_output_tokens": 120,
        }

        # Prefer fast/short responses; if the API doesn't accept these fields, fall back to a minimal payload.
        payload_variants: list[dict[str, Any]] = []
        payload = dict(base_payload)
        payload["text"] = {"format": {"type": "text"}, "verbosity": "low"}
        # gpt-5-nano tends to consume output tokens on reasoning; "minimal" helps avoid truncation.
        payload["reasoning"] = {"effort": "minimal", "summary": "auto"}
        payload_variants.append(payload)
        payload_variants.append(base_payload)

        for candidate in payload_variants:
            try:
                _, response = _post_openai_json(endpoint, candidate, api_key, timeout_s=22.0)
            except Exception:
                continue
            text = _extract_openai_output_text(response)
            cleaned = _clean_description(text, max_chars=max_chars)
            if cleaned:
                return DescriptionInference(description=cleaned, source="openai_vision", model=model)

            incomplete = response.get("incomplete_details")
            if isinstance(incomplete, dict) and incomplete.get("reason") == "max_output_tokens":
                # Retry once with a larger token budget; if it still can't produce a label, fall back.
                try:
                    retry = dict(candidate)
                    retry["max_output_tokens"] = max(int(candidate.get("max_output_tokens", 0)) * 2, 240)
                    _, retry_resp = _post_openai_json(endpoint, retry, api_key, timeout_s=22.0)
                    text = _extract_openai_output_text(retry_resp)
                    cleaned = _clean_description(text, max_chars=max_chars)
                    if cleaned:
                        return DescriptionInference(description=cleaned, source="openai_vision", model=model)
                except Exception:
                    pass

    return None


def _post_openai_json(
    url: str,
    payload: Mapping[str, Any],
    api_key: str,
    *,
    timeout_s: float,
) -> tuple[int, dict[str, Any]]:
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


def _extract_openai_output_text(response: Mapping[str, Any]) -> str:
    # Responses API often includes output_text directly.
    value = response.get("output_text")
    if isinstance(value, str):
        return value.strip()
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") in {"output_text", "text"}:
            text = item.get("text")
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())
            continue
        if item.get("type") != "message":
            continue
        content = item.get("content")
        if isinstance(content, list):
            for chunk in content:
                if not isinstance(chunk, dict):
                    continue
                if chunk.get("type") not in {"output_text", "text"}:
                    continue
                text = chunk.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
    return "\n".join(parts).strip()


def _caption_with_gemini(reference_path: Path) -> PromptInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_CAPTION_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path)
    instruction = _caption_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        cleaned = _clean_caption(text)
        if cleaned:
            return PromptInference(prompt=cleaned, source="gemini_vision", model=model)

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                cleaned = _clean_caption(chunk)
                if cleaned:
                    return PromptInference(prompt=cleaned, source="gemini_vision", model=model)

    return None


def _describe_with_gemini(reference_path: Path, *, max_chars: int) -> DescriptionInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_DESCRIBE_MODEL") or os.getenv("BROOD_GEMINI_CAPTION_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path)
    instruction = _description_instruction(max_chars)

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        cleaned = _clean_description(text, max_chars=max_chars)
        if cleaned:
            return DescriptionInference(description=cleaned, source="gemini_vision", model=model)

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                cleaned = _clean_description(chunk, max_chars=max_chars)
                if cleaned:
                    return DescriptionInference(description=cleaned, source="gemini_vision", model=model)

    return None


def _clean_text_inference(text: str, *, max_chars: int | None = None) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""
    if max_chars is not None and max_chars > 0 and len(cleaned) > max_chars:
        cleaned = cleaned[:max_chars].rstrip()
    return cleaned


def _strip_code_fence(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return ""
    if raw.startswith("```") and raw.endswith("```"):
        lines = raw.splitlines()
        if len(lines) >= 2:
            body = "\n".join(lines[1:-1]).strip()
            if body.lower().startswith("json"):
                body = body[4:].strip()
            return body
    return raw


def _extract_json_object(text: str) -> dict[str, Any] | None:
    raw = _strip_code_fence(text)
    if not raw:
        return None
    candidates = [raw]
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        candidates.append(raw[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _coerce_text_list(value: Any, *, max_items: int = 8, max_chars: int = 48) -> list[str]:
    if value is None:
        return []
    items: list[str] = []
    if isinstance(value, list):
        for part in value:
            if isinstance(part, str):
                items.append(part)
    elif isinstance(value, str):
        items.extend(str(value).split(","))
    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = " ".join(str(item or "").split()).strip()
        if not text:
            continue
        if len(text) > max_chars:
            text = text[:max_chars].strip()
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(text)
        if len(cleaned) >= max_items:
            break
    return cleaned


def _normalize_hex(value: str) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    if not raw.startswith("#"):
        return None
    body = raw[1:]
    if len(body) == 3 and all(ch in "0123456789abcdefABCDEF" for ch in body):
        body = "".join(ch * 2 for ch in body)
    if len(body) != 6 or not all(ch in "0123456789abcdefABCDEF" for ch in body):
        return None
    return f"#{body.upper()}"


def _parse_dna_payload(payload: dict[str, Any]) -> tuple[list[str], list[str], list[str], str] | None:
    palette_raw = _coerce_text_list(payload.get("palette"), max_items=8, max_chars=12)
    palette: list[str] = []
    for item in palette_raw:
        code = _normalize_hex(item)
        if not code or code in palette:
            continue
        palette.append(code)
    colors = _coerce_text_list(payload.get("colors"), max_items=8, max_chars=42)
    materials = _coerce_text_list(payload.get("materials"), max_items=8, max_chars=42)
    summary_value = payload.get("summary")
    summary = _clean_text_inference(str(summary_value) if isinstance(summary_value, str) else "", max_chars=180)
    if not summary:
        color_part = ", ".join(colors[:3]) if colors else "the extracted palette"
        material_part = ", ".join(materials[:3]) if materials else "the extracted materials"
        summary = f"Rebuild with {color_part} and {material_part}."
    if not palette and not colors and not materials:
        return None
    return palette, colors, materials, summary


def _parse_soul_payload(payload: dict[str, Any]) -> tuple[str, str] | None:
    raw_emotion = payload.get("emotion")
    if not isinstance(raw_emotion, str) or not raw_emotion.strip():
        raw_emotion = payload.get("primary_emotion")
    if not isinstance(raw_emotion, str) or not raw_emotion.strip():
        return None
    emotion = _clean_text_inference(raw_emotion, max_chars=64)
    summary_value = payload.get("summary")
    summary = _clean_text_inference(str(summary_value) if isinstance(summary_value, str) else "", max_chars=180)
    if not summary:
        summary = f"Make the scene emotionally {emotion}."
    return emotion, summary


def _diagnose_with_openai(reference_path: Path) -> TextInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = os.getenv("BROOD_DIAGNOSE_MODEL") or os.getenv("OPENAI_DIAGNOSE_MODEL") or "gpt-4o-mini"
    image_bytes, mime = _prepare_vision_image(reference_path)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _diagnose_instruction()},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        "max_output_tokens": 900,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=45.0)
    except Exception:
        return None
    text = _extract_openai_output_text(response)
    cleaned = _clean_text_inference(text, max_chars=8000)
    if not cleaned:
        return None
    return TextInference(text=cleaned, source="openai_vision", model=model)


def _canvas_context_with_openai(reference_path: Path) -> TextInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    requested_model = os.getenv("BROOD_CANVAS_CONTEXT_MODEL") or os.getenv("OPENAI_CANVAS_CONTEXT_MODEL") or "gpt-4o-mini"
    requested_model = str(requested_model or "").strip() or "gpt-4o-mini"
    # Realtime models require the Realtime API (WebRTC/WebSocket). This path uses
    # the standard Responses endpoint, so avoid attempting to call realtime models.
    if "realtime" in requested_model.lower():
        requested_model = "gpt-4o-mini"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=768)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"

    endpoint = f"{_openai_api_base()}/responses"
    models_to_try = [requested_model]
    if requested_model != "gpt-4o-mini":
        models_to_try.append("gpt-4o-mini")

    for model in models_to_try:
        payload: dict[str, Any] = {
            "model": model,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": _canvas_context_instruction()},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
            "max_output_tokens": 520,
        }
        try:
            _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=28.0)
        except Exception:
            continue
        text = _extract_openai_output_text(response)
        cleaned = _clean_text_inference(text, max_chars=12000)
        if cleaned:
            return TextInference(text=cleaned, source="openai_vision", model=model)

    return None


def _canvas_context_with_gemini(reference_path: Path) -> TextInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_CANVAS_CONTEXT_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=768)
    instruction = _canvas_context_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        cleaned = _clean_text_inference(text, max_chars=12000)
        if cleaned:
            return TextInference(text=cleaned, source="gemini_vision", model=model)

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                cleaned = _clean_text_inference(chunk, max_chars=12000)
                if cleaned:
                    return TextInference(text=cleaned, source="gemini_vision", model=model)

    return None


def _argue_with_openai(path_a: Path, path_b: Path) -> TextInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = os.getenv("BROOD_ARGUE_MODEL") or os.getenv("OPENAI_ARGUE_MODEL") or "gpt-4o-mini"
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    a_url = f"data:{a_mime};base64,{base64.b64encode(a_bytes).decode('ascii')}"
    b_url = f"data:{b_mime};base64,{base64.b64encode(b_bytes).decode('ascii')}"

    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": "Image A:"},
                    {"type": "input_image", "image_url": a_url},
                    {"type": "input_text", "text": "Image B:"},
                    {"type": "input_image", "image_url": b_url},
                    {"type": "input_text", "text": _argue_instruction()},
                ],
            }
        ],
        "max_output_tokens": 1100,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=55.0)
    except Exception:
        return None
    text = _extract_openai_output_text(response)
    cleaned = _clean_text_inference(text, max_chars=10000)
    if not cleaned:
        return None
    return TextInference(text=cleaned, source="openai_vision", model=model)


def _diagnose_with_gemini(reference_path: Path) -> TextInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_DIAGNOSE_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path)
    instruction = _diagnose_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        cleaned = _clean_text_inference(text, max_chars=8000)
        if cleaned:
            return TextInference(text=cleaned, source="gemini_vision", model=model)

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                cleaned = _clean_text_inference(chunk, max_chars=8000)
                if cleaned:
                    return TextInference(text=cleaned, source="gemini_vision", model=model)

    return None


def _argue_with_gemini(path_a: Path, path_b: Path) -> TextInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_ARGUE_MODEL") or os.getenv("BROOD_GEMINI_DIAGNOSE_MODEL") or "gemini-3-pro-preview"
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    instruction = _argue_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(text="Image A:"),
            types.Part(inline_data=types.Blob(data=a_bytes, mime_type=a_mime)),
            types.Part(text="Image B:"),
            types.Part(inline_data=types.Blob(data=b_bytes, mime_type=b_mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    if isinstance(text, str) and text.strip():
        cleaned = _clean_text_inference(text, max_chars=10000)
        if cleaned:
            return TextInference(text=cleaned, source="gemini_vision", model=model)

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                cleaned = _clean_text_inference(chunk, max_chars=10000)
                if cleaned:
                    return TextInference(text=cleaned, source="gemini_vision", model=model)

    return None


def _extract_dna_with_openai(reference_path: Path) -> DnaExtractionInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = os.getenv("BROOD_DNA_VISION_MODEL") or os.getenv("OPENAI_DNA_MODEL") or "gpt-4o-mini"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=1024)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"
    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _dna_extract_instruction()},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        "max_output_tokens": 380,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=35.0)
    except Exception:
        return None
    text = _extract_openai_output_text(response)
    payload_obj = _extract_json_object(text)
    if not payload_obj:
        return None
    parsed = _parse_dna_payload(payload_obj)
    if not parsed:
        return None
    palette, colors, materials, summary = parsed
    return DnaExtractionInference(
        palette=palette,
        colors=colors,
        materials=materials,
        summary=summary,
        source="openai_vision",
        model=model,
    )


def _extract_soul_with_openai(reference_path: Path) -> SoulExtractionInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = os.getenv("BROOD_SOUL_VISION_MODEL") or os.getenv("OPENAI_SOUL_MODEL") or "gpt-4o-mini"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=1024)
    data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode('ascii')}"
    payload: dict[str, Any] = {
        "model": model,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": _soul_extract_instruction()},
                    {"type": "input_image", "image_url": data_url},
                ],
            }
        ],
        "max_output_tokens": 240,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=35.0)
    except Exception:
        return None
    text = _extract_openai_output_text(response)
    payload_obj = _extract_json_object(text)
    if not payload_obj:
        return None
    parsed = _parse_soul_payload(payload_obj)
    if not parsed:
        return None
    emotion, summary = parsed
    return SoulExtractionInference(
        emotion=emotion,
        summary=summary,
        source="openai_vision",
        model=model,
    )


def _extract_dna_with_gemini(reference_path: Path) -> DnaExtractionInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_DNA_MODEL") or os.getenv("BROOD_GEMINI_CAPTION_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=1024)
    instruction = _dna_extract_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    payload_obj = _extract_json_object(text) if isinstance(text, str) else None
    if payload_obj:
        parsed = _parse_dna_payload(payload_obj)
        if parsed:
            palette, colors, materials, summary = parsed
            return DnaExtractionInference(
                palette=palette,
                colors=colors,
                materials=materials,
                summary=summary,
                source="gemini_vision",
                model=model,
            )

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if not isinstance(chunk, str) or not chunk.strip():
                continue
            payload_obj = _extract_json_object(chunk)
            if not payload_obj:
                continue
            parsed = _parse_dna_payload(payload_obj)
            if not parsed:
                continue
            palette, colors, materials, summary = parsed
            return DnaExtractionInference(
                palette=palette,
                colors=colors,
                materials=materials,
                summary=summary,
                source="gemini_vision",
                model=model,
            )
    return None


def _extract_soul_with_gemini(reference_path: Path) -> SoulExtractionInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_SOUL_MODEL") or os.getenv("BROOD_GEMINI_CAPTION_MODEL") or "gemini-3-pro-preview"
    image_bytes, mime = _prepare_vision_image(reference_path, max_dim=1024)
    instruction = _soul_extract_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None

    text = getattr(response, "text", None)
    payload_obj = _extract_json_object(text) if isinstance(text, str) else None
    if payload_obj:
        parsed = _parse_soul_payload(payload_obj)
        if parsed:
            emotion, summary = parsed
            return SoulExtractionInference(
                emotion=emotion,
                summary=summary,
                source="gemini_vision",
                model=model,
            )

    candidates = getattr(response, "candidates", []) or []
    for candidate in candidates:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if not isinstance(chunk, str) or not chunk.strip():
                continue
            payload_obj = _extract_json_object(chunk)
            if not payload_obj:
                continue
            parsed = _parse_soul_payload(payload_obj)
            if not parsed:
                continue
            emotion, summary = parsed
            return SoulExtractionInference(
                emotion=emotion,
                summary=summary,
                source="gemini_vision",
                model=model,
            )
    return None
