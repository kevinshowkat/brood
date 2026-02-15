"""Three-image ("triplet") inference helpers.

These are used by the desktop app's 3-image Abilities:
- Extract the Rule
- Odd One Out

We keep this in a separate module (instead of growing caption.py further) so
feature branches are easier to merge.
"""

from __future__ import annotations

import base64
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .caption import (
    _extract_openai_output_text,
    _openai_api_base,
    _openai_api_key,
    _post_openai_json,
    _prepare_vision_image,
    extract_token_usage_pair,
)


@dataclass(frozen=True)
class TripletRuleInference:
    principle: str
    evidence: list[dict[str, str]]
    annotations: list[dict[str, Any]]
    source: str
    model: str | None = None
    confidence: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass(frozen=True)
class TripletOddOneOutInference:
    odd_image: str  # "A" | "B" | "C"
    odd_index: int  # 0..2
    pattern: str
    explanation: str
    source: str
    model: str | None = None
    confidence: float | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None


def infer_triplet_rule(path_a: Path, path_b: Path, path_c: Path) -> TripletRuleInference | None:
    """Extract the shared design rule across 3 images."""
    openai = _triplet_rule_with_openai(path_a, path_b, path_c)
    if openai is not None:
        return openai
    gemini = _triplet_rule_with_gemini(path_a, path_b, path_c)
    if gemini is not None:
        return gemini
    return None


def infer_triplet_odd_one_out(path_a: Path, path_b: Path, path_c: Path) -> TripletOddOneOutInference | None:
    """Pick which image breaks the shared pattern of the other two."""
    openai = _odd_one_out_with_openai(path_a, path_b, path_c)
    if openai is not None:
        return openai
    gemini = _odd_one_out_with_gemini(path_a, path_b, path_c)
    if gemini is not None:
        return gemini
    return None


def _extract_json_dict(text: str) -> dict[str, Any] | None:
    raw = str(text or "").strip()
    if not raw:
        return None
    # Fast path: already JSON.
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        pass

    # Code fence path: ```json ...```
    if "```" in raw:
        parts = raw.split("```")
        for chunk in parts:
            c = chunk.strip()
            if not c:
                continue
            if c.lower().startswith("json"):
                c = c[4:].strip()
            if "{" in c and "}" in c:
                try:
                    parsed = json.loads(c[c.find("{") : c.rfind("}") + 1])
                    if isinstance(parsed, dict):
                        return parsed
                except Exception:
                    continue

    # Fallback: first {...} block.
    if "{" in raw and "}" in raw:
        snippet = raw[raw.find("{") : raw.rfind("}") + 1]
        try:
            parsed = json.loads(snippet)
            if isinstance(parsed, dict):
                return parsed
        except Exception:
            return None
    return None


def _as_confidence(value: object) -> float | None:
    try:
        f = float(value)  # type: ignore[arg-type]
    except Exception:
        return None
    if not (0.0 <= f <= 1.0):
        return None
    return f


def _triplet_rule_instruction() -> str:
    return (
        "You are an elite creative director. You will be shown three images: Image A, Image B, Image C.\n"
        "Your job: identify the ONE consistent design rule the user is applying across all three.\n\n"
        "Return JSON ONLY with this schema:\n"
        "{\n"
        '  "principle": "<one sentence rule>",\n'
        '  "evidence": [\n'
        '    {"image": "A", "note": "<short concrete visual evidence>"},\n'
        '    {"image": "B", "note": "<short concrete visual evidence>"},\n'
        '    {"image": "C", "note": "<short concrete visual evidence>"}\n'
        "  ],\n"
        '  "annotations": [\n'
        '    {"image": "A", "x": 0.0, "y": 0.0, "label": "<what to look at>"},\n'
        '    {"image": "B", "x": 0.0, "y": 0.0, "label": "<what to look at>"},\n'
        '    {"image": "C", "x": 0.0, "y": 0.0, "label": "<what to look at>"}\n'
        "  ],\n"
        '  "confidence": 0.0\n'
        "}\n\n"
        "Rules:\n"
        "- x and y are fractions in [0,1] relative to the image (0,0 top-left).\n"
        "- Keep annotations to 0-6 total points; omit the field or use [] if unsure.\n"
        "- No markdown, no prose outside JSON, no trailing commas.\n"
    )


def _odd_one_out_instruction() -> str:
    return (
        "You are curating a mood board. You will be shown three images: Image A, Image B, Image C.\n"
        "Two images share a pattern. One breaks it.\n\n"
        "Return JSON ONLY with this schema:\n"
        "{\n"
        '  "odd_image": "A",\n'
        '  "pattern": "<one short paragraph describing what A/B share>",\n'
        '  "explanation": "<why the odd one breaks it, concrete visual reasons>",\n'
        '  "confidence": 0.0\n'
        "}\n\n"
        "Rules:\n"
        '- odd_image MUST be exactly "A", "B", or "C".\n'
        "- No markdown, no prose outside JSON, no trailing commas.\n"
    )


