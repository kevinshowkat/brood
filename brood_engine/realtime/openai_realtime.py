"""OpenAI Realtime API (WebSocket) client for background Canvas Context.

Hard requirement: realtime-capable models must ONLY be used via the Realtime API,
never via the Responses endpoint.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import mimetypes
import os
import queue
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from ..runs.events import EventWriter
from ..utils import sanitize_payload

_REALTIME_BETA_HEADER = ("OpenAI-Beta", "realtime=v1")
_SOURCE = "openai_realtime"

_STOP = object()


@dataclass(frozen=True)
class CanvasContextJob:
    image_path: str
    submitted_at_ms: int


class CanvasContextRealtimeSession:
    """Background OpenAI Realtime session that streams Canvas Context text."""

    def __init__(self, events: EventWriter) -> None:
        self._events = events
        self._model = (
            os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_MODEL") or os.getenv("OPENAI_CANVAS_CONTEXT_REALTIME_MODEL")
        )
        self._model = str(self._model or "").strip() or "gpt-realtime-mini"

        self._api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")
        self._disabled = os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_DISABLED") == "1"

        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._jobs: queue.Queue[object] = queue.Queue()
        self._fatal_error: str | None = None

    def start(self) -> tuple[bool, str | None]:
        if self._disabled:
            return False, "Realtime canvas context is disabled (BROOD_CANVAS_CONTEXT_REALTIME_DISABLED=1)."
        if not self._api_key:
            return False, "Missing OPENAI_API_KEY (or OPENAI_API_KEY_BACKUP)."
        try:
            import websockets  # noqa: F401
        except Exception:
            return False, "Missing dependency: websockets (pip install websockets)."

        with self._lock:
            if self._thread and self._thread.is_alive():
                return True, None
            self._fatal_error = None
            self._stop.clear()
            self._thread = threading.Thread(target=self._thread_main, name="brood-aov-realtime", daemon=True)
            self._thread.start()
        return True, None

    def stop(self, *, join_timeout_s: float = 2.0) -> None:
        with self._lock:
            thread = self._thread
            self._stop.set()
            self._jobs.put(_STOP)
        if thread:
            thread.join(timeout=max(0.0, float(join_timeout_s)))
        with self._lock:
            if self._thread and not self._thread.is_alive():
                self._thread = None

    def submit_snapshot(self, snapshot_path: Path) -> tuple[bool, str | None]:
        if self._disabled:
            return False, "Realtime canvas context is disabled (BROOD_CANVAS_CONTEXT_REALTIME_DISABLED=1)."
        if not snapshot_path.exists():
            return False, f"Snapshot not found: {snapshot_path}"
        with self._lock:
            if self._fatal_error:
                return False, self._fatal_error
            if not (self._thread and self._thread.is_alive()):
                return False, "Realtime session not started. Run /canvas_context_rt_start first."
        job = CanvasContextJob(image_path=str(snapshot_path), submitted_at_ms=int(time.time() * 1000))
        self._jobs.put(job)
        return True, None

    def _thread_main(self) -> None:
        try:
            asyncio.run(self._async_main())
        except Exception as exc:
            msg = f"Realtime session crashed: {exc}"
            self._set_fatal_error(msg)
            self._emit_failed(None, msg, fatal=True)

    async def _async_main(self) -> None:
        import websockets

        ws_url = _openai_realtime_ws_url(self._model)
        headers = [
            ("Authorization", f"Bearer {self._api_key}"),
            _REALTIME_BETA_HEADER,
        ]

        try:
            # websockets renamed `extra_headers` -> `additional_headers` (>=14). Avoid passing
            # an unknown kwarg because websockets forwards it to `loop.create_connection()`.
            connect_kwargs: dict[str, Any] = {"ping_interval": 20, "ping_timeout": 20}
            try:
                sig = inspect.signature(websockets.connect)
                if "additional_headers" in sig.parameters:
                    connect_kwargs["additional_headers"] = headers
                else:
                    connect_kwargs["extra_headers"] = headers
            except Exception:
                connect_kwargs["additional_headers"] = headers

            async with websockets.connect(ws_url, **connect_kwargs) as ws:
                await ws.send(
                    json.dumps(
                        {
                            "type": "session.update",
                            "session": {
                                "instructions": _canvas_context_instruction(),
                                # Realtime sessions use `modalities` (not `output_modalities`).
                                # Setting ["text"] disables audio outputs.
                                "modalities": ["text"],
                                # Temperature is clamped by the API; keep at the minimum for consistent context.
                                "temperature": 0.6,
                                "max_response_output_tokens": 520,
                            },
                        }
                    )
                )
                await self._job_loop(ws)
        except Exception as exc:
            msg = f"Realtime connection failed: {exc}"
            self._set_fatal_error(msg)
            self._emit_failed(None, msg, fatal=True)

    async def _job_loop(self, ws: Any) -> None:
        while not self._stop.is_set():
            job = await asyncio.to_thread(self._jobs.get)
            if job is _STOP:
                break
            if not isinstance(job, CanvasContextJob):
                continue

            # Latest-wins: if several snapshots queued up, keep only the last one.
            while True:
                try:
                    nxt = self._jobs.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP:
                    self._stop.set()
                    break
                if isinstance(nxt, CanvasContextJob):
                    job = nxt

            if self._stop.is_set():
                break
            await self._run_job(ws, job)

    async def _run_job(self, ws: Any, job: CanvasContextJob) -> None:
        data_url = _read_image_as_data_url(Path(job.image_path))
        await ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    "response": {
                        # Out-of-band: avoid growing conversation state inside the persistent session.
                        "conversation": "none",
                        "modalities": ["text"],
                        "input": [
                            {
                                "type": "message",
                                "role": "user",
                                "content": [{"type": "input_image", "image_url": data_url}],
                            }
                        ],
                        "max_output_tokens": 520,
                    },
                }
            )
        )

        buffer = ""
        response_id: str | None = None
        last_emit_s = 0.0
        started_s = time.monotonic()

        while not self._stop.is_set():
            if time.monotonic() - started_s > 42.0:
                msg = "Realtime canvas context timed out."
                self._set_fatal_error(msg)
                self._emit_failed(job.image_path, msg, fatal=True)
                self._stop.set()
                return

            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=0.5)
            except asyncio.TimeoutError:
                continue

            try:
                event = json.loads(raw)
            except Exception:
                continue

            event_type = event.get("type")
            if event_type == "error":
                msg = _format_realtime_error(event)
                self._set_fatal_error(msg)
                self._emit_failed(job.image_path, msg, fatal=True)
                self._stop.set()
                return

            if event_type == "response.created":
                resp = event.get("response")
                if isinstance(resp, dict) and isinstance(resp.get("id"), str):
                    response_id = resp["id"]
                continue

            if event_type == "response.output_text.delta":
                delta = event.get("delta") or event.get("text")
                if isinstance(delta, str) and delta:
                    buffer += delta
                now_s = time.monotonic()
                if buffer.strip() and now_s - last_emit_s >= 0.25:
                    last_emit_s = now_s
                    self._emit_canvas_context(job.image_path, buffer, partial=True)
                continue
            if event_type == "response.output_text.done":
                text = event.get("text") or event.get("output_text")
                if isinstance(text, str) and text:
                    buffer += text
                continue

            if event_type == "response.done":
                # Guard in case a previous response's done arrives late.
                resp = event.get("response")
                if response_id and isinstance(resp, dict) and isinstance(resp.get("id"), str):
                    if resp["id"] != response_id:
                        continue
                cleaned = buffer.strip()
                if not cleaned:
                    cleaned = _extract_realtime_output_text(resp)
                if not cleaned:
                    meta = _summarize_realtime_response(resp)
                    msg = f"Empty realtime canvas context response.{meta}"
                    self._emit_failed(job.image_path, msg, fatal=True)
                    self._set_fatal_error(msg)
                    self._stop.set()
                    return
                self._emit_canvas_context(job.image_path, cleaned, partial=False)
                return

    def _emit_canvas_context(self, image_path: str, text: str, *, partial: bool) -> None:
        payload: dict[str, Any] = {
            "image_path": image_path,
            "text": text,
            "source": _SOURCE,
            "model": self._model,
        }
        if partial:
            payload["partial"] = True
        self._events.emit("canvas_context", **payload)

    def _emit_failed(self, image_path: str | None, error: str, *, fatal: bool) -> None:
        payload: dict[str, Any] = {
            "image_path": image_path,
            "error": error,
            "source": _SOURCE,
            "model": self._model,
        }
        if fatal:
            payload["fatal"] = True
        self._events.emit("canvas_context_failed", **payload)

    def _set_fatal_error(self, message: str) -> None:
        with self._lock:
            self._fatal_error = str(message or "").strip() or "Unknown realtime error."


def _openai_api_base_url() -> str:
    """OpenAI base URL (no trailing slash), defaulting to the public API."""
    raw = os.getenv("OPENAI_API_BASE") or os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1"
    base = str(raw).strip().rstrip("/")
    try:
        parsed = urlparse(base)
        if parsed.scheme and parsed.netloc and parsed.path in {"", "/"}:
            base = f"{base}/v1"
    except Exception:
        pass
    return base.rstrip("/")


def _openai_realtime_ws_url(model: str) -> str:
    base = _openai_api_base_url()
    parsed = urlparse(base)
    scheme = parsed.scheme
    if scheme == "https":
        scheme = "wss"
    elif scheme == "http":
        scheme = "ws"
    path = (parsed.path or "").rstrip("/")
    ws_base = f"{scheme}://{parsed.netloc}{path}"
    return f"{ws_base}/realtime?model={quote(str(model or '').strip())}"


def _read_image_as_data_url(path: Path) -> str:
    data = path.read_bytes()
    mime, _ = mimetypes.guess_type(str(path))
    mime = mime or "image/jpeg"
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def _format_realtime_error(event: dict[str, Any]) -> str:
    err = event.get("error")
    if isinstance(err, dict):
        message = err.get("message")
        code = err.get("code")
        kind = err.get("type")
        parts = []
        if kind:
            parts.append(str(kind))
        if code:
            parts.append(str(code))
        prefix = " ".join(parts).strip()
        if isinstance(message, str) and message.strip():
            return f"{prefix}: {message.strip()}" if prefix else message.strip()
    return "Realtime API error."

def _extract_realtime_output_text(response: Any) -> str:
    """Best-effort extraction of assistant text from a Realtime `response` object."""
    if not isinstance(response, dict):
        return ""
    direct = response.get("output_text")
    if isinstance(direct, str) and direct.strip():
        return direct.strip()
    parts: list[str] = []
    out = response.get("output")
    if isinstance(out, list):
        for item in out:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("text"), str) and item.get("type") in {"output_text", "text"}:
                parts.append(str(item["text"]))
            if isinstance(item.get("refusal"), str) and str(item.get("refusal")).strip():
                parts.append(str(item["refusal"]))
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    if isinstance(part.get("text"), str) and part.get("type") in {"output_text", "text"}:
                        parts.append(str(part["text"]))
                    if isinstance(part.get("refusal"), str) and str(part.get("refusal")).strip():
                        parts.append(str(part["refusal"]))
    joined = "\n".join(p.strip() for p in parts if isinstance(p, str) and p.strip()).strip()
    if joined:
        return joined
    # Fallback: look for any text-ish fields in sanitized response.
    sanitized = sanitize_payload(response)
    if not isinstance(sanitized, dict):
        return ""
    for key in ("text", "message", "content"):
        val = sanitized.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _summarize_realtime_response(response: Any) -> str:
    if not isinstance(response, dict):
        return ""
    status = response.get("status")
    rid = response.get("id")
    reason = response.get("status_details")
    out = response.get("output")
    n_out = len(out) if isinstance(out, list) else 0
    bits: list[str] = []
    if isinstance(status, str) and status:
        bits.append(f"status={status}")
    if isinstance(rid, str) and rid:
        bits.append(f"id={rid}")
    if reason is not None:
        bits.append(f"details={sanitize_payload(reason)}")
    bits.append(f"output_items={n_out}")
    return f" ({', '.join(bits)})" if bits else ""


def _canvas_context_instruction() -> str:
    # Keep this text in sync with brood_engine/recreate/caption.py.
    return (
        "You are Brood's always-on background vision.\n"
        "Analyze the attached CANVAS SNAPSHOT (it may contain multiple photos arranged in a grid).\n"
        "Output compact, machine-readable notes we can use for future action recommendations.\n\n"
        "Format (keep under ~170 words):\n"
        "CANVAS:\n"
        "<one sentence summary>\n\n"
        "SUBJECTS:\n"
        "- <2-6 bullets>\n\n"
        "STYLE:\n"
        "- <3-7 short tags>\n\n"
        "NEXT ACTIONS:\n"
        "- <Action>: <why>  (max 5)\n\n"
        "Actions must be chosen from: Combine, Bridge, Swap DNA, Recast, Variations, Background: White, "
        "Background: Sweep, Crop: Square, Annotate.\n"
        "Rules: no fluff, no marketing language, be specific about composition, lighting, color, materials, "
        "and use case."
    )
