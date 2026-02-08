#!/usr/bin/env python3
"""
Build simple, token-budgeted AIP context packs (JSON) from this repo.

These packs are meant to be hosted on your own infra and returned by an AIP
intake endpoint to reduce agent discovery cost. The format here is intentionally
plain JSON (no custom binary/container).

Example:
  python scripts/aip_build_packs.py --all --out-dir outputs/aip_packs
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def _sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256()
    h.update(b)
    return h.hexdigest()


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _guess_kind(path: str) -> str:
    p = path.lower()
    if p.endswith((".md", ".txt")):
        return "doc"
    if p.startswith("scripts/") or p.endswith(".sh"):
        return "script"
    if p.endswith((".json", ".toml", ".yaml", ".yml")):
        return "config"
    if p.startswith("tests/"):
        return "test"
    if p.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".mov")):
        return "asset"
    return "source"


def _load_agent_intake() -> dict[str, Any]:
    return json.loads((REPO_ROOT / "agent-intake.json").read_text(encoding="utf-8"))


def _git_short_sha() -> str:
    try:
        out = subprocess.check_output(
            ["git", "rev-parse", "--short", "HEAD"],
            cwd=str(REPO_ROOT),
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out or "unknown"
    except Exception:
        return "unknown"


def _sanitize_filename(s: str) -> str:
    # Keep filenames simple for later hosting (no slashes).
    return re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_") or "unknown"


def _expand_entrypoints(paths: list[str]) -> list[str]:
    expanded: list[str] = []
    for p in paths:
        if not p:
            continue
        rel = p
        abs_p = (REPO_ROOT / rel).resolve()
        if rel.endswith("/") or abs_p.is_dir():
            if not abs_p.exists() or not abs_p.is_dir():
                continue
            # Shallow expansion: include immediate children only.
            children: list[str] = []
            for child in sorted(abs_p.iterdir(), key=lambda x: x.name):
                if child.name.startswith(".") or child.name == "__pycache__":
                    continue
                if child.is_file() and child.suffix.lower() in {
                    ".py",
                    ".md",
                    ".txt",
                    ".json",
                    ".toml",
                    ".yaml",
                    ".yml",
                    ".js",
                    ".css",
                    ".html",
                    ".sh",
                }:
                    children.append(str(child.relative_to(REPO_ROOT)))
            expanded.extend(children)
        else:
            expanded.append(rel)
    # Unique, stable order.
    seen: set[str] = set()
    out: list[str] = []
    for p in expanded:
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
    return out


def _merge_overlapping_ranges(ranges: list[tuple[int, int]]) -> list[tuple[int, int]]:
    if not ranges:
        return []
    ranges = sorted(ranges)
    merged: list[tuple[int, int]] = [ranges[0]]
    for start, end in ranges[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def _snippets_windows(lines: list[str], regexes: list[str], before: int, after: int) -> list[dict[str, Any]]:
    ranges: list[tuple[int, int]] = []
    for rx in regexes:
        pat = re.compile(rx)
        for i, line in enumerate(lines):
            if pat.search(line):
                start = max(0, i - before)
                end = min(len(lines), i + after)
                ranges.append((start, end))
    ranges = _merge_overlapping_ranges(ranges)
    snippets: list[dict[str, Any]] = []
    for start, end in ranges:
        content = "".join(lines[start:end])
        snippets.append(
            {
                "start_line": start + 1,
                "end_line": end,
                "content": content,
            }
        )
    return snippets


def _snippets_py_def_blocks(lines: list[str], fn_names: list[str], max_lines_per_block: int = 260) -> list[dict[str, Any]]:
    # Extract top-level def blocks by name (simple indentation-based slicing).
    idx_by_name: dict[str, int] = {}
    for i, line in enumerate(lines):
        if not line.startswith("def "):
            continue
        m = re.match(r"^def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", line)
        if not m:
            continue
        name = m.group(1)
        if name in fn_names and name not in idx_by_name:
            idx_by_name[name] = i

    starts = sorted(idx_by_name.values())
    if not starts:
        return []

    # Determine block end by next top-level def/class.
    boundaries: list[int] = []
    for i, line in enumerate(lines):
        if line.startswith("def ") or line.startswith("class "):
            boundaries.append(i)
    boundaries.append(len(lines))

    def next_boundary(start: int) -> int:
        for b in boundaries:
            if b > start:
                return b
        return len(lines)

    snippets: list[dict[str, Any]] = []
    for name in fn_names:
        if name not in idx_by_name:
            continue
        start = idx_by_name[name]
        end = next_boundary(start)
        end = min(end, start + max_lines_per_block)
        snippets.append(
            {
                "start_line": start + 1,
                "end_line": end,
                "content": "".join(lines[start:end]),
            }
        )
    return snippets


def _build_file_entry(
    rel_path: str,
    *,
    pack_id: str,
    include_full_under_bytes: int,
    per_file_max_chars: int,
) -> dict[str, Any] | None:
    abs_path = REPO_ROOT / rel_path
    if not abs_path.exists() or not abs_path.is_file():
        return None

    raw = abs_path.read_bytes()
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines(keepends=True)

    entry: dict[str, Any] = {
        "path": rel_path,
        "kind": _guess_kind(rel_path),
        "sha256": _sha256_bytes(raw),
        "bytes": len(raw),
        "lines": len(lines),
        "snippets": [],
    }

    # If it's small, include the full file.
    if len(raw) <= include_full_under_bytes:
        entry["snippets"] = [
            {
                "start_line": 1,
                "end_line": len(lines),
                "content": text[:per_file_max_chars],
                "purpose": "full (truncated by per-file budget)" if len(text) > per_file_max_chars else "full",
            }
        ]
        return entry

    # Heuristics for high-signal large files.
    snippets: list[dict[str, Any]] = []
    if rel_path == "desktop/src/canvas_app.js":
        snippets = _snippets_windows(
            lines,
            regexes=[
                r"^function\s+computeQuickActions\s*\(",
                r"^function\s+renderQuickActions\s*\(",
                r"Quick Actions",
            ],
            before=0,
            after=220,
        )
        for s in snippets:
            s["purpose"] = "Quick Actions implementation (window)"
    elif rel_path == "desktop/src/index.html":
        snippets = _snippets_windows(
            lines,
            regexes=[r"id=\"quick-actions\"", r"Quick Actions"],
            before=40,
            after=80,
        )
        for s in snippets:
            s["purpose"] = "Quick Actions panel markup (window)"
    elif rel_path == "desktop/src/styles.css":
        snippets = _snippets_windows(
            lines,
            regexes=[r"quick-actions", r"#quick-actions"],
            before=20,
            after=140,
        )
        for s in snippets:
            s["purpose"] = "Quick Actions styles (window)"
    elif rel_path == "brood_engine/cli.py":
        snippets = _snippets_py_def_blocks(
            lines,
            fn_names=["_build_parser", "_handle_chat", "_handle_run", "_handle_recreate", "_handle_export"],
            max_lines_per_block=300,
        )
        for s in snippets:
            s["purpose"] = "CLI entrypoints (def block)"
    else:
        # Generic fallback: include a head slice.
        head_lines = min(len(lines), 260)
        snippets = [
            {
                "start_line": 1,
                "end_line": head_lines,
                "content": "".join(lines[:head_lines]),
                "purpose": "head (generic fallback)",
            }
        ]

    # Apply per-file max chars across snippets.
    kept: list[dict[str, Any]] = []
    remaining = per_file_max_chars
    for s in snippets:
        content = s.get("content", "")
        if not content:
            continue
        if remaining <= 0:
            break
        if len(content) > remaining:
            s = dict(s)
            s["content"] = content[:remaining]
            s["purpose"] = str(s.get("purpose") or "").strip() + " (truncated)"
            kept.append(s)
            remaining = 0
            break
        kept.append(s)
        remaining -= len(content)

    entry["snippets"] = kept
    return entry


def build_pack(
    pack_id: str,
    entrypoints: list[str],
    *,
    repo_ref: str,
    include_full_under_bytes: int,
    max_chars: int,
    per_file_max_chars: int,
) -> dict[str, Any]:
    files: list[dict[str, Any]] = []
    total_chars = 0

    for rel_path in _expand_entrypoints(entrypoints):
        if total_chars >= max_chars:
            break
        fe = _build_file_entry(
            rel_path,
            pack_id=pack_id,
            include_full_under_bytes=include_full_under_bytes,
            per_file_max_chars=per_file_max_chars,
        )
        if not fe:
            continue
        # Count only snippet content toward the global budget.
        file_chars = sum(len(s.get("content", "")) for s in fe.get("snippets", []))
        if file_chars <= 0:
            continue
        if total_chars + file_chars > max_chars:
            # Trim snippets further to fit.
            remaining = max_chars - total_chars
            trimmed_snips: list[dict[str, Any]] = []
            for s in fe["snippets"]:
                c = s.get("content", "")
                if not c:
                    continue
                if remaining <= 0:
                    break
                if len(c) > remaining:
                    s = dict(s)
                    s["content"] = c[:remaining]
                    s["purpose"] = str(s.get("purpose") or "").strip() + " (truncated)"
                    trimmed_snips.append(s)
                    remaining = 0
                    break
                trimmed_snips.append(s)
                remaining -= len(c)
            fe = dict(fe)
            fe["snippets"] = trimmed_snips
            file_chars = sum(len(s.get("content", "")) for s in fe.get("snippets", []))
        files.append(fe)
        total_chars += file_chars

    return {
        "schema_version": "aip-pack-1",
        "pack_id": pack_id,
        "repo_ref": repo_ref,
        "generated_at": _utc_now_iso(),
        "max_chars": max_chars,
        "files": files,
        "notes": [
            "This pack contains excerpts only (not a full checkout). Use entrypoints to open the exact files if needed.",
            "Generated by scripts/aip_build_packs.py (stdlib only).",
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="Build AIP context packs (JSON).")
    ap.add_argument("--out-dir", default=str(REPO_ROOT / "outputs" / "aip_packs"))
    ap.add_argument("--tag", action="append", default=[], help="Pack/tag id to build (repeatable).")
    ap.add_argument("--all", action="store_true", help="Build packs for all tags in agent-intake.json.")
    ap.add_argument("--ref", default="", help="Repo ref to embed (defaults to git short SHA if available).")
    ap.add_argument("--max-chars", type=int, default=120_000, help="Global max chars per pack (snippets only).")
    ap.add_argument(
        "--per-file-max-chars",
        type=int,
        default=25_000,
        help="Max chars per file across its snippets.",
    )
    ap.add_argument(
        "--include-full-under-bytes",
        type=int,
        default=12_000,
        help="Include full file text when file size is at/below this threshold.",
    )
    ap.add_argument("--write-index", action="store_true", help="Write outputs/aip_packs/index.json.")
    args = ap.parse_args()

    intake = _load_agent_intake()
    tag_catalog: dict[str, Any] = intake.get("tag_catalog", {})
    all_tags = sorted(tag_catalog.keys())

    tags: list[str]
    if args.all:
        tags = all_tags
    elif args.tag:
        tags = args.tag
    else:
        tags = ["desktop-quick-actions", "engine-cli"]

    repo_ref = args.ref.strip() or _git_short_sha()
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    index: dict[str, Any] = {
        "schema_version": "aip-pack-index-1",
        "generated_at": _utc_now_iso(),
        "repo_ref": repo_ref,
        "packs": [],
    }

    for pack_id in tags:
        info = tag_catalog.get(pack_id)
        if not info:
            raise SystemExit(f"Unknown tag/pack id: {pack_id}")

        entrypoints = list(info.get("entrypoints", []))
        # Always include the minimal human/agent onboarding docs if present.
        for p in ("README.md", "AGENTS.md", "docs/desktop.md"):
            if (REPO_ROOT / p).exists() and p not in entrypoints:
                entrypoints.insert(0, p)

        pack = build_pack(
            pack_id,
            entrypoints,
            repo_ref=repo_ref,
            include_full_under_bytes=args.include_full_under_bytes,
            max_chars=args.max_chars,
            per_file_max_chars=args.per_file_max_chars,
        )

        filename = f"{_sanitize_filename(pack_id)}.json"
        out_path = out_dir / filename
        payload = json.dumps(pack, indent=2, sort_keys=False) + "\n"
        out_path.write_text(payload, encoding="utf-8")

        b = payload.encode("utf-8")
        index["packs"].append(
            {
                "id": pack_id,
                "filename": filename,
                "sha256": _sha256_bytes(b),
                "bytes": len(b),
            }
        )

        print(f"Wrote {out_path} ({len(b)} bytes)")

    if args.write_index:
        index_path = out_dir / "index.json"
        index_payload = json.dumps(index, indent=2, sort_keys=False) + "\n"
        index_path.write_text(index_payload, encoding="utf-8")
        print(f"Wrote {index_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
