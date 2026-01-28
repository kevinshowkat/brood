"""LLM analysis helper (OpenAI Responses API with fallback)."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


@dataclass
class AnalysisResult:
    recommendations: list[dict[str, Any]]
    analysis_excerpt: str


DEFAULT_ANALYZER_MODEL = "gpt-5.2"


def analyze_receipt(
    receipt: dict[str, Any],
    *,
    goals: list[str] | None = None,
    model: str | None = None,
) -> AnalysisResult:
    api_key = _get_api_key()
    model_name = model or os.getenv("BROOD_ANALYZER_MODEL") or DEFAULT_ANALYZER_MODEL
    if not api_key:
        return _stub_analysis(receipt, goals)
    prompt = _build_analysis_prompt(receipt, goals)
    try:
        response_text = _call_openai_analysis(prompt, model_name, api_key)
    except Exception:
        return _stub_analysis(receipt, goals)
    excerpt, recommendations = _parse_analysis_response(response_text)
    return AnalysisResult(recommendations=recommendations, analysis_excerpt=excerpt)


def _get_api_key() -> str | None:
    return os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")


def _call_openai_analysis(prompt: str, model: str, api_key: str) -> str:
    payload: dict[str, Any] = {
        "model": model,
        "input": prompt,
        "max_output_tokens": 500,
    }
    use_xhigh = model.startswith("gpt-5.2") and "codex" not in model
    if use_xhigh:
        payload["reasoning"] = {"effort": "xhigh", "summary": "auto"}
        payload["tools"] = [{"type": "web_search"}]
    endpoint = "https://api.openai.com/v1/responses"
    try:
        _, response = _post_json(endpoint, payload, api_key)
    except Exception:
        if use_xhigh:
            payload["reasoning"]["effort"] = "high"
            try:
                _, response = _post_json(endpoint, payload, api_key)
            except Exception:
                payload.pop("tools", None)
                _, response = _post_json(endpoint, payload, api_key)
        else:
            raise
    text = _extract_output_text(response)
    if not text:
        raise RuntimeError("Empty analysis response.")
    return text


def _post_json(url: str, payload: dict[str, Any], api_key: str) -> tuple[int, dict[str, Any]]:
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
        with urlopen(req, timeout=45) as response:
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


def _extract_output_text(response: dict[str, Any]) -> str:
    if isinstance(response.get("output_text"), str):
        return response["output_text"].strip()
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
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


def _parse_analysis_response(text: str) -> tuple[str, list[dict[str, Any]]]:
    payload = _extract_json_object(text)
    if isinstance(payload, dict):
        excerpt = payload.get("analysis_excerpt")
        recs = payload.get("recommendations")
        excerpt_text = str(excerpt).strip() if excerpt else ""
        if not excerpt_text:
            excerpt_text = text.strip()
        recommendations = _coerce_recommendations(recs)
        return _compact_excerpt(excerpt_text), recommendations
    return _compact_excerpt(text.strip()), []


def _extract_json_object(text: str) -> dict[str, Any] | None:
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if not match:
        return None
    try:
        payload = json.loads(match.group(0))
    except Exception:
        return None
    return payload if isinstance(payload, dict) else None


def _coerce_recommendations(recs: Any) -> list[dict[str, Any]]:
    if isinstance(recs, list):
        normalized: list[dict[str, Any]] = []
        for item in recs:
            if isinstance(item, dict):
                normalized.append(item)
            elif isinstance(item, str) and item.strip():
                normalized.append(
                    {
                        "setting_name": "note",
                        "setting_value": item.strip(),
                        "setting_target": "comment",
                        "rationale": "",
                    }
                )
        return normalized
    if isinstance(recs, str) and recs.strip():
        return [
            {
                "setting_name": "note",
                "setting_value": recs.strip(),
                "setting_target": "comment",
                "rationale": "",
            }
        ]
    return []


def _compact_excerpt(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text).strip()
    if len(cleaned) > 180:
        return cleaned[:179].rstrip() + "…"
    return cleaned


def _build_analysis_prompt(receipt: dict[str, Any], goals: list[str] | None) -> str:
    request = receipt.get("request") if isinstance(receipt, dict) else {}
    resolved = receipt.get("resolved") if isinstance(receipt, dict) else {}
    metadata = receipt.get("result_metadata") if isinstance(receipt, dict) else {}
    prompt = str(request.get("prompt", "")) if isinstance(request, dict) else ""
    provider = ""
    model = ""
    size = ""
    n = ""
    options: dict[str, Any] = {}
    if isinstance(request, dict):
        provider = str(request.get("provider", "") or "")
        model = str(request.get("model", "") or "")
        size = str(request.get("size", "") or "")
        n = str(request.get("n", "") or "")
        if isinstance(request.get("provider_options"), dict):
            options = dict(request.get("provider_options") or {})
    if isinstance(resolved, dict):
        provider = str(resolved.get("provider", provider) or provider)
        model = str(resolved.get("model", model) or model)
        size = str(resolved.get("size", size) or size)
        n = str(resolved.get("n", n) or n)
        if isinstance(resolved.get("provider_params"), dict):
            options = dict(resolved.get("provider_params") or options)
    cost = metadata.get("cost_per_1k_images_usd") if isinstance(metadata, dict) else None
    latency = metadata.get("latency_per_image_s") if isinstance(metadata, dict) else None
    goals_line = ", ".join(goals) if goals else "none"
    payload = {
        "provider": provider,
        "model": model,
        "size": size,
        "n": n,
        "options": options,
        "cost_per_1k_images_usd": cost,
        "latency_per_image_s": latency,
    }
    prompt_line = prompt.strip().replace("\n", " ")
    size_hint = ""
    if provider == "openai":
        size_hint = "Allowed sizes: 1024x1024, 1024x1536, 1536x1024, auto.\n"
    return (
        "You are optimizing image generation settings for the next iteration.\n"
        f"Goals: {goals_line}\n"
        f"Prompt: {prompt_line}\n"
        f"Receipt summary JSON: {json.dumps(payload, ensure_ascii=True)}\n"
        f"{size_hint}"
        "Return ONLY JSON with keys: analysis_excerpt (string) and recommendations (array).\n"
        "Each recommendation must be an object with keys: setting_name, setting_value, setting_target, rationale.\n"
        "Allowed setting_target values: request, provider_options.\n"
        "Allowed request settings: size, n, seed, output_format, background.\n"
        "If provider is openai, only recommend sizes from the allowed list.\n"
        "Recommendations should be concrete parameter changes that best satisfy the goals."
    )


def _stub_analysis(receipt: dict[str, Any], goals: list[str] | None) -> AnalysisResult:
    prompt = str(receipt.get("request", {}).get("prompt", ""))
    goals_line = ", ".join(goals) if goals else "none"
    excerpt = f"Receipt analyzed for goals ({goals_line}) and prompt: {prompt[:80]}"
    recommendation = {
        "setting_name": "size",
        "setting_value": "1024x1024",
        "setting_target": "request",
        "rationale": "Default size.",
    }
    if goals:
        lowered = " ".join(goals).lower()
        if "minimize cost" in lowered or "minimize time" in lowered:
            recommendation = {
                "setting_name": "size",
                "setting_value": "1024x1024",
                "setting_target": "request",
                "rationale": "Use the smallest supported size to reduce cost and latency.",
            }
        elif "maximize quality" in lowered:
            recommendation = {
                "setting_name": "size",
                "setting_value": "1536x1024",
                "setting_target": "request",
                "rationale": "Larger size can improve quality.",
            }
        elif "retrieval" in lowered:
            recommendation = {
                "setting_name": "size",
                "setting_value": "1024x1024",
                "setting_target": "request",
                "rationale": "Square framing improves readability.",
            }
    return AnalysisResult(recommendations=[recommendation], analysis_excerpt=excerpt)
