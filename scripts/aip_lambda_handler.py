"""
AWS Lambda handler for the Agent Intake Protocol (AIP).

Designed to work behind a Lambda Function URL (or API Gateway HTTP API).

What it does:
- POST /aip/intake: returns curated entrypoints + optional pack URLs.
- GET  /aip/packs/<filename>: serves pack JSON from S3 (keeps S3 private).

Tracking:
- Emits structured JSON logs to CloudWatch for intake + pack fetches.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs

import boto3


S3 = boto3.client("s3")


def _now_s() -> int:
    return int(time.time())


def _json_response(status: int, payload: Any) -> dict[str, Any]:
    body = json.dumps(payload, indent=2, sort_keys=False) + "\n"
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            # If you enable CORS on the Function URL/API Gateway, these are optional.
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type,x-brood-opt-out",
        },
        "body": body,
    }


def _no_content() -> dict[str, Any]:
    return {
        "statusCode": 204,
        "headers": {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type,x-brood-opt-out",
        },
        "body": "",
    }


def _safe_pack_filename(name: str) -> str | None:
    if not name or "/" in name or "\\" in name:
        return None
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-@")
    if any(ch not in allowed for ch in name):
        return None
    return name


def _sha256_bytes(b: bytes) -> str:
    h = hashlib.sha256()
    h.update(b)
    return h.hexdigest()


def _load_s3_json(bucket: str, key: str) -> dict[str, Any] | None:
    try:
        obj = S3.get_object(Bucket=bucket, Key=key)
        raw = obj["Body"].read()
        return json.loads(raw.decode("utf-8"))
    except Exception:
        return None


@dataclass(frozen=True)
class _Config:
    bucket: str
    agent_intake_key: str
    packs_prefix: str
    # Optional override for pack URLs (otherwise use current request host).
    public_base_url: str | None


_CACHED_AGENT_INTAKE: dict[str, Any] | None = None
_CACHED_PACK_INDEX: dict[str, Any] | None = None
_CACHED_AT_S: int | None = None


def _get_config() -> _Config:
    bucket = os.environ.get("AIP_BUCKET", "").strip()
    if not bucket:
        raise RuntimeError("Missing env var AIP_BUCKET (S3 bucket for agent-intake.json and packs/).")
    agent_intake_key = os.environ.get("AGENT_INTAKE_KEY", "agent-intake.json").strip()
    packs_prefix = os.environ.get("PACKS_PREFIX", "packs/").strip()
    if packs_prefix and not packs_prefix.endswith("/"):
        packs_prefix += "/"
    public_base_url = os.environ.get("PUBLIC_BASE_URL", "").strip() or None
    return _Config(
        bucket=bucket,
        agent_intake_key=agent_intake_key,
        packs_prefix=packs_prefix,
        public_base_url=public_base_url,
    )


def _refresh_cache(cfg: _Config, *, max_age_s: int = 60) -> None:
    global _CACHED_AGENT_INTAKE, _CACHED_PACK_INDEX, _CACHED_AT_S
    now = _now_s()
    if _CACHED_AT_S is not None and now - _CACHED_AT_S < max_age_s:
        return
    _CACHED_AGENT_INTAKE = _load_s3_json(cfg.bucket, cfg.agent_intake_key) or {}
    _CACHED_PACK_INDEX = _load_s3_json(cfg.bucket, f"{cfg.packs_prefix}index.json") or {}
    _CACHED_AT_S = now


def _get_method(event: dict[str, Any]) -> str:
    return str(((event.get("requestContext") or {}).get("http") or {}).get("method") or "").upper()


def _get_path(event: dict[str, Any]) -> str:
    # HTTP API v2.0 event has rawPath; fall back to requestContext.http.path
    raw = event.get("rawPath")
    if isinstance(raw, str) and raw:
        return raw
    return str(((event.get("requestContext") or {}).get("http") or {}).get("path") or "")


def _get_header(event: dict[str, Any], name: str) -> str | None:
    headers = event.get("headers") or {}
    if not isinstance(headers, dict):
        return None
    # AWS may lower-case header names.
    for k in (name, name.lower()):
        v = headers.get(k)
        if isinstance(v, str) and v:
            return v
    return None


def _get_query_params(event: dict[str, Any]) -> dict[str, str]:
    q = event.get("queryStringParameters")
    if isinstance(q, dict):
        out: dict[str, str] = {}
        for k, v in q.items():
            if isinstance(k, str) and isinstance(v, str):
                out[k] = v
        return out
    raw = event.get("rawQueryString")
    if isinstance(raw, str) and raw:
        parsed = parse_qs(raw, keep_blank_values=False)
        return {k: v[0] for k, v in parsed.items() if v}
    return {}


def _get_base_url(event: dict[str, Any], cfg: _Config) -> str:
    if cfg.public_base_url:
        return cfg.public_base_url.rstrip("/")
    domain = str((event.get("requestContext") or {}).get("domainName") or "").strip()
    proto = _get_header(event, "x-forwarded-proto") or "https"
    if domain:
        return f"{proto}://{domain}"
    # Last resort: empty
    return ""


def _read_json_body(event: dict[str, Any]) -> dict[str, Any] | None:
    body = event.get("body")
    if not isinstance(body, str) or not body:
        return None
    if bool(event.get("isBase64Encoded")):
        try:
            body = base64.b64decode(body).decode("utf-8")
        except Exception:
            return None
    try:
        obj = json.loads(body)
    except Exception:
        return None
    if not isinstance(obj, dict):
        return None
    return obj


def lambda_handler(event: dict[str, Any], context: Any) -> dict[str, Any]:
    try:
        cfg = _get_config()
    except Exception as e:
        return _json_response(500, {"error": str(e)})

    method = _get_method(event)
    path = _get_path(event)

    if method == "OPTIONS":
        return _no_content()

    if method == "GET" and path == "/healthz":
        return _json_response(200, {"ok": True, "ts": _now_s()})

    # Serve packs (private S3; attribution via sid query param).
    if method == "GET" and path.startswith("/aip/packs/"):
        filename = path.split("/aip/packs/", 1)[1]
        filename = _safe_pack_filename(filename)
        if not filename:
            return _json_response(400, {"error": "invalid pack filename"})

        sid = _get_query_params(event).get("sid") or ""
        try:
            obj = S3.get_object(Bucket=cfg.bucket, Key=f"{cfg.packs_prefix}{filename}")
            data = obj["Body"].read()
            # Structured log for pack fetch.
            print(
                json.dumps(
                    {
                        "type": "aip_pack_get",
                        "ts": _now_s(),
                        "sid": sid,
                        "filename": filename,
                        "bytes": len(data),
                        "sha256": _sha256_bytes(data),
                    }
                )
            )
            return {
                "statusCode": 200,
                "headers": {
                    "content-type": "application/json; charset=utf-8",
                    "cache-control": "public, max-age=300",
                    "access-control-allow-origin": "*",
                },
                "body": data.decode("utf-8", errors="replace"),
            }
        except Exception:
            print(
                json.dumps(
                    {
                        "type": "aip_pack_get",
                        "ts": _now_s(),
                        "sid": sid,
                        "filename": filename,
                        "error": "not_found_or_access_denied",
                    }
                )
            )
            return _json_response(404, {"error": "pack not found"})

    if method != "POST" or path != "/aip/intake":
        return _json_response(404, {"error": "not found"})

    req = _read_json_body(event)
    if not req:
        return _json_response(400, {"error": "invalid json"})
    if req.get("schema_version") != "aip-1":
        return _json_response(400, {"error": "unsupported schema_version"})

    agent = req.get("agent") or {}
    task = req.get("task") or {}

    if not isinstance(agent, dict) or not agent.get("tool"):
        return _json_response(400, {"error": "missing agent.tool"})
    if not isinstance(task, dict):
        return _json_response(400, {"error": "missing task"})
    raw_tags = task.get("tags")
    if raw_tags is None:
        raw_tags = []
    if not isinstance(raw_tags, list) or not all(isinstance(t, str) for t in raw_tags):
        return _json_response(400, {"error": "task.tags[] must be an array of strings when provided"})
    tags: list[str] = []
    seen_tags: set[str] = set()
    for tag in raw_tags:
        clean = tag.strip()
        if not clean or clean in seen_tags:
            continue
        seen_tags.add(clean)
        tags.append(clean)
    tags = tags[:16]

    # Opt-out can be signaled either via request body or header.
    opt_out = False
    try:
        opt_out = bool((req.get("telemetry") or {}).get("opt_out"))
    except Exception:
        opt_out = False
    if (_get_header(event, "x-brood-opt-out") or "").strip() == "1":
        opt_out = True

    _refresh_cache(cfg)
    agent_intake = _CACHED_AGENT_INTAKE or {}
    pack_index = _CACHED_PACK_INDEX or {}

    tag_catalog = agent_intake.get("tag_catalog") or {}
    fallback = agent_intake.get("fallback_entrypoints") or []
    suggested_tags: list[str] = []
    intake_tags = agent_intake.get("tags") or []
    if isinstance(intake_tags, list):
        for tag in intake_tags:
            if not isinstance(tag, str):
                continue
            clean = tag.strip()
            if not clean or clean in suggested_tags:
                continue
            suggested_tags.append(clean)
    if not suggested_tags and isinstance(tag_catalog, dict):
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

    def add_entry(path: str, why: str, *, priority: int = 3, kind: str | None = None) -> None:
        if not path:
            return
        entrypoints.append(
            {
                "path": path,
                "why": why,
                "kind": kind or "source",
                "priority": priority,
            }
        )

    # Tag-specific entrypoints.
    if isinstance(tag_catalog, dict):
        for tag in tags[:16]:
            info = tag_catalog.get(tag) if isinstance(tag, str) else None
            if not isinstance(info, dict):
                continue
            desc = str(info.get("description") or "").strip()
            for p in info.get("entrypoints") or []:
                if isinstance(p, str) and p:
                    add_entry(p, f"{tag}: {desc}" if desc else tag, priority=1)
            if isinstance(tag, str) and tag.startswith("desktop"):
                commands.append("./scripts/dev_desktop.sh")
            if isinstance(tag, str) and (tag.startswith("engine") or tag == "tests"):
                commands.append("cd rust_engine && cargo test")
            if isinstance(tag, str) and tag == "tests":
                commands.append("cd desktop && npm test")

    # Fallback entrypoints.
    if isinstance(fallback, list):
        for ep in fallback:
            if not isinstance(ep, dict):
                continue
            p = ep.get("path")
            if not isinstance(p, str) or not p:
                continue
            add_entry(
                p,
                str(ep.get("why") or "Recommended repo entrypoint."),
                priority=int(ep.get("priority") or 5),
                kind=str(ep.get("kind") or "source"),
            )

    # De-dupe entrypoints by path (keep first).
    seen_paths: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for ep in entrypoints:
        p = ep.get("path")
        if not isinstance(p, str) or p in seen_paths:
            continue
        seen_paths.add(p)
        deduped.append(ep)
    entrypoints = deduped[:64]
    commands = list(dict.fromkeys(commands))[:32]

    sid = "sess_" + secrets.token_urlsafe(12)
    base_url = _get_base_url(event, cfg)

    # Offer packs if present in packs/index.json (generated by scripts/aip_build_packs.py).
    pack_items = pack_index.get("packs")
    if isinstance(pack_items, list) and base_url:
        by_id: dict[str, dict[str, Any]] = {}
        for item in pack_items:
            if not isinstance(item, dict):
                continue
            pid = item.get("id")
            if isinstance(pid, str) and pid:
                by_id[pid] = item
        for tag in tags[:16]:
            if not isinstance(tag, str):
                continue
            item = by_id.get(tag)
            if not item:
                continue
            filename = item.get("filename")
            if not isinstance(filename, str) or not _safe_pack_filename(filename):
                continue
            packs.append(
                {
                    "id": tag,
                    "url": f"{base_url}/aip/packs/{filename}?sid={sid}",
                    "sha256": item.get("sha256"),
                    "bytes": item.get("bytes"),
                    "purpose": f"Context pack for tag '{tag}'",
                }
            )

    resp: dict[str, Any] = {
        "schema_version": "aip-1",
        "session": {"id": sid},
        "entrypoints": entrypoints,
        "suggested_tags": suggested_tags,
    }
    if commands:
        resp["commands"] = commands
    if packs:
        resp["packs"] = packs[:16]
    notes = [
        "If outbound HTTPS is unavailable, follow llms.txt fallback entrypoints.",
        "This endpoint should avoid storing raw prompts/secrets; prefer coarse task tags.",
    ]
    if not tags:
        notes.insert(
            0,
            "No task.tags[] were provided; returned fallback entrypoints. Use suggested_tags to narrow a follow-up intake call.",
        )
    resp["notes"] = notes

    # Structured log for intake.
    if opt_out:
        print(json.dumps({"type": "aip_intake", "ts": _now_s(), "sid": sid, "opt_out": True}))
    else:
        print(
            json.dumps(
                {
                    "type": "aip_intake",
                    "ts": _now_s(),
                    "sid": sid,
                    "agent_tool": agent.get("tool"),
                    "agent_version": agent.get("tool_version"),
                    "tags": tags[:16],
                    "repo_ref": (req.get("repo") or {}).get("ref"),
                    "packs_issued": [p.get("id") for p in packs],
                }
            )
        )

    return _json_response(200, resp)
