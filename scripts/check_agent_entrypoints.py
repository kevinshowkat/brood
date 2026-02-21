#!/usr/bin/env python3
"""Validate agent-facing entrypoint references.

Checks:
- markdown links in llms.txt resolve to local files (for local paths)
- agent-intake.json schema.local_path exists
- agent-intake.json fallback_entrypoints[*].path exists
- agent-intake.json tag_catalog.*.entrypoints[*] exist
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Iterable


ROOT = Path(__file__).resolve().parent.parent


def _is_external_link(target: str) -> bool:
    lowered = target.lower()
    return lowered.startswith("http://") or lowered.startswith("https://") or lowered.startswith("mailto:")


def _normalize_path(target: str) -> str:
    target = target.strip()
    if "#" in target:
        target = target.split("#", 1)[0]
    if "?" in target:
        target = target.split("?", 1)[0]
    if target.startswith("./"):
        target = target[2:]
    if target.startswith("/"):
        target = target[1:]
    return target


def _iter_llms_markdown_links(llms_path: Path) -> Iterable[str]:
    text = llms_path.read_text(encoding="utf-8")
    for match in re.finditer(r"\[[^\]]+\]\(([^)]+)\)", text):
        target = match.group(1).strip()
        if not target:
            continue
        if target.startswith("#"):
            continue
        if _is_external_link(target):
            continue
        normalized = _normalize_path(target)
        if normalized:
            yield normalized


def _check_exists(path_str: str, context: str, errors: list[str]) -> None:
    path = ROOT / path_str
    if not path.exists():
        errors.append(f"{context}: missing path `{path_str}`")


def _validate_llms(errors: list[str]) -> None:
    llms_path = ROOT / "llms.txt"
    if not llms_path.exists():
        errors.append("llms check: missing `llms.txt`")
        return
    seen: set[str] = set()
    for rel in _iter_llms_markdown_links(llms_path):
        if rel in seen:
            continue
        seen.add(rel)
        _check_exists(rel, "llms.txt link", errors)


def _validate_agent_intake(errors: list[str]) -> None:
    intake_path = ROOT / "agent-intake.json"
    if not intake_path.exists():
        errors.append("intake check: missing `agent-intake.json`")
        return

    try:
        payload = json.loads(intake_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        errors.append(f"intake check: invalid JSON in `agent-intake.json` ({exc})")
        return

    schema_local_path = str(payload.get("schema", {}).get("local_path", "")).strip()
    if schema_local_path:
        _check_exists(schema_local_path, "agent-intake schema.local_path", errors)
    else:
        errors.append("agent-intake check: missing `schema.local_path`")

    fallback = payload.get("fallback_entrypoints")
    if isinstance(fallback, list):
        for idx, entry in enumerate(fallback):
            if not isinstance(entry, dict):
                errors.append(f"agent-intake fallback_entrypoints[{idx}] is not an object")
                continue
            path_str = str(entry.get("path", "")).strip()
            if not path_str:
                errors.append(f"agent-intake fallback_entrypoints[{idx}] missing `path`")
                continue
            _check_exists(path_str, f"agent-intake fallback_entrypoints[{idx}]", errors)
    else:
        errors.append("agent-intake check: `fallback_entrypoints` must be an array")

    tag_catalog = payload.get("tag_catalog")
    if isinstance(tag_catalog, dict):
        for tag, cfg in tag_catalog.items():
            if not isinstance(cfg, dict):
                errors.append(f"agent-intake tag_catalog.{tag} is not an object")
                continue
            entrypoints = cfg.get("entrypoints")
            if not isinstance(entrypoints, list):
                errors.append(f"agent-intake tag_catalog.{tag}.entrypoints must be an array")
                continue
            for idx, path_val in enumerate(entrypoints):
                path_str = str(path_val).strip()
                if not path_str:
                    errors.append(f"agent-intake tag_catalog.{tag}.entrypoints[{idx}] is empty")
                    continue
                _check_exists(path_str, f"agent-intake tag_catalog.{tag}.entrypoints[{idx}]", errors)
    else:
        errors.append("agent-intake check: `tag_catalog` must be an object")


def main() -> int:
    errors: list[str] = []
    _validate_llms(errors)
    _validate_agent_intake(errors)

    if errors:
        print("Agent entrypoint validation failed:", file=sys.stderr)
        for err in errors:
            print(f"- {err}", file=sys.stderr)
        return 1

    print("Agent entrypoint validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
