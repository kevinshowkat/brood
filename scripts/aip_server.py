#!/usr/bin/env python3
"""
Local Agent Intake Protocol (AIP) stub server.

This is intentionally dependency-free (stdlib only) so you can run it anywhere.
It is meant for local testing of the intake contract + optional pack downloads.

Usage:
  python scripts/aip_build_packs.py --all --out-dir outputs/aip_packs
  python scripts/aip_server.py --port 8787 --packs-dir outputs/aip_packs

Endpoints:
  GET  /healthz
  POST /aip/intake
  GET  /aip/packs/<filename>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sys
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]


def _json_dumps(obj: Any) -> bytes:
    return (json.dumps(obj, indent=2, sort_keys=False) + "\n").encode("utf-8")


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


def _sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256()
    h.update(b)
    return h.hexdigest()


def _load_agent_intake(repo_root: Path) -> dict[str, Any]:
    path = repo_root / "agent-intake.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _dedupe_keep_order(items: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for it in items:
        v = str(it.get(key, ""))
        if not v or v in seen:
            continue
        seen.add(v)
        out.append(it)
    return out


def _safe_pack_filename(name: str) -> str | None:
    # Restrict to simple filenames to avoid path traversal.
    if not name or "/" in name or "\\" in name:
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-@")
    if any(ch not in allowed for ch in name):
        return None
    return name


class _Handler(BaseHTTPRequestHandler):
    server_version = "brood-aip/0"

    def _send_json(self, status: int, payload: Any, headers: dict[str, str] | None = None) -> None:
        body = _json_dumps(payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Brood-Opt-Out")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        if headers:
            for k, v in headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> dict[str, Any] | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _log(self, msg: str) -> None:
        sys.stderr.write(msg + "\n")

    def do_OPTIONS(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Brood-Opt-Out")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            self._send_json(HTTPStatus.OK, {"ok": True, "ts": int(time.time())})
            return

        if parsed.path.startswith("/aip/packs/"):
            filename = unquote(parsed.path.split("/aip/packs/", 1)[1])
            filename = _safe_pack_filename(filename)
            if not filename:
                self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid pack filename"})
                return
            pack_path = self.server.packs_dir / filename  # type: ignore[attr-defined]
            if not pack_path.exists() or not pack_path.is_file():
                self._send_json(HTTPStatus.NOT_FOUND, {"error": "pack not found"})
                return
            data = pack_path.read_bytes()
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(data)
            return

        self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 (BaseHTTPRequestHandler API)
        parsed = urlparse(self.path)
        if parsed.path != "/aip/intake":
            self._send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        req = self._read_json_body()
        if not req:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
            return

        # Minimal validation (keep stdlib-only).
        if req.get("schema_version") != "aip-1":
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "unsupported schema_version"})
            return
        agent = req.get("agent") or {}
        task = req.get("task") or {}
        if not isinstance(agent, dict) or not agent.get("tool"):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing agent.tool"})
            return
        if not isinstance(task, dict):
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": "missing task"})
            return
        raw_tags = task.get("tags")
        if raw_tags is None:
            raw_tags = []
        if not isinstance(raw_tags, list) or not all(isinstance(t, str) for t in raw_tags):
            self._send_json(
                HTTPStatus.BAD_REQUEST,
                {"error": "task.tags[] must be an array of strings when provided"},
            )
            return
        tags: list[str] = []
        seen_tags: set[str] = set()
        for tag in raw_tags:
            clean = tag.strip()
            if not clean or clean in seen_tags:
                continue
            seen_tags.add(clean)
            tags.append(clean)
        tags = tags[:16]

        intake = self.server.agent_intake  # type: ignore[attr-defined]
        tag_catalog: dict[str, Any] = intake.get("tag_catalog", {})
        suggested_tags: list[str] = []
        intake_tags = intake.get("tags", [])
        if isinstance(intake_tags, list):
            for tag in intake_tags:
                if not isinstance(tag, str):
                    continue
                clean = tag.strip()
                if not clean or clean in suggested_tags:
                    continue
                suggested_tags.append(clean)
        if not suggested_tags:
            for tag in tag_catalog.keys():
                if not isinstance(tag, str):
                    continue
                clean = tag.strip()
                if not clean or clean in suggested_tags:
                    continue
                suggested_tags.append(clean)
        suggested_tags = suggested_tags[:32]

        entrypoints: list[dict[str, Any]] = []
        commands: list[str] = []
        packs: list[dict[str, Any]] = []

        # Tag-specific entrypoints (highest priority).
        for tag in tags:
            info = tag_catalog.get(tag)
            if not info:
                continue
            desc = str(info.get("description") or "").strip()
            for p in info.get("entrypoints", []):
                if not isinstance(p, str) or not p:
                    continue
                entrypoints.append(
                    {
                        "path": p,
                        "kind": _guess_kind(p),
                        "why": f"{tag}: {desc}" if desc else f"{tag}",
                        "priority": 1,
                    }
                )

            # If a pack exists on disk for this tag, offer it.
            for candidate in (f"{tag}.json",):
                pack_path = self.server.packs_dir / candidate  # type: ignore[attr-defined]
                if pack_path.exists() and pack_path.is_file():
                    b = pack_path.read_bytes()
                    packs.append(
                        {
                            "id": tag,
                            "url": f"{self.server.base_url}/aip/packs/{candidate}",  # type: ignore[attr-defined]
                            "sha256": _sha256_bytes(b),
                            "bytes": len(b),
                            "purpose": f"Context pack for tag '{tag}'",
                        }
                    )
                    break

            if tag.startswith("desktop"):
                commands.append("./scripts/dev_desktop.sh")
            if tag.startswith("engine") or tag == "tests":
                commands.append("python -m pytest")

        # Fall back to repo-provided entrypoints (lower priority).
        for ep in intake.get("fallback_entrypoints", []):
            if not isinstance(ep, dict):
                continue
            path = ep.get("path")
            if not isinstance(path, str) or not path:
                continue
            entrypoints.append(
                {
                    "path": path,
                    "kind": ep.get("kind") or _guess_kind(path),
                    "why": ep.get("why") or "Recommended repo entrypoint.",
                    "priority": int(ep.get("priority") or 5),
                }
            )

        entrypoints = _dedupe_keep_order(entrypoints, key="path")
        commands = list(dict.fromkeys(commands))  # unique, stable order
        packs = _dedupe_keep_order(packs, key="url")

        # Telemetry opt-out: honor either request field or header.
        opt_out = False
        try:
            opt_out = bool((req.get("telemetry") or {}).get("opt_out"))
        except Exception:
            opt_out = False
        if self.headers.get("X-Brood-Opt-Out", "").strip() == "1":
            opt_out = True

        sess_id = "sess_" + secrets.token_urlsafe(12)
        resp: dict[str, Any] = {
            "schema_version": "aip-1",
            "session": {"id": sess_id},
            "entrypoints": entrypoints[:64],
            "suggested_tags": suggested_tags,
        }
        if commands:
            resp["commands"] = commands[:32]
        if packs:
            resp["packs"] = packs[:16]
        notes = [
            "This is a local stub server (stdlib only). For production, add auth/rate-limits and stricter logging hygiene.",
            "If you cannot use AIP, follow llms.txt fallback entrypoints (README.md, AGENTS.md, docs/desktop.md).",
        ]
        if not tags:
            notes.insert(
                0,
                "No task.tags[] were provided; returned fallback entrypoints. Use suggested_tags to narrow a follow-up intake call.",
            )
        resp["notes"] = notes

        if not opt_out:
            self._log(
                json.dumps(
                    {
                        "ts": int(time.time()),
                        "agent_tool": agent.get("tool"),
                        "agent_version": agent.get("tool_version"),
                        "tags": tags,
                        "session": sess_id,
                    }
                )
            )

        self._send_json(HTTPStatus.OK, resp)


def main() -> int:
    ap = argparse.ArgumentParser(description="Local AIP stub server (stdlib only).")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument(
        "--base-url",
        default="",
        help="Public base URL to place into pack URLs (defaults to http://{host}:{port}).",
    )
    ap.add_argument(
        "--packs-dir",
        default=str(REPO_ROOT / "outputs" / "aip_packs"),
        help="Directory containing pack JSON files (served under /aip/packs/*).",
    )
    args = ap.parse_args()

    packs_dir = Path(args.packs_dir).resolve()
    packs_dir.mkdir(parents=True, exist_ok=True)

    base_url = args.base_url.strip()
    if not base_url:
        base_url = f"http://{args.host}:{args.port}"

    server = ThreadingHTTPServer((args.host, args.port), _Handler)
    server.agent_intake = _load_agent_intake(REPO_ROOT)  # type: ignore[attr-defined]
    server.packs_dir = packs_dir  # type: ignore[attr-defined]
    server.base_url = base_url.rstrip("/")  # type: ignore[attr-defined]

    sys.stderr.write(f"AIP stub listening on {args.host}:{args.port}\n")
    sys.stderr.write(f"Packs dir: {packs_dir}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.stderr.write("Shutting down...\n")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
