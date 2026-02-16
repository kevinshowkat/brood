"""Brood CLI entrypoints."""

from __future__ import annotations

import argparse
import copy
import json
import os
import random
import sys
import time
from pathlib import Path
from typing import Any

from .chat.intent_parser import parse_intent
from .chat.command_registry import CHAT_HELP_COMMANDS
from .chat.refine import extract_model_directive, detect_edit_model, is_edit_request, is_refinement, is_repeat_request
from .cli_progress import progress_once, ProgressTicker, elapsed_line
from .engine import BroodEngine
from .realtime.openai_realtime import CanvasContextRealtimeSession, IntentIconsRealtimeSession
from .recreate.caption import (
    infer_description,
    infer_diagnosis,
    infer_argument,
    infer_canvas_context,
    infer_dna_signature,
    infer_soul_signature,
)
from .recreate.triplet import infer_triplet_rule, infer_triplet_odd_one_out
from .runs.export import export_html
from .reasoning import (
    start_reasoning_summary,
    reasoning_summary,
    build_optimize_reasoning_prompt,
)
from .utils import (
    now_utc_iso,
    load_dotenv,
    format_cost_generation_cents,
    format_latency_seconds,
    ansi_highlight,
    has_flux_key,
    is_flux_model,
)

MOTHER_CREATIVE_DIRECTIVE = "stunningly awe-inspiring and joyous"
MOTHER_TRANSFORMATION_MODES = (
    "amplify",
    "transcend",
    "destabilize",
    "purify",
    "hybridize",
    "mythologize",
    "monumentalize",
    "fracture",
    "romanticize",
    "alienate",
)
MOTHER_DEFAULT_TRANSFORMATION_MODE = "hybridize"
MOTHER_GENERATE_SCHEMA_V2 = "brood.mother.generate.v2"
MOTHER_PROVIDER_OPTIONS_ALLOWLIST: dict[str, set[str]] = {
    "gemini": {"aspect_ratio", "image_size", "safety_settings"},
    "imagen": {"aspect_ratio", "image_size", "add_watermark", "person_generation"},
}


def _maybe_warn_missing_flux_key(model: str | None) -> None:
    if not is_flux_model(model):
        return
    if has_flux_key():
        return
    print("Flux requires BFL_API_KEY (or FLUX_API_KEY). Set it before generating.")


