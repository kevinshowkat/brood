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
        f"Write a short HUD label describing the attached image in 3-6 words (<= {max_chars} characters). "
        "Focus on the main subject and one key attribute (material, color, category, or action). "
        "No punctuation. No quotes. No branding. Do not copy text that appears in the image. "
        "Output ONLY the label."
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


def _clean_description(text: str, *, max_chars: int) -> str:
    cleaned = " ".join(str(text or "").split()).strip()
    if cleaned.lower().startswith(("description:", "label:", "caption:")) and ":" in cleaned:
        cleaned = cleaned.split(":", 1)[1].strip()
    if cleaned.startswith(("\"", "'")) and cleaned.endswith(("\"", "'")) and len(cleaned) >= 2:
        cleaned = cleaned[1:-1].strip()
    # Keep it HUD-short (and model-proof against punctuation-y answers).
    cleaned = cleaned.replace(".", " ").replace(",", " ").replace(":", " ").replace(";", " ")
    cleaned = " ".join(cleaned.split()).strip()
    if len(cleaned) > max_chars:
        clipped = cleaned[: max_chars + 1].strip()
        if " " in clipped:
            clipped = clipped.rsplit(" ", 1)[0].strip()
        cleaned = clipped[:max_chars].strip()
    return cleaned


def _openai_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")


def _openai_api_base() -> str:
    return (os.getenv("OPENAI_API_BASE") or "https://api.openai.com/v1").rstrip("/")


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
