"""Interactive chat loop wrapper."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .intent_parser import parse_intent
from .refine import extract_model_directive, is_refinement
from ..engine import BroodEngine
from ..runs.export import export_html
from ..utils import now_utc_iso
from ..cli_progress import progress_once, ProgressTicker


@dataclass
class ChatState:
    size: str = "1024x1024"
    n: int = 1
    quality_preset: str = "quality"


class ChatLoop:
    def __init__(self, engine: BroodEngine) -> None:
        self.engine = engine
        self.state = ChatState()
        self.last_prompt: str | None = None

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
                    print("Commands: /profile /text_model /image_model /fast /quality /cheaper /better /recreate /export")
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
                continue
            if intent.action == "set_quality":
                self.state.quality_preset = intent.settings_update.get("quality_preset")
                print(f"Quality preset: {self.state.quality_preset}")
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
                self.engine.recreate(Path(path), self._settings())
                print("Recreate loop completed.")
                continue
            if intent.action == "unknown":
                print(f"Unknown command: {intent.command_args.get('command')}")
                continue
            if intent.action == "generate":
                prompt = intent.prompt or ""
                prompt, model_directive = extract_model_directive(prompt)
                if model_directive:
                    self.engine.image_model = model_directive
                    print(f"Image model set to {self.engine.image_model}")
                if not prompt and self.last_prompt:
                    prompt = self.last_prompt
                elif self.last_prompt and is_refinement(prompt):
                    prompt = f"{self.last_prompt} Update: {prompt}"
                self.last_prompt = prompt
                progress_once("Planning run")
                usage = self.engine.track_context(prompt, "", self.engine.text_model)
                pct = int(usage.get("pct", 0) * 100)
                alert = usage.get("alert_level")
                print(f"Context usage: {pct}% (alert {alert})")
                settings = self._settings()
                plan = self.engine.preview_plan(prompt, settings)
                print(
                    f"Plan: {plan['images']} images via {plan['provider']}:{plan['model']} "
                    f"size={plan['size']} cached={plan['cached']}"
                )
                ticker = ProgressTicker("Generating images")
                ticker.start_ticking()
                try:
                    self.engine.generate(prompt, settings, {"action": "generate"})
                finally:
                    ticker.stop(done=True)
                if self.engine.last_fallback_reason:
                    print(f"Model fallback: {self.engine.last_fallback_reason}")
                if self.engine.last_cost_latency:
                    cost = self.engine.last_cost_latency.get("cost_per_1k_images_usd")
                    latency = self.engine.last_cost_latency.get("latency_per_image_s")
                    print(f"Cost per 1K images: {cost} | Latency per image (s): {latency}")
                print("Generation complete.")

        self.engine.finish()

    def _settings(self) -> dict[str, object]:
        return {
            "size": self.state.size,
            "n": self.state.n,
            "quality_preset": self.state.quality_preset,
        }
