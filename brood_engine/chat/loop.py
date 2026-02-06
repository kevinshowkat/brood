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
                        "/better /optimize /recreate /export"
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
