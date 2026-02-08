"""Interactive chat loop wrapper."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
import time
import sys

from .intent_parser import parse_intent
from .refine import extract_model_directive, detect_edit_model, is_edit_request, is_refinement, is_repeat_request
from ..engine import BroodEngine
from ..runs.export import export_html
from ..utils import now_utc_iso
from ..cli_progress import progress_once, ProgressTicker, elapsed_line
from ..reasoning import (
    start_reasoning_summary,
    reasoning_summary,
    build_optimize_reasoning_prompt,
)
from ..utils import (
    format_cost_generation_cents,
    format_latency_seconds,
    ansi_highlight,
    has_flux_key,
    is_flux_model,
)
from ..recreate.caption import infer_description, infer_diagnosis, infer_argument
from ..recreate.triplet import infer_triplet_rule, infer_triplet_odd_one_out


def _maybe_warn_missing_flux_key(model: str | None) -> None:
    if not is_flux_model(model):
        return
    if has_flux_key():
        return
    print("Flux requires BFL_API_KEY (or FLUX_API_KEY). Set it before generating.")


def _print_progress_safe(message: str) -> None:
    prefix = "\r\n" if getattr(sys.stdout, "isatty", lambda: False)() else ""
    print(f"{prefix}{message}")


@dataclass
class ChatState:
    size: str = "1024x1024"
    n: int = 1
    quality_preset: str = "quality"
    goals: list[str] | None = None


class ChatLoop:
    def __init__(self, engine: BroodEngine) -> None:
        self.engine = engine
        self.state = ChatState()
        self.last_prompt: str | None = None
        self.last_artifact_path: str | None = None

    def run(self) -> None:
        print("Brood chat started. Type /help for commands.")
        while True:
            try:
                line = input("> ")
            except (EOFError, KeyboardInterrupt):
                break
            intent = parse_intent(line)
            if intent.action in {"noop", "help"}:
                if intent.action == "help":
                    print(
                        "Commands: /profile /text_model /image_model /fast /quality /cheaper "
                        "/better /optimize /recreate /describe /diagnose /recast /use "
                        "/blend /swap_dna /argue /bridge /extract_rule /odd_one_out /triforce /export"
                    )
                continue
            if intent.action == "set_profile":
                self.engine.profile = intent.command_args.get("profile") or "default"
                print(f"Profile set to {self.engine.profile}")
                continue
            if intent.action == "set_text_model":
                self.engine.text_model = intent.command_args.get("model") or self.engine.text_model
                print(f"Text model set to {self.engine.text_model}")
                continue
            if intent.action == "set_image_model":
                self.engine.image_model = intent.command_args.get("model") or self.engine.image_model
                print(f"Image model set to {self.engine.image_model}")
                _maybe_warn_missing_flux_key(self.engine.image_model)
                continue
            if intent.action == "set_active_image":
                path = intent.command_args.get("path")
                if not path:
                    print("/use requires a path")
                    continue
                self.last_artifact_path = str(path)
                print(f"Active image set to {self.last_artifact_path}")
                continue
            if intent.action == "describe":
                raw_path = intent.command_args.get("path") or self.last_artifact_path
                if not raw_path:
                    print("/describe requires a path (or set an active image with /use)")
                    continue
                path = Path(str(raw_path))
                if not path.exists():
                    print(f"Describe failed: file not found ({path})")
                    continue
                # Keep it short for the HUD.
                max_chars = 32
                inference = None
                try:
                    inference = infer_description(path, max_chars=max_chars)
                except Exception:
                    inference = None
                if inference is None or not inference.description:
                    print("Describe unavailable (missing keys or vision client).")
                    continue
                self.engine.events.emit(
                    "image_description",
                    image_path=str(path),
                    description=inference.description,
                    source=inference.source,
                    model=inference.model,
                    max_chars=max_chars,
                )
                meta = []
                if inference.source:
                    meta.append(str(inference.source))
                if inference.model:
                    meta.append(str(inference.model))
                suffix = f" ({', '.join(meta)})" if meta else ""
                print(f"Description{suffix}: {inference.description}")
                continue
            if intent.action == "diagnose":
                raw_path = intent.command_args.get("path") or self.last_artifact_path
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
                    self.engine.events.emit("image_diagnosis_failed", image_path=str(path), error=msg)
                    print(msg)
                    continue
                self.engine.events.emit(
                    "image_diagnosis",
                    image_path=str(path),
                    text=inference.text,
                    source=inference.source,
                    model=inference.model,
                )
                print(inference.text)
                continue
            if intent.action == "recast":
                raw_path = intent.command_args.get("path") or self.last_artifact_path
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
                settings = self._settings()
                settings["init_image"] = str(path)
                ticker = ProgressTicker("Recasting image")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(
                        prompt,
                        settings,
                        {"action": "recast", "source_images": [str(path)]},
                    )
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if error:
                    print(f"Recast failed: {error}")
                    continue
                if artifacts:
                    self.last_artifact_path = str(
                        artifacts[-1].get("image_path") or self.last_artifact_path or ""
                    )
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
                settings = self._settings()
                settings["init_image"] = str(path_a)
                settings["reference_images"] = [str(path_b)]
                ticker = ProgressTicker("Blending images")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(
                        prompt,
                        settings,
                        {"action": "blend", "source_images": [str(path_a), str(path_b)]},
                    )
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if error:
                    print(f"Blend failed: {error}")
                    continue
                if artifacts:
                    self.last_artifact_path = str(
                        artifacts[-1].get("image_path") or self.last_artifact_path or ""
                    )
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
                    self.engine.events.emit(
                        "image_argument_failed",
                        image_paths=[str(path_a), str(path_b)],
                        error=msg,
                    )
                    print(msg)
                    continue
                self.engine.events.emit(
                    "image_argument",
                    image_paths=[str(path_a), str(path_b)],
                    text=inference.text,
                    source=inference.source,
                    model=inference.model,
                )
                print(inference.text)
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
                    self.engine.events.emit(
                        "triplet_rule_failed",
                        image_paths=[str(path_a), str(path_b), str(path_c)],
                        error=msg,
                    )
                    print(msg)
                    continue
                self.engine.events.emit(
                    "triplet_rule",
                    image_paths=[str(path_a), str(path_b), str(path_c)],
                    principle=inference.principle,
                    evidence=inference.evidence,
                    annotations=inference.annotations,
                    source=inference.source,
                    model=inference.model,
                    confidence=inference.confidence,
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
                    self.engine.events.emit(
                        "triplet_odd_one_out_failed",
                        image_paths=[str(path_a), str(path_b), str(path_c)],
                        error=msg,
                    )
                    print(msg)
                    continue
                self.engine.events.emit(
                    "triplet_odd_one_out",
                    image_paths=[str(path_a), str(path_b), str(path_c)],
                    odd_image=inference.odd_image,
                    odd_index=inference.odd_index,
                    pattern=inference.pattern,
                    explanation=inference.explanation,
                    source=inference.source,
                    model=inference.model,
                    confidence=inference.confidence,
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
                settings = self._settings()
                settings["n"] = 1
                settings["init_image"] = str(path_a)
                settings["reference_images"] = [str(path_b), str(path_c)]
                ticker = ProgressTicker("Triforcing images")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(
                        prompt,
                        settings,
                        {"action": "triforce", "source_images": [str(path_a), str(path_b), str(path_c)]},
                    )
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if error:
                    print(f"Triforce failed: {error}")
                    continue
                if artifacts:
                    self.last_artifact_path = str(
                        artifacts[-1].get("image_path") or self.last_artifact_path or ""
                    )
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
                settings = self._settings()
                settings["init_image"] = str(path_a)
                settings["reference_images"] = [str(path_b)]
                ticker = ProgressTicker("Bridging images")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(
                        prompt,
                        settings,
                        {"action": "bridge", "source_images": [str(path_a), str(path_b)]},
                    )
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if error:
                    print(f"Bridge failed: {error}")
                    continue
                if artifacts:
                    self.last_artifact_path = str(
                        artifacts[-1].get("image_path") or self.last_artifact_path or ""
                    )
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
                settings = self._settings()
                settings["init_image"] = str(path_a)
                settings["reference_images"] = [str(path_b)]
                ticker = ProgressTicker("Swapping DNA")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(
                        prompt,
                        settings,
                        {"action": "swap_dna", "source_images": [str(path_a), str(path_b)]},
                    )
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if error:
                    print(f"Swap DNA failed: {error}")
                    continue
                if artifacts:
                    self.last_artifact_path = str(
                        artifacts[-1].get("image_path") or self.last_artifact_path or ""
                    )
                print("Swap DNA complete.")
                continue
            if intent.action == "set_quality":
                self.state.quality_preset = intent.settings_update.get("quality_preset")
                print(f"Quality preset: {self.state.quality_preset}")
                continue
            if intent.action == "optimize":
                goals = intent.command_args.get("goals") or []
                mode = (intent.command_args.get("mode") or "auto").lower()
                if mode not in {"auto", "review"}:
                    mode = "auto"
                if not goals:
                    print("No goals provided. Use /optimize [review] quality,cost,time,retrieval")
                    continue
                self.state.goals = list(goals)
                print(f"Optimizing for: {', '.join(goals)} ({mode})")
                max_rounds = 3
                if mode == "review":
                    payload, _ = self.engine.last_receipt_payload()
                    if not payload:
                        print("No receipt available to analyze.")
                        continue
                    analysis_ticker = ProgressTicker("Optimizing call")
                    analysis_ticker.start_ticking()
                    analysis = None
                    reasoning_prompt = build_optimize_reasoning_prompt(payload, list(goals))
                    reasoning = reasoning_summary(
                        reasoning_prompt, self.engine.text_model, compact=False
                    )
                    if reasoning:
                        _print_progress_safe(f"Reasoning: {reasoning}")
                    try:
                        analysis = self.engine.analyze_last_receipt(goals=list(goals), mode=mode)
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
                                name = rec.get("setting_name")
                                value = rec.get("setting_value")
                                target = rec.get("setting_target") or "provider_options"
                                if target == "comment":
                                    print(f"- {value}")
                                    continue
                                if target in {"request", "top_level"}:
                                    print(f"- {name}={value}")
                                else:
                                    print(f"- provider_options.{name}={value}")
                    analysis_elapsed = analysis.get("analysis_elapsed_s")
                    if analysis_elapsed is not None:
                        print(elapsed_line("Optimize analysis in", analysis_elapsed))
                    print("Review mode: no changes applied.")
                    continue
                rounds_left = max_rounds - 1
                for round_idx in range(rounds_left):
                    payload, _ = self.engine.last_receipt_payload()
                    snapshot = self.engine.last_version_snapshot()
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
                        reasoning_prompt, self.engine.text_model, compact=False
                    )
                    if reasoning:
                        _print_progress_safe(f"Reasoning: {reasoning}")
                    try:
                        analysis = self.engine.analyze_last_receipt(
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
                            name = rec.get("setting_name")
                            value = rec.get("setting_value")
                            target = rec.get("setting_target") or "provider_options"
                            if target == "comment":
                                print(f"- {value}")
                                continue
                            if target in {"request", "top_level"}:
                                print(f"- {name}={value}")
                            else:
                                print(f"- provider_options.{name}={value}")
                    updated_settings, updated_prompt, summary, skipped = self.engine.apply_recommendations(
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
                        artifacts = self.engine.generate(
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
                        self.engine.events.emit(
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
                        self.last_artifact_path = str(
                            artifacts[-1].get("image_path") or self.last_artifact_path or ""
                        )
                        used_prompt = updated_prompt or snapshot["prompt"]
                        if used_prompt:
                            self.last_prompt = used_prompt
                    if error:
                        print(f"Generation failed: {error}")
                        break
                print("Optimize loop complete.")
                continue
            if intent.action == "export":
                out_path = self.engine.run_dir / f"export-{now_utc_iso().replace(':', '').replace('-', '')}.html"
                export_html(self.engine.run_dir, out_path)
                print(f"Exported report to {out_path}")
                continue
            if intent.action == "recreate":
                path = intent.command_args.get("path")
                if not path:
                    print("/recreate requires a path")
                    continue
                result = self.engine.recreate(Path(path), self._settings())
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
                    self.engine.image_model = model_directive
                    print(f"Image model set to {self.engine.image_model}")
                    _maybe_warn_missing_flux_key(self.engine.image_model)
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
                if is_edit and generic_edit in generic_edit_phrases and self.last_prompt:
                    prompt = self.last_prompt
                elif not is_edit:
                    if (not prompt or is_repeat_request(prompt)) and self.last_prompt:
                        prompt = self.last_prompt
                    elif self.last_prompt and is_refinement(prompt):
                        prompt = f"{self.last_prompt} Update: {prompt}"
                if prompt:
                    self.last_prompt = prompt
                progress_once("Planning run")
                usage = self.engine.track_context(prompt, "", self.engine.text_model)
                pct = int(usage.get("pct", 0) * 100)
                alert = usage.get("alert_level")
                if alert and alert != "none":
                    print(f"Context usage: {pct}% (alert {alert})")
                else:
                    print(f"Context usage: {pct}%")
                settings = self._settings()
                plan = self.engine.preview_plan(prompt, settings)
                print(
                    f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                    f"size={plan['size']} cached={plan['cached']}"
                )
                ticker = ProgressTicker("Generating images")
                ticker.start_ticking()
                start_reasoning_summary(prompt, self.engine.text_model, ticker)
                error: Exception | None = None
                if is_edit and self.last_artifact_path:
                    settings["init_image"] = self.last_artifact_path
                artifacts: list[dict[str, object]] = []
                try:
                    artifacts = self.engine.generate(prompt, settings, {"action": "generate"})
                except Exception as exc:
                    error = exc
                finally:
                    ticker.stop(done=True)
                if not error and artifacts:
                    self.last_artifact_path = str(artifacts[-1].get("image_path") or self.last_artifact_path or "")
                if self.engine.last_fallback_reason:
                    print(f"Model fallback: {self.engine.last_fallback_reason}")
                cost_raw = (
                    self.engine.last_cost_latency.get("cost_total_usd")
                    if self.engine.last_cost_latency
                    else None
                )
                latency_raw = (
                    self.engine.last_cost_latency.get("latency_per_image_s")
                    if self.engine.last_cost_latency
                    else None
                )
                cost = format_cost_generation_cents(cost_raw) or "N/A"
                latency = format_latency_seconds(latency_raw) or "N/A"
                print(f"Cost of generation: {ansi_highlight(cost)} | Latency per image: {ansi_highlight(latency)}")
                if error:
                    print(f"Generation failed: {error}")
                else:
                    print("Generation complete.")

        self.engine.finish()

    def _settings(self) -> dict[str, object]:
        return {
            "size": self.state.size,
            "n": self.state.n,
            "quality_preset": self.state.quality_preset,
        }
