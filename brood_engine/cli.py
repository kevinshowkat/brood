"""Brood CLI entrypoints."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .chat.intent_parser import parse_intent
from .engine import BroodEngine
from .runs.export import export_html
from .utils import now_utc_iso, load_dotenv
from .cli_progress import progress_once, ProgressTicker


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="brood", description="Brood creative IDE engine")
    sub = parser.add_subparsers(dest="command")

    chat = sub.add_parser("chat", help="Interactive chat loop")
    chat.add_argument("--out", required=True, help="Run output directory")
    chat.add_argument("--events", help="Path to events.jsonl")
    chat.add_argument("--text-model", dest="text_model")
    chat.add_argument("--image-model", dest="image_model")

    run = sub.add_parser("run", help="Single-run generation")
    run.add_argument("--prompt", required=True)
    run.add_argument("--out", required=True)
    run.add_argument("--events")
    run.add_argument("--text-model", dest="text_model")
    run.add_argument("--image-model", dest="image_model")

    recreate = sub.add_parser("recreate", help="Recreate from reference image")
    recreate.add_argument("--reference", required=True, help="Path to reference image")
    recreate.add_argument("--out", required=True)
    recreate.add_argument("--events")
    recreate.add_argument("--text-model", dest="text_model")
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
            print("Commands: /profile /text_model /image_model /fast /quality /cheaper /better /recreate /export")
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
            continue
        if intent.action == "set_quality":
            state["quality_preset"] = intent.settings_update.get("quality_preset")
            print(f"Quality preset: {state['quality_preset']}")
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
            if last_prompt and len(prompt.split()) < 6:
                prompt = f"{last_prompt} Update: {prompt}"
            last_prompt = prompt
            progress_once("Planning run")
            usage = engine.track_context(prompt, "", engine.text_model)
            pct = int(usage.get("pct", 0) * 100)
            alert = usage.get("alert_level")
            print(f"Context usage: {pct}% (alert {alert})")
            settings = _settings_from_state(state)
            plan = engine.preview_plan(prompt, settings)
            print(
                f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                f"size={plan['size']} cached={plan['cached']}"
            )
            ticker = ProgressTicker("Generating images")
            ticker.start_ticking()
            try:
                engine.generate(prompt, settings, {"action": "generate"})
            finally:
                ticker.stop(done=True)
            if engine.last_fallback_reason:
                print(f"Model fallback: {engine.last_fallback_reason}")
            if engine.last_cost_latency:
                cost = engine.last_cost_latency.get("cost_per_1k_images_usd")
                latency = engine.last_cost_latency.get("latency_per_image_s")
                print(f"Cost per 1K images: {cost} | Latency per image (s): {latency}")
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
    print(f"Context usage: {pct}% (alert {alert})")
    settings = {"size": "1024x1024", "n": 1}
    plan = engine.preview_plan(args.prompt, settings)
    print(
        f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
        f"size={plan['size']} cached={plan['cached']}"
    )
    ticker = ProgressTicker("Generating images")
    ticker.start_ticking()
    try:
        engine.generate(args.prompt, settings, {"action": "generate"})
    finally:
        ticker.stop(done=True)
    if engine.last_fallback_reason:
        print(f"Model fallback: {engine.last_fallback_reason}")
    if engine.last_cost_latency:
        cost = engine.last_cost_latency.get("cost_per_1k_images_usd")
        latency = engine.last_cost_latency.get("latency_per_image_s")
        print(f"Cost per 1K images: {cost} | Latency per image (s): {latency}")
    engine.finish()
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
