#!/usr/bin/env python3
"""Brood Image Harness

Feature 1 entrypoint:
- Catalog: provider/model capabilities + pricing table exposure
- Run: multi-step pipelines across providers/models with telemetry + manifest output

Examples:
  python scripts/image_harness.py catalog
  python scripts/image_harness.py catalog --format json

  python scripts/image_harness.py run \\
    --prompt "replace all people with dogs. keep background. preserve logos/text. do not crop." \\
    --inputs ./photo1.jpg ./photo2.jpg \\
    --out /tmp/brood-harness-run
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

from brood_engine.harness.runner import list_catalog_rows, run_harness
from brood_engine.utils import now_utc_iso


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="image_harness", description="Brood multi-provider image harness")
    sub = parser.add_subparsers(dest="cmd", required=True)

    catalog = sub.add_parser("catalog", help="Print model/provider capabilities + pricing info")
    catalog.add_argument("--format", choices=("table", "json"), default="table")
    catalog.add_argument("--catalog", action="append", default=[], help="Path to catalog override JSON (repeatable)")

    run = sub.add_parser("run", help="Run a harness experiment")
    run.add_argument("--prompt", required=True, help="Task instruction (edit prompt)")
    run.add_argument("--inputs", nargs="+", required=True, help="Image paths")
    run.add_argument("--out", default=None, help="Output directory (default: /tmp/brood-harness-<ts>)")
    run.add_argument("--catalog", action="append", default=[], help="Path to catalog override JSON (repeatable)")
    run.add_argument(
        "--provider-plugin",
        action="append",
        default=[],
        help="Extra provider plugin spec: python.module:FactoryOrClass (repeatable)",
    )

    args = parser.parse_args(argv)

    if args.cmd == "catalog":
        rows = list_catalog_rows(args.catalog)
        if args.format == "json":
            sys.stdout.write(json.dumps(rows, indent=2))
            sys.stdout.write("\n")
            return 0
        _print_catalog_table(rows)
        return 0

    if args.cmd == "run":
        out_dir = Path(args.out) if args.out else Path("/tmp") / f"brood-harness-{int(time.time())}"
        task = {"id": "ad-hoc", "prompt": str(args.prompt).strip(), "created_at": now_utc_iso()}
        pipelines = _default_pipelines(task_prompt=task["prompt"])
        result = run_harness(
            out_dir=out_dir,
            task=task,
            inputs=[Path(p) for p in args.inputs],
            pipelines=pipelines,
            catalog_paths=args.catalog,
            provider_plugins=args.provider_plugin,
        )
        sys.stdout.write(f"{result.manifest_path}\n")
        return 0

    return 2


def _default_pipelines(*, task_prompt: str) -> list[dict]:
    # Multi-model / multi-step: cheap local downscale + Gemini edit.
    # Keep prompts as templates so the runner can re-render if task changes.
    return [
        {
            "id": "gemini_flash_direct_2k",
            "label": "Gemini 2.5 Flash Image (direct, 2K)",
            "steps": [
                {
                    "type": "model",
                    "provider": "gemini",
                    "model": "gemini-2.5-flash-image",
                    "prompt": "{task_prompt}",
                    "provider_options": {"image_size": "2K"},
                    "inputs": {"init_image": True},
                }
            ],
        },
        {
            "id": "downscale_1024_then_gemini_flash_1k",
            "label": "Downscale 1024 (JPEG) -> Gemini 2.5 Flash Image (1K)",
            "steps": [
                {"type": "local_resize", "max_dim_px": 1024, "format": "jpeg", "quality": 82},
                {
                    "type": "model",
                    "provider": "gemini",
                    "model": "gemini-2.5-flash-image",
                    "prompt": "{task_prompt}",
                    "provider_options": {"image_size": "1K"},
                    "inputs": {"init_image": True},
                },
            ],
        },
    ]


def _print_catalog_table(rows: list[dict]) -> None:
    # Keep it readable in a terminal without extra deps.
    providers: dict[str, list[dict]] = {}
    for row in rows:
        providers.setdefault(row.get("provider") or "unknown", []).append(row)
    for provider in sorted(providers.keys()):
        sys.stdout.write(f"{provider}\n")
        sys.stdout.write("-" * len(provider) + "\n")
        for row in sorted(providers[provider], key=lambda r: str(r.get("model") or "")):
            model = row.get("model") or ""
            aliases = row.get("aliases") or []
            ops = ",".join(row.get("operations") or [])
            inits = "init" if row.get("supports_init_image") else "-"
            refs = "refs" if row.get("supports_reference_images") else "-"
            mask = "mask" if row.get("supports_mask") else "-"
            pricing_key = row.get("pricing_key") or "-"
            base_cost = (row.get("pricing") or {}).get("cost_per_image_usd")
            cost_str = f"${base_cost:.4f}" if isinstance(base_cost, (int, float)) else "-"
            alias_str = f" ({', '.join(aliases)})" if aliases else ""
            sys.stdout.write(f"  {model}{alias_str}\n")
            sys.stdout.write(f"    ops: {ops} | inputs: {inits},{refs},{mask}\n")
            if row.get("size_notes"):
                sys.stdout.write(f"    size: {row.get('size_notes')}\n")
            if pricing_key != "-":
                sys.stdout.write(f"    pricing_key: {pricing_key} | base: {cost_str}\n")
            tiers = _format_pricing_tiers(row.get("pricing") or {})
            if tiers:
                sys.stdout.write(f"    tiers: {tiers}\n")
        sys.stdout.write("\n")


def _format_pricing_tiers(pricing_row: dict) -> str | None:
    if not isinstance(pricing_row, dict):
        return None
    mult = pricing_row.get("cost_multipliers_by_image_size")
    if isinstance(mult, dict) and mult:
        parts = []
        for key in ("1K", "2K", "4K"):
            if key in mult:
                parts.append(f"{key}x{mult[key]}")
        for k, v in sorted(mult.items()):
            if k in {"1K", "2K", "4K"}:
                continue
            parts.append(f"{k}x{v}")
        return "image_size multipliers: " + ", ".join(parts)
    abs_by = pricing_row.get("cost_per_image_usd_by_image_size")
    if isinstance(abs_by, dict) and abs_by:
        parts = []
        for key in ("1K", "2K", "4K"):
            if key in abs_by:
                parts.append(f"{key}=${abs_by[key]}")
        for k, v in sorted(abs_by.items()):
            if k in {"1K", "2K", "4K"}:
                continue
            parts.append(f"{k}=${v}")
        return "image_size: " + ", ".join(parts)
    return None


if __name__ == "__main__":
    raise SystemExit(main())