def _triplet_rule_with_openai(path_a: Path, path_b: Path, path_c: Path) -> TripletRuleInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = (
        os.getenv("BROOD_EXTRACT_RULE_MODEL")
        or os.getenv("OPENAI_EXTRACT_RULE_MODEL")
        or os.getenv("BROOD_DIAGNOSE_MODEL")
        or os.getenv("OPENAI_DIAGNOSE_MODEL")
        or "gpt-4o-mini"
    )
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    c_bytes, c_mime = _prepare_vision_image(path_c)
    a_url = f"data:{a_mime};base64,{base64.b64encode(a_bytes).decode('ascii')}"
    b_url = f"data:{b_mime};base64,{base64.b64encode(b_bytes).decode('ascii')}"
    c_url = f"data:{c_mime};base64,{base64.b64encode(c_bytes).decode('ascii')}"

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
                    {"type": "input_text", "text": "Image C:"},
                    {"type": "input_image", "image_url": c_url},
                    {"type": "input_text", "text": _triplet_rule_instruction()},
                ],
            }
        ],
        "max_output_tokens": 850,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=60.0)
    except Exception:
        return None
    input_tokens, output_tokens = extract_token_usage_pair(response)
    text = _extract_openai_output_text(response)
    data = _extract_json_dict(text)
    if not data:
        return None

    principle = str(data.get("principle") or "").strip()
    if not principle:
        return None
    evidence_raw = data.get("evidence")
    evidence: list[dict[str, str]] = []
    if isinstance(evidence_raw, list):
        for item in evidence_raw:
            if not isinstance(item, Mapping):
                continue
            image = str(item.get("image") or "").strip().upper()
            note = str(item.get("note") or "").strip()
            if image not in {"A", "B", "C"} or not note:
                continue
            evidence.append({"image": image, "note": note})

    annotations: list[dict[str, Any]] = []
    ann_raw = data.get("annotations")
    if isinstance(ann_raw, list):
        for item in ann_raw:
            if not isinstance(item, Mapping):
                continue
            image = str(item.get("image") or "").strip().upper()
            if image not in {"A", "B", "C"}:
                continue
            try:
                x = float(item.get("x"))  # type: ignore[arg-type]
                y = float(item.get("y"))  # type: ignore[arg-type]
            except Exception:
                continue
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                continue
            label = str(item.get("label") or "").strip()
            annotations.append({"image": image, "x": x, "y": y, "label": label})

    return TripletRuleInference(
        principle=principle,
        evidence=evidence,
        annotations=annotations,
        source="openai_vision",
        model=model,
        confidence=_as_confidence(data.get("confidence")),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _odd_one_out_with_openai(path_a: Path, path_b: Path, path_c: Path) -> TripletOddOneOutInference | None:
    api_key = _openai_api_key()
    if not api_key:
        return None
    model = (
        os.getenv("BROOD_ODD_ONE_OUT_MODEL")
        or os.getenv("OPENAI_ODD_ONE_OUT_MODEL")
        or os.getenv("BROOD_ARGUE_MODEL")
        or os.getenv("OPENAI_ARGUE_MODEL")
        or "gpt-4o-mini"
    )
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    c_bytes, c_mime = _prepare_vision_image(path_c)
    a_url = f"data:{a_mime};base64,{base64.b64encode(a_bytes).decode('ascii')}"
    b_url = f"data:{b_mime};base64,{base64.b64encode(b_bytes).decode('ascii')}"
    c_url = f"data:{c_mime};base64,{base64.b64encode(c_bytes).decode('ascii')}"

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
                    {"type": "input_text", "text": "Image C:"},
                    {"type": "input_image", "image_url": c_url},
                    {"type": "input_text", "text": _odd_one_out_instruction()},
                ],
            }
        ],
        "max_output_tokens": 850,
    }
    endpoint = f"{_openai_api_base()}/responses"
    try:
        _, response = _post_openai_json(endpoint, payload, api_key, timeout_s=60.0)
    except Exception:
        return None
    input_tokens, output_tokens = extract_token_usage_pair(response)
    text = _extract_openai_output_text(response)
    data = _extract_json_dict(text)
    if not data:
        return None

    odd_image = str(data.get("odd_image") or "").strip().upper()
    if odd_image not in {"A", "B", "C"}:
        return None
    odd_index = 0 if odd_image == "A" else 1 if odd_image == "B" else 2
    pattern = str(data.get("pattern") or "").strip()
    explanation = str(data.get("explanation") or "").strip()
    if not pattern and not explanation:
        return None
    return TripletOddOneOutInference(
        odd_image=odd_image,
        odd_index=odd_index,
        pattern=pattern,
        explanation=explanation,
        source="openai_vision",
        model=model,
        confidence=_as_confidence(data.get("confidence")),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _triplet_rule_with_gemini(path_a: Path, path_b: Path, path_c: Path) -> TripletRuleInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_EXTRACT_RULE_MODEL") or os.getenv("BROOD_GEMINI_DIAGNOSE_MODEL") or "gemini-3-pro-preview"
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    c_bytes, c_mime = _prepare_vision_image(path_c)
    instruction = _triplet_rule_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(text="Image A:"),
            types.Part(inline_data=types.Blob(data=a_bytes, mime_type=a_mime)),
            types.Part(text="Image B:"),
            types.Part(inline_data=types.Blob(data=b_bytes, mime_type=b_mime)),
            types.Part(text="Image C:"),
            types.Part(inline_data=types.Blob(data=c_bytes, mime_type=c_mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None
    input_tokens, output_tokens = extract_token_usage_pair(response)

    text = getattr(response, "text", None)
    if not (isinstance(text, str) and text.strip()):
        candidates = getattr(response, "candidates", []) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
            for part in parts:
                chunk = getattr(part, "text", None)
                if isinstance(chunk, str) and chunk.strip():
                    text = chunk
                    break
    if not (isinstance(text, str) and text.strip()):
        return None

    data = _extract_json_dict(text)
    if not data:
        return None

    principle = str(data.get("principle") or "").strip()
    if not principle:
        return None
    evidence_raw = data.get("evidence")
    evidence: list[dict[str, str]] = []
    if isinstance(evidence_raw, list):
        for item in evidence_raw:
            if not isinstance(item, Mapping):
                continue
            image = str(item.get("image") or "").strip().upper()
            note = str(item.get("note") or "").strip()
            if image not in {"A", "B", "C"} or not note:
                continue
            evidence.append({"image": image, "note": note})

    annotations: list[dict[str, Any]] = []
    ann_raw = data.get("annotations")
    if isinstance(ann_raw, list):
        for item in ann_raw:
            if not isinstance(item, Mapping):
                continue
            image = str(item.get("image") or "").strip().upper()
            if image not in {"A", "B", "C"}:
                continue
            try:
                x = float(item.get("x"))  # type: ignore[arg-type]
                y = float(item.get("y"))  # type: ignore[arg-type]
            except Exception:
                continue
            if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
                continue
            label = str(item.get("label") or "").strip()
            annotations.append({"image": image, "x": x, "y": y, "label": label})

    return TripletRuleInference(
        principle=principle,
        evidence=evidence,
        annotations=annotations,
        source="gemini_vision",
        model=model,
        confidence=_as_confidence(data.get("confidence")),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )


def _odd_one_out_with_gemini(path_a: Path, path_b: Path, path_c: Path) -> TripletOddOneOutInference | None:
    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        return None
    try:
        from google import genai  # type: ignore
        from google.genai import types  # type: ignore
    except Exception:
        return None

    model = os.getenv("BROOD_GEMINI_ODD_ONE_OUT_MODEL") or os.getenv("BROOD_GEMINI_ARGUE_MODEL") or os.getenv("BROOD_GEMINI_DIAGNOSE_MODEL") or "gemini-3-pro-preview"
    a_bytes, a_mime = _prepare_vision_image(path_a)
    b_bytes, b_mime = _prepare_vision_image(path_b)
    c_bytes, c_mime = _prepare_vision_image(path_c)
    instruction = _odd_one_out_instruction()

    try:
        client = genai.Client(api_key=api_key)
        chat = client.chats.create(model=model)
        parts = [
            types.Part(text="Image A:"),
            types.Part(inline_data=types.Blob(data=a_bytes, mime_type=a_mime)),
            types.Part(text="Image B:"),
            types.Part(inline_data=types.Blob(data=b_bytes, mime_type=b_mime)),
            types.Part(text="Image C:"),
            types.Part(inline_data=types.Blob(data=c_bytes, mime_type=c_mime)),
            types.Part(text=instruction),
        ]
        response = chat.send_message(parts)
    except Exception:
        return None
    input_tokens, output_tokens = extract_token_usage_pair(response)

    text = getattr(response, "text", None)
    if not (isinstance(text, str) and text.strip()):
        candidates = getattr(response, "candidates", []) or []
        for candidate in candidates:
            content = getattr(candidate, "content", None)
            parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
            for part in parts:
                chunk = getattr(part, "text", None)
                if isinstance(chunk, str) and chunk.strip():
                    text = chunk
                    break
    if not (isinstance(text, str) and text.strip()):
        return None

    data = _extract_json_dict(text)
    if not data:
        return None

    odd_image = str(data.get("odd_image") or "").strip().upper()
    if odd_image not in {"A", "B", "C"}:
        return None
    odd_index = 0 if odd_image == "A" else 1 if odd_image == "B" else 2
    pattern = str(data.get("pattern") or "").strip()
    explanation = str(data.get("explanation") or "").strip()
    if not pattern and not explanation:
        return None

    return TripletOddOneOutInference(
        odd_image=odd_image,
        odd_index=odd_index,
        pattern=pattern,
        explanation=explanation,
        source="gemini_vision",
        model=model,
        confidence=_as_confidence(data.get("confidence")),
        input_tokens=input_tokens,
        output_tokens=output_tokens,
    )
