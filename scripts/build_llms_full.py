#!/usr/bin/env python3
"""Build llms-full.txt from canonical Brood docs."""

from __future__ import annotations

import argparse
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "llms-full.txt"

SOURCES = [
    "llms.txt",
    "README.md",
    "AGENTS.md",
    "docs/desktop.md",
    "agent-intake.json",
    "docs/aip-1.schema.json",
]


def _read_text(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"missing source file: {path}")
    return path.read_text(encoding="utf-8").rstrip() + "\n"


def build_llms_full(out_path: Path) -> None:
    parts: list[str] = [
        "# Brood llms-full.txt",
        "",
        "Expanded context for agents. This file is generated; do not edit manually.",
        "",
        "Regenerate with:",
        "`python3 scripts/build_llms_full.py`",
        "",
    ]

    for rel in SOURCES:
        source_path = REPO_ROOT / rel
        parts.append(f"## Source: `{rel}`")
        parts.append("")
        parts.append(_read_text(source_path))

    out_path.write_text("\n".join(parts).rstrip() + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build llms-full.txt from canonical docs.")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="Output path for llms-full.txt")
    args = parser.parse_args()
    out_path = Path(args.out).resolve()
    build_llms_full(out_path)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
