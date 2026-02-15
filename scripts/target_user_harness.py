#!/usr/bin/env python3
"""Target user usability harness runner.

Usage example:
  python scripts/target_user_harness.py \
    --pack docs/target_user_harness.scenarios.sample.json \
    --out /tmp/target-user-harness \
    --panel-prompt-file docs/target_user_panel_prompt.md \
    --screenshot-source-dir /path/to/desktop/run-dir \
    --max-turns 10
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from brood_engine.harness.target_user import run_target_user_pack


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="target_user_harness",
        description="Run target-user usability harness scenarios against Brood.",
    )
    parser.add_argument("--pack", required=True, help="Path to a target_user_harness JSON pack")
    parser.add_argument(
        "--out",
        default=None,
        help="Output directory (default: /tmp/brood-target-user-harness-<ts>)",
    )
    parser.add_argument("--scenario", action="append", default=[], help="Filter by scenario id (repeatable)")
    parser.add_argument("--persona", action="append", default=[], help="Filter by persona id (repeatable)")
    parser.add_argument("--max-turns", type=int, help="Override max_turns from pack defaults/policy")
    parser.add_argument("--max-runtime-s", type=int, help="Override max_runtime_s from pack defaults/policy")
    parser.add_argument("--max-cost-usd", type=float, help="Override max_cost_usd from pack defaults/policy")
    parser.add_argument(
        "--adapter",
        choices=("chat_cli", "desktop_ui"),
        default=None,
        help="Runtime adapter. Defaults to pack `defaults.adapter`.",
    )
    parser.add_argument("--text-model", default=None, help="Override Brood chat text model")
    parser.add_argument("--image-model", default=None, help="Override Brood image model")
    parser.add_argument("--panel-model", default=None, help="LLM used for panel reaction synthesis")
    parser.add_argument(
        "--panel-reasoning-effort",
        default=None,
        choices=("minimal", "low", "medium", "high"),
        help="Reasoning effort for panel model (Responses API)",
    )
    parser.add_argument(
        "--panel-prompt",
        default=None,
        help="Inline panel prompt sent with each screenshot",
    )
    parser.add_argument(
        "--panel-prompt-file",
        default=None,
        help="Path to panel prompt file (loaded as plain text/markdown)",
    )
    parser.add_argument(
        "--panel-temperature",
        type=float,
        default=None,
        help="Panel LLM temperature",
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="Skip panel LLM calls and use heuristic fallback reflections",
    )
    parser.add_argument(
        "--screenshot-source-dir",
        default=None,
        help=(
            "Directory to read screenshots from (for desktop runs). "
            "If not provided and capture mode is auto, harness tries live macOS capture before synthetic fallback."
        ),
    )
    parser.add_argument(
        "--screenshot-capture-mode",
        choices=("auto", "source_dir", "synthetic"),
        default=None,
        help=(
            "Screenshot strategy: auto=try source dir then live macOS capture then synthetic fallback; "
            "source_dir=prefer source dir then synthetic fallback; synthetic=always synthetic."
        ),
    )
    parser.add_argument(
        "--screenshot-app-name",
        action="append",
        default=[],
        help="Process name to target for macOS auto window capture (repeatable, defaults include Brood).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Resolve pack/schemas and write session metadata without running chat",
    )
    parser.add_argument(
        "--desktop-bridge-socket",
        default=None,
        help=(
            "Unix socket path for desktop bridge when using --adapter desktop_ui "
            "(default: $BROOD_DESKTOP_BRIDGE_SOCKET or /tmp/brood_desktop_bridge.sock)."
        ),
    )
    parser.add_argument(
        "--desktop-events-path",
        default=None,
        help=(
            "Optional explicit events.jsonl path for desktop_ui mode. "
            "If unset, the harness reads events_path from desktop bridge status."
        ),
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)

    out_dir = (
        Path(args.out)
        if args.out
        else Path("/tmp") / f"brood-target-user-harness-{int(time.time())}"
    )
    run_dirs = run_target_user_pack(
        pack_path=Path(args.pack),
        out_dir=out_dir,
        scenario_filter=args.scenario if args.scenario else None,
        persona_filter=args.persona if args.persona else None,
        adapter=args.adapter,
        max_turns_override=args.max_turns,
        max_runtime_override_s=args.max_runtime_s,
        max_cost_override_usd=args.max_cost_usd,
        text_model=args.text_model,
        image_model=args.image_model,
        panel_model=args.panel_model,
        panel_reasoning_effort=args.panel_reasoning_effort,
        panel_prompt=args.panel_prompt,
        panel_prompt_path=args.panel_prompt_file,
        panel_temperature=args.panel_temperature,
        panel_enabled=not args.no_llm,
        screenshot_source_dir=args.screenshot_source_dir,
        screenshot_capture_mode=args.screenshot_capture_mode,
        screenshot_app_names=args.screenshot_app_name if args.screenshot_app_name else None,
        desktop_bridge_socket=args.desktop_bridge_socket,
        desktop_events_path=args.desktop_events_path,
        dry_run=args.dry_run,
    )

    for run_dir in run_dirs:
        sys.stdout.write(f"{run_dir}\n")

    for report_name in ("ux_improvements.md", "ten_x_competitive_edge.md"):
        report_path = out_dir / report_name
        if report_path.exists():
            sys.stdout.write(f"{report_path}\n")

    if not run_dirs:
        sys.stdout.write("No scenarios were selected. Nothing to run.\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
