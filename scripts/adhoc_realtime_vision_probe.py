#!/usr/bin/env python3
"""Ad hoc realtime vision probe.

Sends a single image to OpenAI Realtime (`gpt-realtime-mini` by default) with
no extra prompt text and prints the returned text output.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import mimetypes
import os
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import websockets


def parse_dotenv(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    out: dict[str, str] = {}
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if len(value) >= 2 and (
            (value[0] == '"' and value[-1] == '"')
            or (value[0] == "'" and value[-1] == "'")
        ):
            value = value[1:-1]
        out[key] = value
    return out


def merged_env(repo_root: Path) -> dict[str, str]:
    env = dict(os.environ)
    home = Path.home()
    for dotenv in [home / ".brood" / ".env", repo_root / ".env"]:
        for key, value in parse_dotenv(dotenv).items():
            existing = env.get(key)
            if existing is None or (existing.strip() == "" and value.strip() != ""):
                env[key] = value
    return env


def openai_realtime_ws_url(api_base: str, model: str) -> str:
    parsed = urlparse(api_base.strip())
    if parsed.scheme not in {"http", "https", "ws", "wss"}:
        return f"wss://api.openai.com/v1/realtime?model={model}"

    if parsed.scheme in {"https", "wss"}:
        scheme = "wss"
    else:
        scheme = "ws"

    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1"
    path = f"{path}/realtime"

    query = f"model={model}"
    return urlunparse((scheme, parsed.netloc, path, "", query, ""))


def data_url_for_image(path: Path) -> str:
    mime, _ = mimetypes.guess_type(path.name)
    if not mime:
        mime = "application/octet-stream"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def merge_stream_text(existing: str, incoming: str) -> str:
    if not existing:
        return incoming
    if incoming.startswith(existing):
        return incoming
    if existing.startswith(incoming):
        return existing
    return existing + incoming


def extract_text_from_response(response: dict[str, Any]) -> str:
    parts: list[str] = []
    output = response.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if not isinstance(content, list):
                continue
            for piece in content:
                if not isinstance(piece, dict):
                    continue
                if piece.get("type") in {"output_text", "text"}:
                    text = piece.get("text")
                    if isinstance(text, str) and text.strip():
                        parts.append(text)
    return "".join(parts).strip()


async def run_once(
    image_path: Path,
    model: str,
    api_base: str,
    api_key: str,
    instruction: str,
) -> str:
    ws_url = openai_realtime_ws_url(api_base, model)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Beta": "realtime=v1",
    }
    content = []
    if instruction.strip():
        content.append({"type": "input_text", "text": instruction.strip()})
    content.append({"type": "input_image", "image_url": data_url_for_image(image_path)})
    request = {
        "type": "response.create",
        "response": {
            "conversation": "none",
            "modalities": ["text"],
            "input": [{"type": "message", "role": "user", "content": content}],
        },
    }

    buffer = ""
    async with websockets.connect(
        ws_url,
        additional_headers=headers,
        open_timeout=30,
        close_timeout=5,
        max_size=16 * 1024 * 1024,
    ) as ws:
        # Keep session defaults; no custom instructions.
        await ws.send(json.dumps({"type": "session.update", "session": {"modalities": ["text"]}}))
        await ws.send(json.dumps(request))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=60)
            event = json.loads(raw)
            event_type = str(event.get("type", ""))

            if event_type == "error":
                err = event.get("error")
                raise RuntimeError(json.dumps(err, ensure_ascii=False))

            if event_type == "response.output_text.delta":
                delta = event.get("delta") or event.get("text") or ""
                if isinstance(delta, str) and delta:
                    buffer = merge_stream_text(buffer, delta)
                continue

            if event_type == "response.output_text.done":
                text = event.get("text") or event.get("output_text") or ""
                if isinstance(text, str) and text:
                    buffer = merge_stream_text(buffer, text)
                continue

            if event_type == "response.done":
                response = event.get("response")
                if isinstance(response, dict):
                    extracted = extract_text_from_response(response)
                    if extracted:
                        buffer = merge_stream_text(buffer, extracted)
                return buffer.strip()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe gpt-realtime-mini image description output.")
    parser.add_argument("image", type=Path, help="Path to image file")
    parser.add_argument("--model", default="gpt-realtime-mini", help="Realtime model name")
    parser.add_argument(
        "--instruction",
        default=(
            "Describe the image in one plain sentence. "
            "Return only the description and nothing else."
        ),
        help="Instruction text sent with the image",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    image_path = args.image.expanduser().resolve()
    if not image_path.exists():
        print(f"Image not found: {image_path}")
        return 1

    repo_root = Path(__file__).resolve().parents[1]
    env = merged_env(repo_root)
    api_key = env.get("OPENAI_API_KEY") or env.get("OPENAI_API_KEY_BACKUP")
    if not api_key:
        print("Missing OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP) in env/.env.")
        return 1
    api_base = env.get("OPENAI_API_BASE", "https://api.openai.com/v1")

    try:
        text = asyncio.run(
            run_once(
                image_path=image_path,
                model=args.model,
                api_base=api_base,
                api_key=api_key,
                instruction=args.instruction,
            )
        )
    except Exception as exc:  # noqa: BLE001 - ad hoc script
        print(f"Realtime request failed: {exc}")
        return 2

    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