def _print_progress_safe(message: str) -> None:
    prefix = "\r\n" if getattr(sys.stdout, "isatty", lambda: False)() else ""
    print(f"{prefix}{message}")


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="brood", description="Brood creative IDE engine")
    sub = parser.add_subparsers(dest="command")

    chat = sub.add_parser("chat", help="Interactive chat loop")
    chat.add_argument("--out", required=True, help="Run output directory")
    chat.add_argument("--events", help="Path to events.jsonl")
    chat.add_argument("--text-model", dest="text_model", default="gpt-5.2")
    chat.add_argument("--image-model", dest="image_model")

    run = sub.add_parser("run", help="Single-run generation")
    run.add_argument("--prompt", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--events")
    run.add_argument("--text-model", dest="text_model", default="gpt-5.2")
    run.add_argument("--image-model", dest="image_model")

    recreate = sub.add_parser("recreate", help="Recreate from reference image")
    recreate.add_argument("--reference", required=True, help="Path to reference image")
    recreate.add_argument("--out", required=True)
    recreate.add_argument("--events")
    recreate.add_argument("--text-model", dest="text_model", default="gpt-5.2")
    recreate.add_argument("--image-model", dest="image_model")

    export = sub.add_parser("export", help="Export run to HTML")
    export.add_argument("--run", required=True, help="Run directory")
    export.add_argument("--out", required=True, help="Output HTML path")

    return parser


def _settings_from_state(state: dict[str, object]) -> dict[str, object]:
    return {
        "size": state.get("size", "1024x1024"),
        "n": state.get("n", 1),
        "seed": state.get("seed"),
        "output_format": state.get("output_format"),
        "provider_options": state.get("provider_options", {}),
        "quality_preset": state.get("quality_preset", "quality"),
    }


def _format_recommendation(rec: dict[str, object]) -> str:
    name = rec.get("setting_name")
    value = rec.get("setting_value")
    target = rec.get("setting_target") or "provider_options"
    if target == "comment":
        return str(value)
    if target in {"request", "top_level"}:
        return f"{name}={value}"
    if target in {"provider_options", "provider", "options"}:
        return f"provider_options.{name}={value}"
    return f"{name}={value}"


def _load_json_payload(path: Path) -> dict[str, Any] | None:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    return obj if isinstance(obj, dict) else None


def _ids_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    for raw in value:
        key = str(raw or "").strip()
        if key:
            out.append(key)
    return out


def _normalize_transformation_mode(value: Any) -> str:
    mode = str(value or "").strip().lower()
    if mode in MOTHER_TRANSFORMATION_MODES:
        return mode
    return MOTHER_DEFAULT_TRANSFORMATION_MODE


def _optional_transformation_mode(value: Any) -> str | None:
    mode = str(value or "").strip().lower()
    if mode in MOTHER_TRANSFORMATION_MODES:
        return mode
    return None


def _paths_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        return [str(item).strip() for item in value if str(item).strip()]
    raw = str(value).strip()
    return [raw] if raw else []


def _normalize_provider_name(value: Any) -> str | None:
    name = str(value or "").strip().lower()
    return name or None


def _mother_apply_provider_generation_params(
    provider_options: dict[str, Any],
    generation_params: dict[str, Any],
    *,
    target_provider: str | None,
) -> dict[str, Any]:
    provider = _normalize_provider_name(target_provider)
    if provider not in {"gemini", "imagen"}:
        return dict(provider_options)
    out = dict(provider_options)
    aspect_ratio = generation_params.get("aspect_ratio")
    if isinstance(aspect_ratio, str) and aspect_ratio.strip():
        out["aspect_ratio"] = aspect_ratio.strip()
    image_size = generation_params.get("image_size")
    if isinstance(image_size, str) and image_size.strip():
        out["image_size"] = image_size.strip()
    if provider == "gemini":
        safety_settings = generation_params.get("safety_settings")
        if isinstance(safety_settings, (list, tuple)):
            out["safety_settings"] = list(safety_settings)
    if provider == "imagen":
        if generation_params.get("add_watermark") is not None:
            out["add_watermark"] = bool(generation_params.get("add_watermark"))
        if generation_params.get("person_generation") is not None:
            out["person_generation"] = generation_params.get("person_generation")
    return out


def _mother_sanitize_provider_options(
    provider_options: dict[str, Any],
    *,
    target_provider: str | None,
) -> dict[str, Any]:
    provider = _normalize_provider_name(target_provider)
    if not provider:
        return dict(provider_options)
    allowlist = MOTHER_PROVIDER_OPTIONS_ALLOWLIST.get(provider)
    if not allowlist:
        return dict(provider_options)
    return {str(k): v for k, v in provider_options.items() if str(k) in allowlist}


def _mother_extract_gemini_context_packet(payload: dict[str, Any]) -> dict[str, Any] | None:
    packet = payload.get("gemini_context_packet")
    if not isinstance(packet, dict):
        return None
    # Keep provider-facing context immutable downstream and avoid accidental mutation.
    return copy.deepcopy(packet)


def _intent_realtime_model_name(*, mother: bool = False) -> str:
    env_keys = (
        ("BROOD_MOTHER_INTENT_REALTIME_MODEL", "BROOD_INTENT_REALTIME_MODEL", "OPENAI_INTENT_REALTIME_MODEL")
        if mother
        else ("BROOD_INTENT_REALTIME_MODEL", "OPENAI_INTENT_REALTIME_MODEL")
    )
    for key in env_keys:
        value = str(os.getenv(key) or "").strip()
        if value:
            return "gpt-realtime" if value == "realtime-gpt" else value
    return "gpt-realtime" if mother else "gpt-realtime-mini"


def _intent_summary_for_mode(mode: str, hints: list[str]) -> str:
    primary_hint = ""
    for hint in hints:
        text = str(hint or "").strip()
        if text:
            primary_hint = text
            break
    hint_clause = f" from {primary_hint}" if primary_hint else ""
    templates: dict[str, str] = {
        "amplify": f"Push the current composition into a cinematic crescendo{hint_clause}.",
        "transcend": f"Lift the scene into a more transcendent visual world{hint_clause}.",
        "destabilize": f"Shift the composition toward controlled visual instability without collage artifacts{hint_clause}.",
        "purify": f"Simplify geometry and light into a calm sculptural image{hint_clause}.",
        "hybridize": f"Fuse the current references into one coherent composition{hint_clause}.",
        "mythologize": f"Recast the scene as mythic visual storytelling{hint_clause}.",
        "monumentalize": f"Turn the scene into a monumental hero composition{hint_clause}.",
        "fracture": f"Introduce intentional fracture and expressive disruption while keeping scene coherence{hint_clause}.",
        "romanticize": f"Infuse the composition with intimate emotional warmth{hint_clause}.",
        "alienate": f"Reframe the scene with uncanny, otherworldly distance{hint_clause}.",
    }
    return templates.get(mode, templates[MOTHER_DEFAULT_TRANSFORMATION_MODE])


def _payload_image_hints(payload: dict[str, Any]) -> list[str]:
    images = payload.get("images")
    if not isinstance(images, list):
        return []
    hints: list[str] = []
    for image in images:
        if not isinstance(image, dict):
            continue
        hints.append(str(image.get("vision_desc") or ""))
        hints.append(str(image.get("file") or ""))
    return [hint.strip() for hint in hints if str(hint or "").strip()]


def _has_human_signal(hints: list[str]) -> bool:
    text = " ".join(hints).lower()
    return any(token in text for token in ("person", "people", "human", "face", "portrait", "selfie", "woman", "man", "child"))


def _intent_summary_from_hints(hints: list[str]) -> tuple[str, float]:
    text = " ".join(str(v or "") for v in hints).lower()
    if any(k in text for k in ("portrait", "face", "person", "selfie")):
        return f"{MOTHER_CREATIVE_DIRECTIVE.capitalize()} character synthesis from current composition", 0.82
    if any(k in text for k in ("product", "object", "device", "item")):
        return f"{MOTHER_CREATIVE_DIRECTIVE.capitalize()} object-world synthesis from current composition", 0.79
    if any(k in text for k in ("landscape", "city", "room", "scene", "environment")):
        return f"{MOTHER_CREATIVE_DIRECTIVE.capitalize()} environmental synthesis from current composition", 0.78
    return f"{MOTHER_CREATIVE_DIRECTIVE.capitalize()} synthesis from current canvas composition", 0.64


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _image_layout_stats(images: list[Any]) -> tuple[list[str], dict[str, dict[str, float]], bool]:
    rows: list[dict[str, float | int | str]] = []
    seen: set[str] = set()
    for idx, img in enumerate(images):
        if not isinstance(img, dict):
            continue
        image_id = str(img.get("id") or "").strip()
        if not image_id or image_id in seen:
            continue
        seen.add(image_id)

        rect = img.get("rect") if isinstance(img.get("rect"), dict) else None
        if rect is None and isinstance(img.get("rect_norm"), dict):
            rect = img.get("rect_norm")
        if isinstance(rect, dict):
            x = _safe_float(rect.get("x"), 0.0)
            y = _safe_float(rect.get("y"), 0.0)
            w = max(0.0, _safe_float(rect.get("w"), 0.0))
            h = max(0.0, _safe_float(rect.get("h"), 0.0))
        else:
            x = float(idx)
            y = 0.0
            w = 0.0
            h = 0.0
        area = max(0.0, w * h)
        rows.append(
            {
                "id": image_id,
                "idx": idx,
                "x": x,
                "y": y,
                "w": w,
                "h": h,
                "area": area,
                "cx": x + (w * 0.5),
                "cy": y + (h * 0.5),
            }
        )

    if not rows:
        return [], {}, False

    has_rects = any(float(r.get("area") or 0.0) > 0.0 for r in rows)
    if has_rects:
        min_x = min(float(r.get("x") or 0.0) for r in rows)
        min_y = min(float(r.get("y") or 0.0) for r in rows)
        max_x = max(float(r.get("x") or 0.0) + max(0.0, float(r.get("w") or 0.0)) for r in rows)
        max_y = max(float(r.get("y") or 0.0) + max(0.0, float(r.get("h") or 0.0)) for r in rows)
        scene_cx = (min_x + max_x) * 0.5
        scene_cy = (min_y + max_y) * 0.5
        scene_diag = max(((max_x - min_x) ** 2 + (max_y - min_y) ** 2) ** 0.5, 1.0)
        max_area = max(max(0.0, float(r.get("area") or 0.0)) for r in rows)
    else:
        scene_cx = 0.0
        scene_cy = 0.0
        scene_diag = max(float(len(rows) - 1), 1.0)
        max_area = 0.0

    layout_by_id: dict[str, dict[str, float]] = {}
    ranked: list[tuple[str, float, int]] = []
    for row in rows:
        image_id = str(row.get("id") or "")
        idx = int(row.get("idx") or 0)
        x = float(row.get("x") or 0.0)
        y = float(row.get("y") or 0.0)
        w = max(0.0, float(row.get("w") or 0.0))
        h = max(0.0, float(row.get("h") or 0.0))
        area = max(0.0, float(row.get("area") or 0.0))
        cx = float(row.get("cx") or 0.0)
        cy = float(row.get("cy") or 0.0)

        if has_rects and max_area > 0.0:
            area_norm = max(0.0, min(1.0, area / max_area))
            center_dist = ((cx - scene_cx) ** 2 + (cy - scene_cy) ** 2) ** 0.5
            center_dist_norm = max(0.0, min(1.0, center_dist / scene_diag))
            prominence = 0.7 * area_norm + 0.3 * (1.0 - center_dist_norm)
        else:
            area_norm = 0.0
            center_dist_norm = max(0.0, min(1.0, float(idx) / scene_diag))
            prominence = max(0.05, 1.0 - (0.05 * float(idx)))

        layout_by_id[image_id] = {
            "x": x,
            "y": y,
            "w": w,
            "h": h,
            "area": area,
            "area_norm": area_norm,
            "center_dist_norm": center_dist_norm,
            "prominence": prominence,
        }
        ranked.append((image_id, prominence, idx))

    ranked.sort(key=lambda rec: (-float(rec[1]), int(rec[2])))
    ranked_ids = [str(image_id) for image_id, _, _ in ranked if image_id]
    return ranked_ids, layout_by_id, has_rects


def _pair_overlap_ratio(layout_by_id: dict[str, dict[str, float]], image_a: str, image_b: str) -> float:
    a = layout_by_id.get(str(image_a or ""))
    b = layout_by_id.get(str(image_b or ""))
    if not a or not b:
        return 0.0
    ax, ay, aw, ah = float(a.get("x") or 0.0), float(a.get("y") or 0.0), float(a.get("w") or 0.0), float(a.get("h") or 0.0)
    bx, by, bw, bh = float(b.get("x") or 0.0), float(b.get("y") or 0.0), float(b.get("w") or 0.0), float(b.get("h") or 0.0)
    if aw <= 0.0 or ah <= 0.0 or bw <= 0.0 or bh <= 0.0:
        return 0.0

    ix0 = max(ax, bx)
    iy0 = max(ay, by)
    ix1 = min(ax + aw, bx + bw)
    iy1 = min(ay + ah, by + bh)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    denom = min(aw * ah, bw * bh)
    if denom <= 0.0:
        return 0.0
    return max(0.0, min(1.0, inter / denom))


def _preferred_transformation_mode_hint(payload: dict[str, Any]) -> tuple[str | None, float | None]:
    explicit = _optional_transformation_mode(payload.get("preferred_transformation_mode"))
    if explicit:
        return explicit, None

    ambient = payload.get("ambient_intent")
    if not isinstance(ambient, dict):
        return None, None

    ambient_explicit = _optional_transformation_mode(
        ambient.get("preferred_transformation_mode") or ambient.get("transformation_mode")
    )
    if ambient_explicit:
        return ambient_explicit, None

    best_mode: str | None = None
    best_conf = -1.0
    candidates = ambient.get("transformation_mode_candidates")
    if isinstance(candidates, list):
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            mode = _optional_transformation_mode(candidate.get("mode") or candidate.get("transformation_mode"))
            if not mode:
                continue
            conf = _safe_float(candidate.get("confidence"), -1.0)
            if conf > best_conf:
                best_conf = conf
                best_mode = mode
            if best_mode is None:
                best_mode = mode
    if best_mode:
        return best_mode, (best_conf if best_conf >= 0.0 else None)
    return None, None


def _infer_structured_intent(payload: dict[str, Any]) -> dict[str, Any]:
    action_version = int(payload.get("action_version") or 0)
    selected_ids = _ids_list(payload.get("selected_ids"))
    images = payload.get("images") if isinstance(payload.get("images"), list) else []
    image_ids = [str((img or {}).get("id") or "").strip() for img in images if isinstance(img, dict)]
    image_ids = [k for k in image_ids if k]
    image_id_set = set(image_ids)
    selected_ids = [image_id for image_id in selected_ids if image_id in image_id_set]
    active_id_raw = str(payload.get("active_id") or "").strip()
    active_id = active_id_raw if active_id_raw in image_id_set else ""

    ranked_ids, layout_by_id, has_spatial_layout = _image_layout_stats(images)

    target_ids = selected_ids[:]
    if not target_ids and active_id:
        target_ids = [active_id]
    if not target_ids and ranked_ids:
        target_ids = [ranked_ids[0]]
    if not target_ids and image_ids:
        target_ids = [image_ids[0]]
    target_set = set(target_ids)

    reference_ids = [img_id for img_id in ranked_ids if img_id not in target_set][:3]
    if not reference_ids:
        reference_ids = [img_id for img_id in image_ids if img_id not in target_set][:3]
    hints = []
    for img in images:
        if not isinstance(img, dict):
            continue
        hints.append(str(img.get("vision_desc") or ""))
        hints.append(str(img.get("file") or ""))
    context_summary = str(payload.get("canvas_context_summary") or "").strip()
    if context_summary:
        hints.append(context_summary)
    _, lane_conf = _intent_summary_from_hints(hints)
    preferred_mode, preferred_conf = _preferred_transformation_mode_hint(payload)
    transformation_mode = preferred_mode or MOTHER_DEFAULT_TRANSFORMATION_MODE

    def _first_ranked_not(excluded: set[str]) -> str:
        for image_id in ranked_ids:
            if image_id and image_id not in excluded:
                return image_id
        return ""

    subject_id = (target_ids[:1] or ranked_ids[:1] or image_ids[:1] or [""])[0]
    model_id = (reference_ids[:1] or [_first_ranked_not({subject_id})] or [""])[0]
    overlap_ratio = _pair_overlap_ratio(layout_by_id, subject_id, model_id)
    summary = _intent_summary_for_mode(transformation_mode, hints)

    if len(image_ids) >= 4:
        placement = "grid"
    elif target_ids and reference_ids:
        placement = "replace" if overlap_ratio >= 0.18 else "adjacent"
    elif target_ids:
        placement = "replace"
    else:
        placement = "adjacent"

    subject = [subject_id] if subject_id else []
    model = [model_id] if model_id else []
    if reference_ids[1:2]:
        mediator = reference_ids[1:2]
    else:
        mediator_id = _first_ranked_not(set(subject + model))
        mediator = [mediator_id] if mediator_id else model[:1]
    obj = target_ids[:1] or subject[:1]

    intent_id = f"intent-{action_version}"
    confidence_raw = lane_conf + (0.05 if selected_ids else 0.0)
    if preferred_mode:
        confidence_raw += 0.06
    if preferred_conf is not None:
        confidence_raw = max(confidence_raw, 0.52 + (0.38 * max(0.0, min(1.0, preferred_conf))))
    if has_spatial_layout:
        confidence_raw += 0.03
    if overlap_ratio >= 0.15:
        confidence_raw += 0.02
    confidence = round(max(0.2, min(0.99, confidence_raw)), 2)
    return {
        "intent_id": intent_id,
        "summary": summary,
        "creative_directive": MOTHER_CREATIVE_DIRECTIVE,
        "transformation_mode": transformation_mode,
        "target_ids": target_ids,
        "reference_ids": reference_ids,
        "placement_policy": placement,
        "confidence": confidence,
        "roles": {
            "subject": subject,
            "model": model,
            "mediator": mediator,
            "object": obj,
        },
        "alternatives": [
            {"placement_policy": "adjacent"},
            {"placement_policy": "grid"},
        ],
    }


def _compile_prompt(payload: dict[str, Any]) -> dict[str, Any]:
    action_version = int(payload.get("action_version") or 0)
    intent = payload.get("intent") if isinstance(payload.get("intent"), dict) else {}
    roles = intent.get("roles") if isinstance(intent.get("roles"), dict) else {}
    summary = str(
        intent.get("summary")
        or intent.get("label")
        or f"{MOTHER_CREATIVE_DIRECTIVE.capitalize()} synthesis from current canvas composition"
    )
    placement = str(intent.get("placement_policy") or "adjacent")
    creative_directive = str(
        payload.get("creative_directive") or intent.get("creative_directive") or MOTHER_CREATIVE_DIRECTIVE
    ).strip() or MOTHER_CREATIVE_DIRECTIVE
    transformation_mode = _normalize_transformation_mode(
        payload.get("transformation_mode") or intent.get("transformation_mode")
    )

    subject_ids = _ids_list(roles.get("subject"))[:2]
    model_ids = _ids_list(roles.get("model"))[:2]
    mediator_ids = _ids_list(roles.get("mediator"))[:2]
    object_ids = _ids_list(roles.get("object"))[:2]
    subject = ", ".join(subject_ids) or "primary subject"
    model = ", ".join(model_ids) or "reference model"
    mediator = ", ".join(mediator_ids) or "layout mediator"
    obj = ", ".join(object_ids) or "desired outcome"
    double_exposure_allowed = transformation_mode in {"destabilize", "fracture", "alienate"}
    target_ids = _ids_list(intent.get("target_ids") or payload.get("target_ids"))
    reference_ids = _ids_list(intent.get("reference_ids") or payload.get("reference_ids"))
    unique_context_ids = []
    for image_id in target_ids + reference_ids:
        if image_id not in unique_context_ids:
            unique_context_ids.append(image_id)
    multi_image = len(unique_context_ids) > 1
    input_hints = _payload_image_hints(payload)
    has_human_inputs = _has_human_signal(input_hints)

    constraints = [
        "No unintended ghosted human overlays.",
        (
            "Allow intentional double-exposure only if it clearly serves the chosen transformation mode."
            if double_exposure_allowed
            else "No accidental double-exposure artifacts."
        ),
        "No icon-overpaint artifacts or interface residue.",
        "Preserve source-object integrity when the subject/object role implies continuity.",
    ]
    if not has_human_inputs:
        constraints.append("No extra humans or faces unless clearly present in the input references.")

    multi_image_rules: list[str] = []
    if multi_image:
        multi_image_rules.append("Integrate all references into a single coherent scene (not a collage).")
        if subject_ids and model_ids:
            multi_image_rules.append(
                f"Preserve primary subject identity from {', '.join(subject_ids)} and key material/color cues from {', '.join(model_ids)}."
            )
        elif target_ids and reference_ids:
            multi_image_rules.append(
                f"Preserve identifiable structure from {target_ids[0]} while transferring visual language from {reference_ids[0]}."
            )
        multi_image_rules.append("Match perspective, scale, and lighting direction across fused elements.")
        multi_image_rules.append("Keep one coherent camera framing and focal hierarchy.")

    positive_lines = [
        f"Intent summary: {summary}.",
        "Role anchors:",
        f"- SUBJECT: {subject}",
        f"- MODEL: {model}",
        f"- MEDIATOR: {mediator}",
        f"- OBJECT: {obj}",
        f"Placement policy target: {placement}.",
    ]
    if multi_image_rules:
        positive_lines.append("Multi-image fusion rules:")
        positive_lines.extend(f"- {line}" for line in multi_image_rules)
    positive_lines.extend(
        [
            "Preserve coherence, emotional resonance, strong focal hierarchy, and production-grade lighting.",
            "Anti-overlay constraints:",
        ]
    )
    positive_lines.extend(f"- {constraint}" for constraint in constraints)
    positive_lines.append("No visible text, logos-as-text, captions, or watermarks.")
    positive_lines.extend(
        [
            "Create one production-ready concept image.",
            f"Creative directive: {creative_directive}.",
            f"Transformation mode: {transformation_mode}.",
        ]
    )
    positive = "\n".join(positive_lines)
    negative = (
        "No text overlays, no watermarks, no collage split-screen, no icon-overpaint artifacts, "
        "no duplicated heads/limbs, no low-detail mush, no ghosted human overlays, "
        + ("no extra humans/faces unless present in inputs." if not has_human_inputs else "no unintended extra faces.")
    )
    return {
        "action_version": action_version,
        "creative_directive": creative_directive,
        "transformation_mode": transformation_mode,
        "positive_prompt": positive,
        "negative_prompt": negative,
        "compile_constraints": constraints,
        "generation_params": {
            "guidance_scale": 7.0,
            "layout_hint": placement,
            "seed_strategy": "random",
            "transformation_mode": transformation_mode,
        },
    }


def _mother_generate_request(
    payload: dict[str, Any],
    state: dict[str, object],
    *,
    target_provider: str | None = None,
) -> tuple[str, dict[str, Any], list[str], dict[str, Any]]:
    prompt = str(payload.get("prompt") or payload.get("positive_prompt") or "").strip()
    negative = str(payload.get("negative_prompt") or "").strip()
    if not prompt:
        raise ValueError("Mother generate payload missing prompt.")
    if negative and "avoid:" not in prompt.lower():
        prompt = f"{prompt}\nAvoid: {negative}".strip()

    settings = _settings_from_state(state)
    settings["n"] = int(payload.get("n") or 1)

    generation_params = payload.get("generation_params") if isinstance(payload.get("generation_params"), dict) else {}
    provider_options = dict(settings.get("provider_options") or {})
    seed_strategy = str(generation_params.get("seed_strategy") or "").strip().lower()
    if seed_strategy == "random":
        # Prevent deterministic cache hits when rerolling Mother drafts.
        settings["seed"] = random.randint(1, 2_147_483_647)
    elif generation_params.get("seed") is not None:
        try:
            settings["seed"] = int(generation_params.get("seed"))
        except Exception:
            pass
    provider_options = _mother_apply_provider_generation_params(
        provider_options,
        generation_params,
        target_provider=target_provider,
    )
    provider_options = _mother_sanitize_provider_options(
        provider_options,
        target_provider=target_provider,
    )
    if provider_options:
        settings["provider_options"] = provider_options
    else:
        settings.pop("provider_options", None)

    init_image = str(payload.get("init_image") or "").strip()
    reference_images = _paths_list(payload.get("reference_images"))
    if init_image:
        settings["init_image"] = init_image
    if reference_images:
        settings["reference_images"] = reference_images

    source_images = _paths_list(payload.get("source_images"))
    if not source_images:
        source_images = [v for v in [init_image, *reference_images] if v]
    source_images = [str(Path(path)) for path in source_images if str(path).strip()]

    intent_meta = payload.get("intent") if isinstance(payload.get("intent"), dict) else {}
    schema = str(payload.get("schema") or "").strip()
    is_v2_payload = schema == MOTHER_GENERATE_SCHEMA_V2
    intent_id = payload.get("intent_id") if is_v2_payload else (payload.get("intent_id") or intent_meta.get("intent_id"))
    transformation_mode = (
        payload.get("transformation_mode")
        or intent_meta.get("transformation_mode")
        or generation_params.get("transformation_mode")
    )
    action_meta = {
        "action": "mother_generate",
        "intent_id": intent_id,
        "mother_action_version": int(payload.get("action_version") or 0),
        "transformation_mode": transformation_mode,
        "source_images": source_images,
    }
    gemini_context_packet = _mother_extract_gemini_context_packet(payload)
    if gemini_context_packet is not None:
        action_meta["gemini_context_packet"] = gemini_context_packet
    return prompt, settings, source_images, action_meta

def _handle_chat(args: argparse.Namespace) -> int:
    run_dir = Path(args.out)
    events_path = Path(args.events) if args.events else run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model=args.text_model, image_model=args.image_model)
    state: dict[str, object] = {
        "size": "1024x1024",
        "n": 1,
        "quality_preset": "quality",
    }
    last_prompt: str | None = None
    last_artifact_path: str | None = None
    canvas_context_rt: CanvasContextRealtimeSession | None = None
    intent_rt: IntentIconsRealtimeSession | None = None
    mother_intent_rt: IntentIconsRealtimeSession | None = None

    print("Brood chat started. Type /help for commands.")

    def _handle_help_command(_intent) -> bool:
        print(f"Commands: {' '.join(CHAT_HELP_COMMANDS)}")
        return True

    def _handle_set_profile_command(intent) -> bool:
        engine.profile = intent.command_args.get("profile") or "default"
        print(f"Profile set to {engine.profile}")
        return True

    def _handle_set_text_model_command(intent) -> bool:
        engine.text_model = intent.command_args.get("model") or engine.text_model
        print(f"Text model set to {engine.text_model}")
        return True

    def _handle_set_image_model_command(intent) -> bool:
        engine.image_model = intent.command_args.get("model") or engine.image_model
        print(f"Image model set to {engine.image_model}")
        _maybe_warn_missing_flux_key(engine.image_model)
        return True

    def _handle_set_active_image_command(intent) -> bool:
        nonlocal last_artifact_path
        path = intent.command_args.get("path")
        if not path:
            print("/use requires a path")
            return True
        last_artifact_path = str(path)
        print(f"Active image set to {last_artifact_path}")
        return True

    def _handle_set_quality_command(intent) -> bool:
        state["quality_preset"] = intent.settings_update.get("quality_preset")
        print(f"Quality preset: {state['quality_preset']}")
        return True

    command_handlers = {
        "help": _handle_help_command,
        "set_profile": _handle_set_profile_command,
        "set_text_model": _handle_set_text_model_command,
        "set_image_model": _handle_set_image_model_command,
        "set_active_image": _handle_set_active_image_command,
        "set_quality": _handle_set_quality_command,
    }

    while True:
        try:
            line = input("> ")
        except (EOFError, KeyboardInterrupt):
            break
        intent = parse_intent(line)
        if intent.action == "noop":
            continue
        handler = command_handlers.get(intent.action)
        if handler:
            handler(intent)
            continue
        if intent.action == "describe":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                print("/describe requires a path (or set an active image with /use)")
                continue
            path = Path(str(raw_path))
            if not path.exists():
                print(f"Describe failed: file not found ({path})")
                continue
            max_chars = 32
            inference = None
            try:
                inference = infer_description(path, max_chars=max_chars)
            except Exception:
                inference = None
            if inference is None or not inference.description:
                print("Describe unavailable (missing keys or vision client).")
                continue
            engine.events.emit(
                "image_description",
                image_path=str(path),
                description=inference.description,
                source=inference.source,
                model=inference.model,
                max_chars=max_chars,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            meta = []
            if inference.source:
                meta.append(str(inference.source))
            if inference.model:
                meta.append(str(inference.model))
            suffix = f" ({', '.join(meta)})" if meta else ""
            print(f"Description{suffix}: {inference.description}")
            continue
        if intent.action == "canvas_context":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                print("/canvas_context requires a path (or set an active image with /use)")
                continue
            path = Path(str(raw_path))
            if not path.exists():
                print(f"Canvas context failed: file not found ({path})")
                continue
            inference = None
            try:
                inference = infer_canvas_context(path)
            except Exception:
                inference = None
            if inference is None or not inference.text:
                msg = "Canvas context unavailable (missing keys or vision client)."
                engine.events.emit("canvas_context_failed", image_path=str(path), error=msg)
                print(msg)
                continue
            engine.events.emit(
                "canvas_context",
                image_path=str(path),
                text=inference.text,
                source=inference.source,
                model=inference.model,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            print(inference.text)
            continue
        if intent.action == "intent_infer":
            raw_path = intent.command_args.get("path")
            if not raw_path:
                msg = "/intent_infer requires a JSON payload path"
                engine.events.emit("mother_intent_infer_failed", error=msg, payload_path=None)
                print(msg)
                continue
            payload_path = Path(str(raw_path))
            if not payload_path.exists():
                msg = f"Intent infer failed: file not found ({payload_path})"
                engine.events.emit("mother_intent_infer_failed", error=msg, payload_path=str(payload_path))
                print(msg)
                continue
            payload = _load_json_payload(payload_path)
            if payload is None:
                msg = f"Intent infer failed: invalid JSON ({payload_path})"
                engine.events.emit("mother_intent_infer_failed", error=msg, payload_path=str(payload_path))
                print(msg)
                continue
            intent_payload = _infer_structured_intent(payload)
            engine.events.emit(
                "mother_intent_inferred",
                payload_path=str(payload_path),
                action_version=int(payload.get("action_version") or 0),
                intent=intent_payload,
                source="brood_intent_infer",
                model="heuristic-v1",
            )
            print(json.dumps(intent_payload, ensure_ascii=False))
            continue
        if intent.action == "prompt_compile":
            raw_path = intent.command_args.get("path")
            if not raw_path:
                msg = "/prompt_compile requires a JSON payload path"
                engine.events.emit("mother_prompt_compile_failed", error=msg, payload_path=None)
                print(msg)
                continue
            payload_path = Path(str(raw_path))
            if not payload_path.exists():
                msg = f"Prompt compile failed: file not found ({payload_path})"
                engine.events.emit("mother_prompt_compile_failed", error=msg, payload_path=str(payload_path))
                print(msg)
                continue
            payload = _load_json_payload(payload_path)
            if payload is None:
                msg = f"Prompt compile failed: invalid JSON ({payload_path})"
                engine.events.emit("mother_prompt_compile_failed", error=msg, payload_path=str(payload_path))
                print(msg)
                continue
            compiled = _compile_prompt(payload)
            engine.events.emit(
                "mother_prompt_compiled",
                payload_path=str(payload_path),
                action_version=int(payload.get("action_version") or 0),
                compiled=compiled,
                source="brood_prompt_compile",
                model="heuristic-v1",
            )
            print(compiled.get("positive_prompt", ""))
            continue
        if intent.action == "mother_generate":
            raw_path = intent.command_args.get("path")
            if not raw_path:
                msg = "/mother_generate requires a JSON payload path"
                engine.events.emit(
                    "generation_failed",
                    version_id=None,
                    provider="mother",
                    model=engine.image_model,
                    error=msg,
                )
                print(msg)
                continue
            payload_path = Path(str(raw_path))
            if not payload_path.exists():
                msg = f"Mother generate failed: file not found ({payload_path})"
                engine.events.emit(
                    "generation_failed",
                    version_id=None,
                    provider="mother",
                    model=engine.image_model,
                    error=msg,
                )
                print(msg)
                continue
            payload = _load_json_payload(payload_path)
            if payload is None:
                msg = f"Mother generate failed: invalid JSON ({payload_path})"
                engine.events.emit(
                    "generation_failed",
                    version_id=None,
                    provider="mother",
                    model=engine.image_model,
                    error=msg,
                )
                print(msg)
                continue

            target_provider = None
            try:
                selection = engine.model_selector.select(engine.image_model, "image")
                target_provider = selection.model.provider if selection and selection.model else None
            except Exception:
                target_provider = None
            try:
                prompt, settings, source_images, action_meta = _mother_generate_request(
                    payload,
                    state,
                    target_provider=target_provider,
                )
            except ValueError as exc:
                msg = f"Mother generate failed: {exc}"
                engine.events.emit(
                    "generation_failed",
                    version_id=None,
                    provider="mother",
                    model=engine.image_model,
                    error=msg,
                )
                print(msg)
                continue

            progress_once("Planning Mother draft")
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Mother plan: {plan['images']} image via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']} refs={len(source_images)}"
            )
            ticker = ProgressTicker("Generating Mother draft")
            ticker.start_ticking()
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(prompt, settings, action_meta)
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")

            if error:
                print(f"Mother generate failed: {error}")
            else:
                print("Mother generate complete.")
            continue
        if intent.action == "canvas_context_rt_start":
            if canvas_context_rt is None:
                canvas_context_rt = CanvasContextRealtimeSession(engine.events)
            ok, err = canvas_context_rt.start()
            if not ok:
                model = (
                    os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_MODEL")
                    or os.getenv("OPENAI_CANVAS_CONTEXT_REALTIME_MODEL")
                    or "gpt-realtime-mini"
                )
                engine.events.emit(
                    "canvas_context_failed",
                    image_path=None,
                    error=err or "Realtime start failed.",
                    source="openai_realtime",
                    model=model,
                    fatal=True,
                )
                print(f"Canvas context realtime start failed: {err}")
                # Drop state so future updates fail loudly (avoids silent thrash).
                canvas_context_rt = None
                continue
            print("Canvas context realtime started.")
            continue
        if intent.action == "canvas_context_rt_stop":
            if canvas_context_rt is not None:
                canvas_context_rt.stop()
                canvas_context_rt = None
            print("Canvas context realtime stopped.")
            continue
        if intent.action == "canvas_context_rt":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                msg = "/canvas_context_rt requires a path (or set an active image with /use)"
                engine.events.emit(
                    "canvas_context_failed",
                    image_path=None,
                    error=msg,
                    source="openai_realtime",
                    model=os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_MODEL") or "gpt-realtime-mini",
                    fatal=True,
                )
                print(msg)
                continue
            path = Path(str(raw_path))
            if not path.exists():
                msg = f"Canvas context realtime failed: file not found ({path})"
                engine.events.emit(
                    "canvas_context_failed",
                    image_path=str(path),
                    error=msg,
                    source="openai_realtime",
                    model=os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_MODEL") or "gpt-realtime-mini",
                    fatal=True,
                )
                print(msg)
                continue
            if canvas_context_rt is None:
                canvas_context_rt = CanvasContextRealtimeSession(engine.events)
            ok, err = canvas_context_rt.submit_snapshot(path)
            if not ok:
                engine.events.emit(
                    "canvas_context_failed",
                    image_path=str(path),
                    error=err or "Realtime submit failed.",
                    source="openai_realtime",
                    model=os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_MODEL") or "gpt-realtime-mini",
                    fatal=True,
                )
                print(f"Canvas context realtime submit failed: {err}")
                # Ensure we stop to avoid any background thrash.
                canvas_context_rt.stop()
                canvas_context_rt = None
                continue
            # No blocking here. Results stream via `canvas_context` events.
            continue
        if intent.action == "intent_rt_start":
            if intent_rt is None:
                intent_rt = IntentIconsRealtimeSession(engine.events)
            ok, err = intent_rt.start()
            if not ok:
                model = _intent_realtime_model_name()
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=None,
                    error=err or "Realtime start failed.",
                    source="openai_realtime",
                    model=model,
                    fatal=True,
                )
                print(f"Intent realtime start failed: {err}")
                intent_rt = None
                continue
            print("Intent realtime started.")
            continue
        if intent.action == "intent_rt_stop":
            if intent_rt is not None:
                intent_rt.stop()
                intent_rt = None
            print("Intent realtime stopped.")
            continue
        if intent.action == "intent_rt":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                msg = "/intent_rt requires a path (or set an active image with /use)"
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=None,
                    error=msg,
                    source="openai_realtime",
                    model=_intent_realtime_model_name(),
                    fatal=True,
                )
                print(msg)
                continue
            path = Path(str(raw_path))
            if not path.exists():
                msg = f"Intent realtime failed: file not found ({path})"
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=str(path),
                    error=msg,
                    source="openai_realtime",
                    model=_intent_realtime_model_name(),
                    fatal=True,
                )
                print(msg)
                continue
            if intent_rt is None:
                intent_rt = IntentIconsRealtimeSession(engine.events)
            ok, err = intent_rt.submit_snapshot(path)
            if not ok:
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=str(path),
                    error=err or "Realtime submit failed.",
                    source="openai_realtime",
                    model=_intent_realtime_model_name(),
                    fatal=True,
                )
                print(f"Intent realtime submit failed: {err}")
                intent_rt.stop()
                intent_rt = None
                continue
            # No blocking here. Results stream via `intent_icons` events.
            continue
        if intent.action == "intent_rt_mother_start":
            if mother_intent_rt is None:
                mother_intent_rt = IntentIconsRealtimeSession(
                    engine.events,
                    model_env_keys=(
                        "BROOD_MOTHER_INTENT_REALTIME_MODEL",
                        "BROOD_INTENT_REALTIME_MODEL",
                        "OPENAI_INTENT_REALTIME_MODEL",
                    ),
                    default_model="gpt-realtime",
                    instruction_scope="mother",
                )
            ok, err = mother_intent_rt.start()
            if not ok:
                model = _intent_realtime_model_name(mother=True)
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=None,
                    error=err or "Realtime start failed.",
                    source="openai_realtime",
                    model=model,
                    fatal=True,
                )
                print(f"Mother intent realtime start failed: {err}")
                mother_intent_rt = None
                continue
            print("Mother intent realtime started.")
            continue
        if intent.action == "intent_rt_mother_stop":
            if mother_intent_rt is not None:
                mother_intent_rt.stop()
                mother_intent_rt = None
            print("Mother intent realtime stopped.")
            continue
        if intent.action == "intent_rt_mother":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                msg = "/intent_rt_mother requires a path (or set an active image with /use)"
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=None,
                    error=msg,
                    source="openai_realtime",
                    model=_intent_realtime_model_name(mother=True),
                    fatal=True,
                )
                print(msg)
                continue
            path = Path(str(raw_path))
            if not path.exists():
                msg = f"Mother intent realtime failed: file not found ({path})"
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=str(path),
                    error=msg,
                    source="openai_realtime",
                    model=_intent_realtime_model_name(mother=True),
                    fatal=True,
                )
                print(msg)
                continue
            if mother_intent_rt is None:
                mother_intent_rt = IntentIconsRealtimeSession(
                    engine.events,
                    model_env_keys=(
                        "BROOD_MOTHER_INTENT_REALTIME_MODEL",
                        "BROOD_INTENT_REALTIME_MODEL",
                        "OPENAI_INTENT_REALTIME_MODEL",
                    ),
                    default_model="gpt-realtime",
                    instruction_scope="mother",
                )
            ok, err = mother_intent_rt.submit_snapshot(path)
            if not ok:
                engine.events.emit(
                    "intent_icons_failed",
                    image_path=str(path),
                    error=err or "Realtime submit failed.",
                    source="openai_realtime",
                    model=_intent_realtime_model_name(mother=True),
                    fatal=True,
                )
                print(f"Mother intent realtime submit failed: {err}")
                mother_intent_rt.stop()
                mother_intent_rt = None
                continue
            # No blocking here. Results stream via `intent_icons` events.
            continue
        if intent.action == "diagnose":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                print("/diagnose requires a path (or set an active image with /use)")
                continue
            path = Path(str(raw_path))
            if not path.exists():
                print(f"Diagnose failed: file not found ({path})")
                continue
            inference = None
            try:
                inference = infer_diagnosis(path)
            except Exception:
                inference = None
            if inference is None or not inference.text:
                msg = "Diagnose unavailable (missing keys or vision client)."
                engine.events.emit("image_diagnosis_failed", image_path=str(path), error=msg)
                print(msg)
                continue
            engine.events.emit(
                "image_diagnosis",
                image_path=str(path),
                text=inference.text,
                source=inference.source,
                model=inference.model,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            print(inference.text)
            continue
        if intent.action == "recast":
            raw_path = intent.command_args.get("path") or last_artifact_path
            if not raw_path:
                print("/recast requires a path (or set an active image with /use)")
                continue
            path = Path(str(raw_path))
            if not path.exists():
                print(f"Recast failed: file not found ({path})")
                continue
            prompt = (
                "Recast the provided image into a completely different medium and context. "
                "This is a lateral creative leap (not a minor style tweak). "
                "Preserve the core idea/subject identity, but change the form factor, materials, and world. "
                "Output ONE coherent image. No split-screen or collage. No text overlays."
            )
            progress_once("Planning recast")
            settings = _settings_from_state(state)
            settings["init_image"] = str(path)
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Recasting image")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(prompt, settings, {"action": "recast", "source_images": [str(path)]})
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = (
                engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            )
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")

            if error:
                print(f"Recast failed: {error}")
            else:
                print("Recast complete.")
            continue
        if intent.action == "blend":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 2:
                print("Usage: /blend <image_a> <image_b>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            if not path_a.exists():
                print(f"Blend failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Blend failed: file not found ({path_b})")
                continue

            prompt = (
                "Combine the two provided photos into a single coherent blended photo. "
                "Do not make a split-screen or side-by-side collage; integrate them into one scene. "
                "Keep it photorealistic and preserve key details from both images."
            )
            progress_once("Planning blend")
            settings = _settings_from_state(state)
            settings["init_image"] = str(path_a)
            settings["reference_images"] = [str(path_b)]
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Blending images")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(
                    prompt,
                    settings,
                    {"action": "blend", "source_images": [str(path_a), str(path_b)]},
                )
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = (
                engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            )
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(
                f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}"
            )

            if error:
                print(f"Blend failed: {error}")
            else:
                print("Blend complete.")
            continue
        if intent.action == "argue":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 2:
                print("Usage: /argue <image_a> <image_b>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            if not path_a.exists():
                print(f"Argue failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Argue failed: file not found ({path_b})")
                continue
            inference = None
            try:
                inference = infer_argument(path_a, path_b)
            except Exception:
                inference = None
            if inference is None or not inference.text:
                msg = "Argue unavailable (missing keys or vision client)."
                engine.events.emit(
                    "image_argument_failed",
                    image_paths=[str(path_a), str(path_b)],
                    error=msg,
                )
                print(msg)
                continue
            engine.events.emit(
                "image_argument",
                image_paths=[str(path_a), str(path_b)],
                text=inference.text,
                source=inference.source,
                model=inference.model,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            print(inference.text)
            continue
        if intent.action == "extract_dna":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 1:
                print("Usage: /extract_dna <image_a> [image_b ...]")
                continue
            resolved_paths: list[Path] = []
            for raw in paths:
                path = Path(str(raw))
                if not path.exists():
                    msg = f"Extract DNA failed: file not found ({path})"
                    engine.events.emit(
                        "image_dna_extracted_failed",
                        image_path=str(path),
                        error=msg,
                    )
                    print(msg)
                    continue
                resolved_paths.append(path)
            if not resolved_paths:
                continue

            for path in resolved_paths:
                inference = None
                try:
                    inference = infer_dna_signature(path)
                except Exception:
                    inference = None
                if inference is None:
                    msg = "Extract DNA unavailable (missing keys or vision client)."
                    engine.events.emit(
                        "image_dna_extracted_failed",
                        image_path=str(path),
                        error=msg,
                    )
                    print(msg)
                    continue
                engine.events.emit(
                    "image_dna_extracted",
                    image_path=str(path),
                    palette=inference.palette,
                    colors=inference.colors,
                    materials=inference.materials,
                    summary=inference.summary,
                    source=inference.source,
                    model=inference.model,
                    input_tokens=inference.input_tokens,
                    output_tokens=inference.output_tokens,
                )
                summary = inference.summary.strip() if inference.summary else ""
                print(f"DNA extracted ({path.name})")
                if summary:
                    print(f"- {summary}")
            continue
        if intent.action == "soul_leech":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 1:
                print("Usage: /soul_leech <image_a> [image_b ...]")
                continue
            resolved_paths: list[Path] = []
            for raw in paths:
                path = Path(str(raw))
                if not path.exists():
                    msg = f"Soul Leech failed: file not found ({path})"
                    engine.events.emit(
                        "image_soul_extracted_failed",
                        image_path=str(path),
                        error=msg,
                    )
                    print(msg)
                    continue
                resolved_paths.append(path)
            if not resolved_paths:
                continue

            for path in resolved_paths:
                inference = None
                try:
                    inference = infer_soul_signature(path)
                except Exception:
                    inference = None
                if inference is None:
                    msg = "Soul Leech unavailable (missing keys or vision client)."
                    engine.events.emit(
                        "image_soul_extracted_failed",
                        image_path=str(path),
                        error=msg,
                    )
                    print(msg)
                    continue
                engine.events.emit(
                    "image_soul_extracted",
                    image_path=str(path),
                    emotion=inference.emotion,
                    summary=inference.summary,
                    source=inference.source,
                    model=inference.model,
                    input_tokens=inference.input_tokens,
                    output_tokens=inference.output_tokens,
                )
                summary = inference.summary.strip() if inference.summary else ""
                print(f"Soul extracted ({path.name})")
                if summary:
                    print(f"- {summary}")
            continue
        if intent.action == "extract_rule":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 3:
                print("Usage: /extract_rule <image_a> <image_b> <image_c>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            path_c = Path(str(paths[2]))
            if not path_a.exists():
                print(f"Extract the Rule failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Extract the Rule failed: file not found ({path_b})")
                continue
            if not path_c.exists():
                print(f"Extract the Rule failed: file not found ({path_c})")
                continue
            inference = None
            try:
                inference = infer_triplet_rule(path_a, path_b, path_c)
            except Exception:
                inference = None
            if inference is None or not inference.principle:
                msg = "Extract the Rule unavailable (missing keys or vision client)."
                engine.events.emit(
                    "triplet_rule_failed",
                    image_paths=[str(path_a), str(path_b), str(path_c)],
                    error=msg,
                )
                print(msg)
                continue
            engine.events.emit(
                "triplet_rule",
                image_paths=[str(path_a), str(path_b), str(path_c)],
                principle=inference.principle,
                evidence=inference.evidence,
                annotations=inference.annotations,
                source=inference.source,
                model=inference.model,
                confidence=inference.confidence,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            print(f"RULE:\n{inference.principle}")
            if inference.evidence:
                print("\nEVIDENCE:")
                for item in inference.evidence:
                    print(f"- {item.get('image', '')}: {item.get('note', '')}")
            continue
        if intent.action == "odd_one_out":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 3:
                print("Usage: /odd_one_out <image_a> <image_b> <image_c>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            path_c = Path(str(paths[2]))
            if not path_a.exists():
                print(f"Odd One Out failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Odd One Out failed: file not found ({path_b})")
                continue
            if not path_c.exists():
                print(f"Odd One Out failed: file not found ({path_c})")
                continue
            inference = None
            try:
                inference = infer_triplet_odd_one_out(path_a, path_b, path_c)
            except Exception:
                inference = None
            if inference is None or not inference.odd_image:
                msg = "Odd One Out unavailable (missing keys or vision client)."
                engine.events.emit(
                    "triplet_odd_one_out_failed",
                    image_paths=[str(path_a), str(path_b), str(path_c)],
                    error=msg,
                )
                print(msg)
                continue
            engine.events.emit(
                "triplet_odd_one_out",
                image_paths=[str(path_a), str(path_b), str(path_c)],
                odd_image=inference.odd_image,
                odd_index=inference.odd_index,
                pattern=inference.pattern,
                explanation=inference.explanation,
                source=inference.source,
                model=inference.model,
                confidence=inference.confidence,
                input_tokens=inference.input_tokens,
                output_tokens=inference.output_tokens,
            )
            print(f"ODD ONE OUT: {inference.odd_image}")
            if inference.pattern:
                print(f"\nPATTERN:\n{inference.pattern}")
            if inference.explanation:
                print(f"\nWHY:\n{inference.explanation}")
            continue
        if intent.action == "triforce":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 3:
                print("Usage: /triforce <image_a> <image_b> <image_c>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            path_c = Path(str(paths[2]))
            if not path_a.exists():
                print(f"Triforce failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Triforce failed: file not found ({path_b})")
                continue
            if not path_c.exists():
                print(f"Triforce failed: file not found ({path_c})")
                continue

            prompt = (
                "Take the three provided images as vertices of a creative space and generate the centroid: "
                "ONE new image that sits equidistant from all three references. "
                "This is mood board distillation, not a collage. "
                "Find the shared design language (composition, lighting logic, color story, material palette, and mood), "
                "then output one coherent image that could plausibly sit between all three."
            )
            progress_once("Planning triforce")
            settings = _settings_from_state(state)
            settings["n"] = 1
            settings["init_image"] = str(path_a)
            settings["reference_images"] = [str(path_b), str(path_c)]
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Triforcing images")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(
                    prompt,
                    settings,
                    {"action": "triforce", "source_images": [str(path_a), str(path_b), str(path_c)]},
                )
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = (
                engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            )
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(
                f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}"
            )

            if error:
                print(f"Triforce failed: {error}")
            else:
                print("Triforce complete.")
            continue
        if intent.action == "bridge":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 2:
                print("Usage: /bridge <image_a> <image_b>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            if not path_a.exists():
                print(f"Bridge failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Bridge failed: file not found ({path_b})")
                continue

            prompt = (
                "Bridge the two provided images by generating a single new image that lives in the aesthetic midpoint. "
                "This is NOT a collage and NOT a literal mash-up. "
                "Find the shared design language: composition, lighting logic, color story, material palette, and mood. "
                "Output one coherent image that could plausibly sit between both references."
            )
            progress_once("Planning bridge")
            settings = _settings_from_state(state)
            settings["init_image"] = str(path_a)
            settings["reference_images"] = [str(path_b)]
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Bridging images")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(
                    prompt,
                    settings,
                    {"action": "bridge", "source_images": [str(path_a), str(path_b)]},
                )
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = (
                engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            )
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")

            if error:
                print(f"Bridge failed: {error}")
            else:
                print("Bridge complete.")
            continue
        if intent.action == "swap_dna":
            paths = intent.command_args.get("paths") or []
            if not isinstance(paths, list) or len(paths) < 2:
                print("Usage: /swap_dna <image_a> <image_b>")
                continue
            path_a = Path(str(paths[0]))
            path_b = Path(str(paths[1]))
            if not path_a.exists():
                print(f"Swap DNA failed: file not found ({path_a})")
                continue
            if not path_b.exists():
                print(f"Swap DNA failed: file not found ({path_b})")
                continue

            prompt = (
                "Swap DNA between the two provided photos. "
                "Image A provides the STRUCTURE: crop/framing, composition, hierarchy, layout, and spatial logic. "
                "Image B provides the SURFACE: color palette, textures/materials, lighting, mood, and finish. "
                "This is decision transfer, not a split-screen or collage. "
                "Output a single coherent image that preserves A's structural decisions while applying B's surface qualities."
            )
            progress_once("Planning Swap DNA")
            settings = _settings_from_state(state)
            settings["init_image"] = str(path_a)
            settings["reference_images"] = [str(path_b)]
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Swapping DNA")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(
                    prompt,
                    settings,
                    {"action": "swap_dna", "source_images": [str(path_a), str(path_b)]},
                )
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)

            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")

            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = (
                engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            )
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(
                f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}"
            )

            if error:
                print(f"Swap DNA failed: {error}")
            else:
                print("Swap DNA complete.")
            continue
        if intent.action == "optimize":
            goals = intent.command_args.get("goals") or []
            mode = (intent.command_args.get("mode") or "auto").lower()
            if mode not in {"auto", "review"}:
                mode = "auto"
            if not goals:
                print("No goals provided. Use /optimize [review] quality,cost,time,retrieval")
                continue
            print(f"Optimizing for: {', '.join(goals)} ({mode})")
            max_rounds = 3
            if mode == "review":
                payload, _ = engine.last_receipt_payload()
                if not payload:
                    print("No receipt available to analyze.")
                    continue
                analysis_ticker = ProgressTicker("Optimizing call")
                analysis_ticker.start_ticking()
                analysis = None
                reasoning_prompt = build_optimize_reasoning_prompt(payload, list(goals))
                reasoning = reasoning_summary(
                    reasoning_prompt, engine.text_model, compact=False
                )
                if reasoning:
                    _print_progress_safe(f"Reasoning: {reasoning}")
                try:
                    analysis = engine.analyze_last_receipt(goals=list(goals), mode=mode)
                finally:
                    analysis_ticker.stop(done=True)
                if not analysis:
                    print("No receipt available to analyze.")
                    continue
                if analysis.get("analysis_excerpt"):
                    print(f"Analysis: {analysis['analysis_excerpt']}")
                recommendations = analysis.get("recommendations") or []
                if recommendations:
                    print("Recommendations:")
                    for rec in recommendations:
                        if isinstance(rec, dict):
                            print(f"- {_format_recommendation(rec)}")
                analysis_elapsed = analysis.get("analysis_elapsed_s")
                if analysis_elapsed is not None:
                    print(elapsed_line("Optimize analysis in", analysis_elapsed))
                print("Review mode: no changes applied.")
                continue
            rounds_left = max_rounds - 1
            for round_idx in range(rounds_left):
                payload, _ = engine.last_receipt_payload()
                snapshot = engine.last_version_snapshot()
                if not payload or not snapshot:
                    print("No receipt available to analyze.")
                    break
                analysis_ticker = ProgressTicker(
                    f"Optimize round {round_idx + 2}/{max_rounds} • Optimizing call"
                )
                analysis_ticker.start_ticking()
                analysis = None
                reasoning_prompt = build_optimize_reasoning_prompt(payload, list(goals))
                reasoning = reasoning_summary(
                    reasoning_prompt, engine.text_model, compact=False
                )
                if reasoning:
                    _print_progress_safe(f"Reasoning: {reasoning}")
                try:
                    analysis = engine.analyze_last_receipt(
                        goals=list(goals),
                        mode=mode,
                        round_idx=round_idx + 2,
                        round_total=max_rounds,
                    )
                finally:
                    analysis_ticker.stop(done=True)
                if not analysis:
                    print("No receipt available to analyze.")
                    break
                if analysis.get("analysis_excerpt"):
                    print(f"Analysis: {analysis['analysis_excerpt']}")
                recommendations = analysis.get("recommendations") or []
                if not recommendations:
                    print("No recommendations; stopping optimize loop.")
                    break
                print("Recommendations:")
                for rec in recommendations:
                    if isinstance(rec, dict):
                        print(f"- {_format_recommendation(rec)}")
                updated_settings, updated_prompt, summary, skipped = engine.apply_recommendations(
                    snapshot["settings"], recommendations, prompt=snapshot.get("prompt")
                )
                if summary:
                    print(f"Applying: {', '.join(summary)}")
                if skipped:
                    print(f"Skipped: {', '.join(skipped)}")
                if not summary:
                    print("No parameter changes to apply; stopping optimize loop.")
                    break
                analysis_elapsed = analysis.get("analysis_elapsed_s")
                if analysis_elapsed is not None:
                    print(elapsed_line("Optimize analysis in", analysis_elapsed))
                ticker = ProgressTicker(
                    f"Optimize round {round_idx + 2}/{max_rounds} • Generating images"
                )
                ticker.start_ticking()
                error = None
                gen_started = time.monotonic()
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = engine.generate(
                        updated_prompt or snapshot["prompt"],
                        updated_settings,
                        {
                            "action": "optimize",
                            "parent_version_id": snapshot["version_id"],
                            "goals": list(goals),
                            "round": round_idx + 2,
                        },
                    )
                except Exception as exc:
                    error = exc
                finally:
                    gen_elapsed = time.monotonic() - gen_started
                    engine.events.emit(
                        "optimize_generation_done",
                        round=round_idx + 2,
                        round_total=max_rounds,
                        elapsed_s=gen_elapsed,
                        goals=list(goals),
                        success=error is None,
                        error=str(error) if error else None,
                    )
                    ticker.stop(done=True)
                if not error and artifacts:
                    last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")
                    used_prompt = updated_prompt or snapshot["prompt"]
                    if used_prompt:
                        last_prompt = used_prompt
                if error:
                    print(f"Generation failed: {error}")
                    break
            print("Optimize loop complete.")
            continue
        if intent.action == "export":
            out_path = run_dir / f"export-{now_utc_iso().replace(':', '').replace('-', '')}.html"
            export_html(run_dir, out_path)
            print(f"Exported report to {out_path}")
            continue
        if intent.action == "recreate":
            path = intent.command_args.get("path")
            if not path:
                print("/recreate requires a path")
                continue
            result = engine.recreate(Path(path), _settings_from_state(state))
            inferred = result.get("inferred_prompt") if isinstance(result, dict) else None
            if isinstance(inferred, str) and inferred.strip():
                source = result.get("prompt_source") if isinstance(result, dict) else None
                model = result.get("caption_model") if isinstance(result, dict) else None
                suffix = []
                if source:
                    suffix.append(str(source))
                if model:
                    suffix.append(str(model))
                meta = f" ({', '.join(suffix)})" if suffix else ""
                print(f"Inferred prompt{meta}: {inferred.strip()}")
            print("Recreate loop completed.")
            continue
        if intent.action == "unknown":
            print(f"Unknown command: {intent.command_args.get('command')}")
            continue
        if intent.action == "generate":
            prompt = intent.prompt or ""
            edit_request = is_edit_request(prompt)
            prompt, model_directive = extract_model_directive(prompt)
            is_edit = edit_request
            if not model_directive:
                edit_model = detect_edit_model(prompt)
                if edit_model:
                    model_directive = edit_model
                    is_edit = True
            if model_directive:
                engine.image_model = model_directive
                print(f"Image model set to {engine.image_model}")
                _maybe_warn_missing_flux_key(engine.image_model)
            generic_edit = prompt.strip().lower()
            generic_edit_phrases = {
                "edit the image",
                "edit image",
                "edit the photo",
                "edit photo",
                "edit this",
                "edit that",
                "edit it",
                "replace the image",
                "replace image",
                "replace the photo",
                "replace photo",
                "replace it",
                "replace this",
                "replace that",
            }
            if is_edit and generic_edit in generic_edit_phrases and last_prompt:
                prompt = last_prompt
            elif not is_edit:
                if (not prompt or is_repeat_request(prompt)) and last_prompt:
                    prompt = last_prompt
                elif last_prompt and is_refinement(prompt):
                    prompt = f"{last_prompt} Update: {prompt}"
            if prompt:
                last_prompt = prompt
            progress_once("Planning run")
            usage = engine.track_context(prompt, "", engine.text_model)
            pct = int(usage.get("pct", 0) * 100)
            alert = usage.get("alert_level")
            if alert and alert != "none":
                print(f"Context usage: {pct}% (alert {alert})")
            else:
                print(f"Context usage: {pct}%")
            settings = _settings_from_state(state)
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Generating images")
            ticker.start_ticking()
            start_reasoning_summary(prompt, engine.text_model, ticker)
            error: Exception | None = None
            if is_edit and last_artifact_path:
                settings["init_image"] = last_artifact_path
            artifacts: list[dict[str, object]] = []
            try:
                artifacts = engine.generate(prompt, settings, {"action": "generate"})
            except Exception as exc:
                error = exc
            finally:
                ticker.stop(done=True)
            if not error and artifacts:
                last_artifact_path = str(artifacts[-1].get("image_path") or last_artifact_path or "")
            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
            latency_raw = engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
            cost = format_cost_generation_cents(cost_raw) or "N/A"
            latency = format_latency_seconds(latency_raw) or "N/A"
            print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")
            if error:
                print(f"Generation failed: {error}")
            else:
                print("Generation complete.")
            continue

    if intent_rt is not None:
        intent_rt.stop()
    if mother_intent_rt is not None:
        mother_intent_rt.stop()
    if canvas_context_rt is not None:
        canvas_context_rt.stop()
    engine.finish()
    return 0


def _handle_run(args: argparse.Namespace) -> int:
    run_dir = Path(args.out)
    events_path = Path(args.events) if args.events else run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model=args.text_model, image_model=args.image_model)
    progress_once("Planning run")
    usage = engine.track_context(args.prompt, "", engine.text_model)
    pct = int(usage.get("pct", 0) * 100)
    alert = usage.get("alert_level")
    if alert and alert != "none":
        print(f"Context usage: {pct}% (alert {alert})")
    else:
        print(f"Context usage: {pct}%")
    settings = {"size": "1024x1024", "n": 1}
    plan = engine.preview_plan(args.prompt, settings)
    print(
        f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
        f"size={plan['size']} cached={plan['cached']}"
    )
    ticker = ProgressTicker("Generating images")
    ticker.start_ticking()
    start_reasoning_summary(args.prompt, engine.text_model, ticker)
    error: Exception | None = None
    try:
        engine.generate(args.prompt, settings, {"action": "generate"})
    except Exception as exc:
        error = exc
    finally:
        ticker.stop(done=True)
    if engine.last_fallback_reason:
        print(f"Model fallback: {engine.last_fallback_reason}")
    cost_raw = engine.last_cost_latency.get("cost_total_usd") if engine.last_cost_latency else None
    latency_raw = engine.last_cost_latency.get("latency_per_image_s") if engine.last_cost_latency else None
    cost = format_cost_generation_cents(cost_raw) or "N/A"
    latency = format_latency_seconds(latency_raw) or "N/A"
    print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")
    engine.finish()
    if error:
        print(f"Generation failed: {error}")
        return 1
    return 0


def _handle_recreate(args: argparse.Namespace) -> int:
    run_dir = Path(args.out)
    events_path = Path(args.events) if args.events else run_dir / "events.jsonl"
    engine = BroodEngine(run_dir, events_path, text_model=args.text_model, image_model=args.image_model)
    engine.recreate(Path(args.reference), {"size": "1024x1024", "n": 2})
    engine.finish()
    return 0


def _handle_export(args: argparse.Namespace) -> int:
    run_dir = Path(args.run)
    out_path = Path(args.out)
    export_html(run_dir, out_path)
    print(f"Exported to {out_path}")
    return 0


def main() -> None:
    load_dotenv()
    parser = _build_parser()
    args = parser.parse_args()
    if args.command == "chat":
        raise SystemExit(_handle_chat(args))
    if args.command == "run":
        raise SystemExit(_handle_run(args))
    if args.command == "recreate":
        raise SystemExit(_handle_recreate(args))
    if args.command == "export":
        raise SystemExit(_handle_export(args))
    parser.print_help()
    raise SystemExit(1)


if __name__ == "__main__":
    main()
