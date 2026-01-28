"""Brood CLI entrypoints."""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from .chat.intent_parser import parse_intent
from .chat.refine import extract_model_directive, is_refinement, is_repeat_request
from .engine import BroodEngine
from .runs.export import export_html
from .utils import (
    now_utc_iso,
    load_dotenv,
    format_cost_generation_cents,
    format_latency_seconds,
    has_flux_key,
    is_flux_model,
)


def _maybe_warn_missing_flux_key(model: str | None) -> None:
    if not is_flux_model(model):
        return
    if has_flux_key():
        return
    print("Flux requires BFL_API_KEY (or FLUX_API_KEY). Set it before generating.")
from .cli_progress import progress_once, ProgressTicker, elapsed_line
from .reasoning import (
    start_reasoning_summary,
    reasoning_summary,
    build_optimize_reasoning_prompt,
)


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="brood", description="Brood creative IDE engine")
    sub = parser.add_subparsers(dest="command")

    chat = sub.add_parser("chat", help="Interactive chat loop")
    chat.add_argument("--out", required=True, help="Run output directory")
    chat.add_argument("--events", help="Path to events.jsonl")
    chat.add_argument("--text-model", dest="text_model", default="gpt-5.1-codex-max")
    chat.add_argument("--image-model", dest="image_model")

    run = sub.add_parser("run", help="Single-run generation")
    run.add_argument("--prompt", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--events")
    run.add_argument("--text-model", dest="text_model", default="gpt-5.1-codex-max")
    run.add_argument("--image-model", dest="image_model")

    recreate = sub.add_parser("recreate", help="Recreate from reference image")
    recreate.add_argument("--reference", required=True, help="Path to reference image")
    recreate.add_argument("--out", required=True)
    recreate.add_argument("--events")
    recreate.add_argument("--text-model", dest="text_model", default="gpt-5.1-codex-max")
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

    print("Brood chat started. Type /help for commands.")
    while True:
        try:
            line = input("> ")
        except (EOFError, KeyboardInterrupt):
            break
        intent = parse_intent(line)
        if intent.action == "noop":
            continue
        if intent.action == "help":
            print(
                "Commands: /profile /text_model /image_model /fast /quality /cheaper "
                "/better /optimize /recreate /export"
            )
            continue
        if intent.action == "set_profile":
            engine.profile = intent.command_args.get("profile") or "default"
            print(f"Profile set to {engine.profile}")
            continue
        if intent.action == "set_text_model":
            engine.text_model = intent.command_args.get("model") or engine.text_model
            print(f"Text model set to {engine.text_model}")
            continue
        if intent.action == "set_image_model":
            engine.image_model = intent.command_args.get("model") or engine.image_model
            print(f"Image model set to {engine.image_model}")
            _maybe_warn_missing_flux_key(engine.image_model)
            continue
        if intent.action == "set_quality":
            state["quality_preset"] = intent.settings_update.get("quality_preset")
            print(f"Quality preset: {state['quality_preset']}")
            continue
        if intent.action == "optimize":
            goals = intent.command_args.get("goals") or []
            if not goals:
                print("No goals provided. Use /optimize quality,cost,time,retrieval")
                continue
            print(f"Optimizing for: {', '.join(goals)}")
            max_rounds = 3
            rounds_left = max_rounds - 1
            for round_idx in range(rounds_left):
                analysis_started = time.monotonic()
                payload, _ = engine.last_receipt_payload()
                snapshot = engine.last_version_snapshot()
                if not payload or not snapshot:
                    print("No receipt available to analyze.")
                    break
                reasoning_prompt = build_optimize_reasoning_prompt(payload, list(goals))
                reasoning = reasoning_summary(
                    reasoning_prompt, engine.text_model, compact=False
                )
                if reasoning:
                    print(f"Reasoning: {reasoning}")
                analysis = engine.analyze_last_receipt(goals=list(goals))
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
                updated_settings, summary, skipped = engine.apply_recommendations(
                    snapshot["settings"], recommendations
                )
                if summary:
                    print(f"Applying: {', '.join(summary)}")
                if skipped:
                    print(f"Skipped: {', '.join(skipped)}")
                analysis_elapsed = time.monotonic() - analysis_started
                print(elapsed_line("Optimize analysis in", analysis_elapsed))
                ticker = ProgressTicker(
                    f"Optimize round {round_idx + 2}/{max_rounds} • Generating images"
                )
                ticker.start_ticking()
                error = None
                try:
                    engine.generate(
                        snapshot["prompt"],
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
                    ticker.stop(done=True)
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
            engine.recreate(Path(path), _settings_from_state(state))
            print("Recreate loop completed.")
            continue
        if intent.action == "unknown":
            print(f"Unknown command: {intent.command_args.get('command')}")
            continue
        if intent.action == "generate":
            prompt = intent.prompt or ""
            prompt, model_directive = extract_model_directive(prompt)
            if model_directive:
                engine.image_model = model_directive
                print(f"Image model set to {engine.image_model}")
                _maybe_warn_missing_flux_key(engine.image_model)
            if (not prompt or is_repeat_request(prompt)) and last_prompt:
                prompt = last_prompt
            elif last_prompt and is_refinement(prompt):
                prompt = f"{last_prompt} Update: {prompt}"
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
            try:
                engine.generate(prompt, settings, {"action": "generate"})
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
            print(f"Cost of generation: {cost} | Latency per image: {latency}")
            if error:
                print(f"Generation failed: {error}")
            else:
                print("Generation complete.")
            continue

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
    print(f"Cost of generation: {cost} | Latency per image: {latency}")
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
