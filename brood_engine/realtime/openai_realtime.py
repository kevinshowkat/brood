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
import re
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
_REALTIME_MODEL_ALIASES = {
    # Keep compatibility with shorthand names used in local env files.
    "realtime-gpt": "gpt-realtime",
}

_STOP = object()
_CANVAS_CONTEXT_MAX_OUTPUT_TOKENS = 520
_INTENT_ICONS_MAX_OUTPUT_TOKENS = 2200
_ACTION_VERSION_RE = re.compile(r"(?:^|[-_])a(?P<value>\d+)(?:[-_.]|$)")


@dataclass(frozen=True)
class CanvasContextJob:
    image_path: str
    submitted_at_ms: int


def _normalize_realtime_model_name(raw: str | None, *, default: str) -> str:
    model = str(raw or "").strip()
    if not model:
        return default
    return _REALTIME_MODEL_ALIASES.get(model, model)


def _resolve_realtime_model(env_keys: tuple[str, ...], *, default: str) -> str:
    for key in env_keys:
        value = str(os.getenv(key) or "").strip()
        if value:
            return _normalize_realtime_model_name(value, default=default)
    return default


def _is_mother_intent_snapshot_path(image_path: str) -> bool:
    name = Path(str(image_path or "")).name.lower()
    return name.startswith("mother-intent-")


class _BaseRealtimeSnapshotSession:
    """Shared OpenAI Realtime session runner for snapshot-driven background tasks."""

    def __init__(
        self,
        events: EventWriter,
        *,
        model: str,
        disabled: bool,
        thread_name: str,
    ) -> None:
        self._events = events
        self._model = model
        self._disabled = bool(disabled)
        self._thread_name = str(thread_name or "brood-realtime")
        self._api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")

        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._jobs: queue.Queue[object] = queue.Queue()
        self._fatal_error: str | None = None

    def start(self) -> tuple[bool, str | None]:
        if self._disabled:
            return False, self._disabled_message()
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
            self._thread = threading.Thread(target=self._thread_main, name=self._thread_name, daemon=True)
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
            return False, self._disabled_message()
        if not snapshot_path.exists():
            return False, f"Snapshot not found: {snapshot_path}"
        with self._lock:
            fatal = self._fatal_error
            alive = bool(self._thread and self._thread.is_alive())
        if fatal:
            return False, fatal
        if not alive:
            ok, err = self.start()
            if not ok:
                return False, err
            with self._lock:
                if self._fatal_error:
                    return False, self._fatal_error
        job = CanvasContextJob(image_path=str(snapshot_path), submitted_at_ms=int(time.time() * 1000))
        self._jobs.put(job)
        return True, None

    def _disabled_message(self) -> str:
        raise NotImplementedError

    def _instruction(self) -> str:
        raise NotImplementedError

    def _max_output_tokens(self) -> int:
        raise NotImplementedError

    def _timeout_message(self) -> str:
        raise NotImplementedError

    def _empty_response_message(self, response: Any) -> str:
        raise NotImplementedError

    def _emit_stream_payload(
        self,
        image_path: str,
        text: str,
        *,
        partial: bool,
        response_meta: dict[str, Any] | None = None,
    ) -> None:
        raise NotImplementedError

    def _emit_failed(self, image_path: str | None, error: str, *, fatal: bool) -> None:
        raise NotImplementedError

    def _select_job(self, jobs: list[CanvasContextJob]) -> CanvasContextJob:
        # Default queue policy: latest-wins.
        return jobs[-1]

    def _set_fatal_error(self, message: str) -> None:
        with self._lock:
            self._fatal_error = str(message or "").strip() or "Unknown realtime error."

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
                                "instructions": self._instruction(),
                                "modalities": ["text"],
                                # JSON/text-only: keep temperature at API minimum for stability.
                                "temperature": 0.6,
                                "max_response_output_tokens": self._max_output_tokens(),
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
            item = await asyncio.to_thread(self._jobs.get)
            if item is _STOP:
                break
            if not isinstance(item, CanvasContextJob):
                continue

            jobs: list[CanvasContextJob] = [item]
            while True:
                try:
                    nxt = self._jobs.get_nowait()
                except queue.Empty:
                    break
                if nxt is _STOP:
                    self._stop.set()
                    break
                if isinstance(nxt, CanvasContextJob):
                    jobs.append(nxt)

            if self._stop.is_set():
                break
            await self._run_job(ws, self._select_job(jobs))

    async def _run_job(self, ws: Any, job: CanvasContextJob) -> None:
        data_url = _read_image_as_data_url(Path(job.image_path))
        context_text = _read_canvas_context_envelope(Path(job.image_path))
        content: list[dict[str, Any]] = []
        if context_text:
            content.append({"type": "input_text", "text": context_text})
        content.append({"type": "input_image", "image_url": data_url})
        await ws.send(
            json.dumps(
                {
                    "type": "response.create",
                    "response": {
                        # Out-of-band to avoid growing conversation state in a persistent session.
                        "conversation": "none",
                        "modalities": ["text"],
                        "input": [
                            {
                                "type": "message",
                                "role": "user",
                                "content": content,
                            }
                        ],
                        "max_output_tokens": self._max_output_tokens(),
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
                msg = self._timeout_message()
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
                    buffer = _append_stream_delta(buffer, delta)
                now_s = time.monotonic()
                if buffer.strip() and now_s - last_emit_s >= 0.25:
                    last_emit_s = now_s
                    self._emit_stream_payload(job.image_path, buffer, partial=True)
                continue
            if event_type == "response.output_text.done":
                text = event.get("text") or event.get("output_text")
                if isinstance(text, str) and text:
                    buffer = _merge_stream_text(buffer, text)
                continue

            if event_type == "response.done":
                resp = event.get("response")
                if response_id and isinstance(resp, dict) and isinstance(resp.get("id"), str):
                    if resp["id"] != response_id:
                        continue
                cleaned, response_meta = _resolve_streamed_response_text(buffer, resp)
                if not cleaned:
                    msg = self._empty_response_message(resp)
                    self._emit_failed(job.image_path, msg, fatal=True)
                    self._set_fatal_error(msg)
                    self._stop.set()
                    return
                self._emit_stream_payload(job.image_path, cleaned, partial=False, response_meta=response_meta)
                return


class CanvasContextRealtimeSession(_BaseRealtimeSnapshotSession):
    """Background OpenAI Realtime session that streams Canvas Context text."""

    def __init__(self, events: EventWriter) -> None:
        model = _resolve_realtime_model(
            ("BROOD_CANVAS_CONTEXT_REALTIME_MODEL", "OPENAI_CANVAS_CONTEXT_REALTIME_MODEL"),
            default="gpt-realtime-mini",
        )
        super().__init__(
            events,
            model=model,
            disabled=os.getenv("BROOD_CANVAS_CONTEXT_REALTIME_DISABLED") == "1",
            thread_name="brood-aov-realtime",
        )

    def _disabled_message(self) -> str:
        return "Realtime canvas context is disabled (BROOD_CANVAS_CONTEXT_REALTIME_DISABLED=1)."

    def _instruction(self) -> str:
        return _canvas_context_instruction()

    def _max_output_tokens(self) -> int:
        return _CANVAS_CONTEXT_MAX_OUTPUT_TOKENS

    def _timeout_message(self) -> str:
        return "Realtime canvas context timed out."

    def _empty_response_message(self, response: Any) -> str:
        meta = _summarize_realtime_response(response)
        return f"Empty realtime canvas context response.{meta}"

    def _emit_stream_payload(
        self,
        image_path: str,
        text: str,
        *,
        partial: bool,
        response_meta: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "image_path": image_path,
            "text": text,
            "source": _SOURCE,
            "model": self._model,
        }
        if partial:
            payload["partial"] = True
        if response_meta:
            payload.update(response_meta)
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


class IntentIconsRealtimeSession(_BaseRealtimeSnapshotSession):
    """Background OpenAI Realtime session that streams intent-icon JSON for the spatial canvas."""

    def __init__(
        self,
        events: EventWriter,
        *,
        model: str | None = None,
        model_env_keys: tuple[str, ...] = ("BROOD_INTENT_REALTIME_MODEL", "OPENAI_INTENT_REALTIME_MODEL"),
        default_model: str = "gpt-realtime-mini",
        instruction_scope: str = "default",
    ) -> None:
        resolved_model = (
            _normalize_realtime_model_name(model, default=default_model)
            if model is not None
            else _resolve_realtime_model(model_env_keys, default=default_model)
        )
        super().__init__(
            events,
            model=resolved_model,
            disabled=os.getenv("BROOD_INTENT_REALTIME_DISABLED") == "1",
            thread_name="brood-intent-realtime",
        )
        scope = str(instruction_scope or "").strip().lower()
        self._instruction_scope = "mother" if scope == "mother" else "default"

    def _disabled_message(self) -> str:
        return "Realtime intent inference is disabled (BROOD_INTENT_REALTIME_DISABLED=1)."

    def _instruction(self) -> str:
        if self._instruction_scope == "mother":
            return _intent_icons_instruction_mother()
        return _intent_icons_instruction()

    def _max_output_tokens(self) -> int:
        return _INTENT_ICONS_MAX_OUTPUT_TOKENS

    def _timeout_message(self) -> str:
        return "Realtime intent inference timed out."

    def _empty_response_message(self, response: Any) -> str:
        meta = _summarize_realtime_response(response)
        return f"Empty realtime intent inference response.{meta}"

    def _select_job(self, jobs: list[CanvasContextJob]) -> CanvasContextJob:
        # Latest-wins, but prefer mother proposal snapshots when mixed with ambient traffic.
        latest_job = jobs[-1]
        latest_mother_job: CanvasContextJob | None = None
        for job in jobs:
            if _is_mother_intent_snapshot_path(job.image_path):
                latest_mother_job = job
        return latest_mother_job or latest_job

    def _emit_stream_payload(
        self,
        image_path: str,
        text: str,
        *,
        partial: bool,
        response_meta: dict[str, Any] | None = None,
    ) -> None:
        payload: dict[str, Any] = {
            "image_path": image_path,
            "text": text,
            "source": _SOURCE,
            "model": self._model,
        }
        payload.update(_intent_snapshot_metadata(image_path))
        if partial:
            payload["partial"] = True
        if response_meta:
            payload.update(response_meta)
        self._events.emit("intent_icons", **payload)

    def _emit_failed(self, image_path: str | None, error: str, *, fatal: bool) -> None:
        payload: dict[str, Any] = {
            "image_path": image_path,
            "error": error,
            "source": _SOURCE,
            "model": self._model,
        }
        if image_path:
            payload.update(_intent_snapshot_metadata(image_path))
        if fatal:
            payload["fatal"] = True
        self._events.emit("intent_icons_failed", **payload)


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


def _merge_stream_text(buffer: str, incoming: str) -> str:
    """Merge potentially overlapping streamed text snapshots."""
    left = str(buffer or "")
    right = str(incoming or "")
    if not right:
        return left
    if not left:
        return right
    # `response.output_text.done` / `response.done` may include a full snapshot.
    if right.startswith(left):
        return right
    max_overlap = min(len(left), len(right))
    for size in range(max_overlap, 0, -1):
        if left.endswith(right[:size]):
            # Treat full overlap as new content when appending deltas; true
            # duplicate suppression for full snapshots is handled above.
            if size == len(right):
                break
            return left + right[size:]
    return left + right


def _append_stream_delta(buffer: str, incoming: str) -> str:
    """Append delta chunks verbatim; repeated tokens are valid output."""
    left = str(buffer or "")
    right = str(incoming or "")
    if not right:
        return left
    return left + right


def _response_status_reason(response: Any) -> str | None:
    if not isinstance(response, dict):
        return None
    details = response.get("status_details")
    if isinstance(details, dict):
        for key in ("reason", "type", "code", "message"):
            value = details.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return json.dumps(sanitize_payload(details), ensure_ascii=False)
    if isinstance(details, str) and details.strip():
        return details.strip()
    return None


def _response_looks_truncated(status: str | None, reason: str | None, text: str) -> bool:
    status_norm = str(status or "").strip().lower()
    reason_norm = str(reason or "").strip().lower()
    if status_norm in {"incomplete", "truncated"}:
        return True
    if "max_output_tokens" in reason_norm or "max_output" in reason_norm:
        return True
    body = str(text or "").strip()
    if not body:
        return False
    if (body.startswith("{") or body.startswith("[")) and not (body.endswith("}") or body.endswith("]")):
        return True
    return False


def _resolve_streamed_response_text(buffer: str, response: Any) -> tuple[str, dict[str, Any]]:
    buffered = str(buffer or "").strip()
    extracted = _extract_realtime_output_text(response).strip()
    if buffered and extracted:
        cleaned = _merge_stream_text(buffered, extracted).strip()
    else:
        cleaned = extracted or buffered
    meta: dict[str, Any] = {}
    if isinstance(response, dict):
        rid = response.get("id")
        status = response.get("status")
        reason = _response_status_reason(response)
        if isinstance(rid, str) and rid:
            meta["response_id"] = rid
        if isinstance(status, str) and status.strip():
            meta["response_status"] = status.strip()
        if reason:
            meta["response_status_reason"] = reason
        if _response_looks_truncated(status if isinstance(status, str) else None, reason, cleaned):
            meta["response_truncated"] = True
    return cleaned, meta


def _extract_action_version(raw: str | None) -> int | None:
    text = str(raw or "").strip()
    if not text:
        return None
    match = _ACTION_VERSION_RE.search(text)
    if not match:
        return None
    try:
        return int(match.group("value"))
    except Exception:
        return None


def _intent_snapshot_metadata(image_path: str) -> dict[str, Any]:
    path_text = str(image_path or "").strip()
    if not path_text:
        return {}
    path = Path(path_text)
    out: dict[str, Any] = {}
    if _is_mother_intent_snapshot_path(path_text):
        out["intent_scope"] = "mother"
    elif path.name.lower().startswith("intent-ambient-"):
        out["intent_scope"] = "ambient"

    frame_id: str | None = None
    action_version = _extract_action_version(path.name)

    sidecar = path.with_suffix(".ctx.json")
    if sidecar.exists():
        try:
            data = json.loads(sidecar.read_text(encoding="utf-8", errors="ignore"))
            raw_frame_id = data.get("frame_id") if isinstance(data, dict) else None
            if isinstance(raw_frame_id, str) and raw_frame_id.strip():
                frame_id = raw_frame_id.strip()
                action_version = _extract_action_version(frame_id) or action_version
        except Exception:
            pass

    if frame_id:
        out["frame_id"] = frame_id
    if isinstance(action_version, int):
        out["action_version"] = action_version
    return out


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
        "You may also receive a CONTEXT ENVELOPE (JSON) describing the current UI state, available actions,\n"
        "and recent timeline. Use it to ground NEXT ACTIONS and avoid recommending unavailable abilities.\n"
        "Output compact, machine-readable notes we can use for future action recommendations.\n\n"
        "Format (keep under ~210 words):\n"
        "CANVAS:\n"
        "<one sentence summary>\n\n"
        "USE CASE (guess):\n"
        "<one short line: what the user is likely trying to do (e.g., product listing, ad creative, editorial still, UI screenshot, moodboard)>\n\n"
        "SUBJECTS:\n"
        "- <2-6 bullets>\n\n"
        "STYLE:\n"
        "- <3-7 short tags>\n\n"
        "NEXT ACTIONS:\n"
        "- <Action>: <why>  (max 5)\n\n"
        "Actions must be chosen from CONTEXT_ENVELOPE_JSON.abilities[].label (prefer enabled=true).\n"
        "If CONTEXT_ENVELOPE_JSON is missing, choose from: Multi view, Single view, Combine, Bridge, Swap DNA, "
        "Argue, Extract the Rule, Odd One Out, Triforce, Diagnose, Recast, Variations, Background: White, "
        "Background: Sweep, Crop: Square, Annotate.\n"
        "Rules: infer the use case from both the image and CONTEXT_ENVELOPE_JSON.timeline_recent (edits). "
        "No fluff, no marketing language. Be specific about composition, lighting, color, materials. "
        "NEXT ACTIONS should serve the hypothesized use case."
    )


def _intent_icons_instruction() -> str:
    # JSON-only contract for the onboarding "Intent Canvas".
    return (
        "You are a realtime Canvas-to-Intent Icon Engine.\n\n"
        "ROLE\n"
        "Observe a live visual canvas where users place images.\n"
        "Your job is NOT to explain intent, guess motivation, or ask questions.\n"
        "Your job is to surface the user's intent as a set of clear, human-legible ICONS for image generation.\n\n"
        "HARD CONSTRAINTS\n"
        "- Output JSON only. No prose. No user-facing text.\n"
        "- The JSON must be syntactically valid (single top-level object).\n"
        "- Communicate intent exclusively through icons, spatial grouping, highlights, and branching lanes.\n"
        "- Never infer or expose \"why\".\n"
        "- If uncertain, present multiple icon paths rather than choosing one.\n\n"
        "INPUT SIGNALS\n"
        "You receive:\n"
        "- A CANVAS SNAPSHOT image (may contain multiple user images placed spatially).\n"
        "- An optional CONTEXT_ENVELOPE_JSON (input text) that is authoritative for:\n"
        "  - canvas size\n"
        "  - per-image positions/sizes/order\n"
        "  - per-image vision_desc labels (optional): short, noisy phrases derived from the images (not user text)\n"
        "  - intent round index and remaining time (timer_enabled/rounds_enabled may be false)\n"
        "  - prior user selections (YES/NO/MAYBE) by branch\n\n"
        "INTERPRETATION RULES\n"
        "- Treat images as signals of intent, not meaning.\n"
        "- If vision_desc labels are present in CONTEXT_ENVELOPE_JSON.images[], treat them as weak hints only.\n"
        "- Placement implies structure:\n"
        "  - Left-to-right = flow\n"
        "  - Top-to-bottom = hierarchy\n"
        "  - Clusters = coupling\n"
        "  - Isolation = emphasis\n"
        "  - Relative size = emphasis/importance\n\n"
        "OUTPUT GOAL\n"
        "Continuously emit a minimal, evolving set of INTENT ICONS that describe:\n"
        "1) WHAT kind of system/action the user is assembling\n"
        "2) HOW they are choosing to act on that system\n\n"
        "ICON TAXONOMY (STRICT)\n"
        "Use only these icon_id values:\n\n"
        "Core\n"
        "- IMAGE_GENERATION\n"
        "- OUTPUTS\n"
        "- ITERATION\n"
        "- PIPELINE\n\n"
        "Use Cases (branch lanes)\n"
        "- GAME_DEV_ASSETS\n"
        "- STREAMING_CONTENT\n"
        "- UI_UX_PROTOTYPING\n"
        "- ECOMMERCE_POD\n"
        "- CONTENT_ENGINE\n\n"
        "Asset Types\n"
        "- CONCEPT_ART\n"
        "- SPRITES\n"
        "- TEXTURES\n"
        "- CHARACTER_SHEETS\n"
        "- THUMBNAILS\n"
        "- OVERLAYS\n"
        "- EMOTES\n"
        "- SOCIAL_GRAPHICS\n"
        "- SCREENS\n"
        "- WIREFRAMES\n"
        "- MOCKUPS\n"
        "- USER_FLOWS\n"
        "- MERCH_DESIGN\n"
        "- PRODUCT_PHOTOS\n"
        "- MARKETPLACE_LISTINGS\n"
        "- BRAND_SYSTEM\n"
        "- MULTI_CHANNEL\n\n"
        "Signatures\n"
        "- MIXED_FIDELITY\n"
        "- VOLUME\n"
        "- OUTCOMES\n"
        "- STRUCTURED\n"
        "- SINGULAR\n"
        "- PHYSICAL_OUTPUT\n"
        "- PROCESS\n"
        "- AUTOMATION\n\n"
        "Relations\n"
        "- FLOW\n"
        "- DEPENDENCY\n"
        "- FEEDBACK\n\n"
        "Checkpoints\n"
        "- YES_TOKEN\n"
        "- NO_TOKEN\n"
        "- MAYBE_TOKEN\n\n"
        "BRANCH IDS (PREFERRED)\n"
        "- game_dev_assets\n"
        "- streaming_content\n"
        "- uiux_prototyping\n"
        "- ecommerce_pod\n"
        "- content_engine\n\n"
        "TRANSFORMATION MODES (FOR MOTHER PROPOSALS)\n"
        "Choose exactly one primary mode from this enum:\n"
        "- amplify: Push the current composition into a cinematic crescendo.\n"
        "- transcend: Lift the scene into a more transcendent visual world.\n"
        "- destabilize: Shift the composition toward controlled visual instability.\n"
        "- purify: Simplify geometry and light into a calm sculptural image.\n"
        "- hybridize: Fuse the current references into one coherent composition.\n"
        "- mythologize: Recast the scene as mythic visual storytelling.\n"
        "- monumentalize: Turn the scene into a monumental hero composition.\n"
        "- fracture: Introduce intentional fracture and expressive disruption.\n"
        "- romanticize: Infuse the composition with intimate emotional warmth.\n"
        "- alienate: Reframe the scene with uncanny, otherworldly distance.\n"
        "Also provide 1-3 ranked alternatives with confidences.\n\n"
        "OUTPUT FORMAT (STRICT JSON)\n"
        "{\n"
        "  \"frame_id\": \"<input frame id>\",\n"
        "  \"schema\": \"brood.intent_icons\",\n"
        "  \"schema_version\": 1,\n"
        "  \"transformation_mode\": \"<one mode from enum>\",\n"
        "  \"transformation_mode_candidates\": [\n"
        "    {\n"
        "      \"mode\": \"<one mode from enum>\",\n"
        "      \"confidence\": 0.0\n"
        "    }\n"
        "  ],\n"
        "  \"image_descriptions\": [\n"
        "    {\n"
        "      \"image_id\": \"<from CONTEXT_ENVELOPE_JSON.images[].id>\",\n"
        "      \"label\": \"<3-6 words, <=32 chars>\",\n"
        "      \"confidence\": 0.0\n"
        "    }\n"
        "  ],\n"
        "  \"intent_icons\": [\n"
        "    {\n"
        "      \"icon_id\": \"<from taxonomy>\",\n"
        "      \"confidence\": 0.0,\n"
        "      \"position_hint\": \"primary\"\n"
        "    }\n"
        "  ],\n"
        "  \"relations\": [\n"
        "    {\n"
        "      \"from_icon\": \"<icon_id>\",\n"
        "      \"to_icon\": \"<icon_id>\",\n"
        "      \"relation_type\": \"FLOW\"\n"
        "    }\n"
        "  ],\n"
        "  \"branches\": [\n"
        "    {\n"
        "      \"branch_id\": \"<id>\",\n"
        "      \"confidence\": 0.0,\n"
        "      \"icons\": [\"GAME_DEV_ASSETS\", \"SPRITES\", \"ITERATION\"],\n"
        "      \"lane_position\": \"left\",\n"
        "      \"evidence_image_ids\": [\"<image_id>\"]\n"
        "    }\n"
        "  ],\n"
        "  \"checkpoint\": {\n"
        "    \"icons\": [\"YES_TOKEN\", \"NO_TOKEN\", \"MAYBE_TOKEN\"],\n"
        "    \"applies_to\": \"<branch_id or icon cluster>\"\n"
        "  }\n"
        "}\n\n"
        "BEHAVIOR RULES\n"
        "- Always maintain one primary intent cluster and 1-3 alternative clusters.\n"
        "- Always try to fill image_descriptions for each image in CONTEXT_ENVELOPE_JSON.images[].\n"
        "- transformation_mode must be one of the 10 enum values above.\n"
        "- transformation_mode_candidates should include the primary mode and be sorted by confidence DESC.\n"
        "- Include branches[].confidence in [0.0, 1.0] and sort branches by confidence DESC.\n"
        "- checkpoint.applies_to should match the highest-confidence branch_id.\n"
        "- evidence_image_ids should reference CONTEXT_ENVELOPE_JSON.images[].id (0-3 ids).\n"
        "- image_descriptions labels are internal diagnostics: short, neutral nouns/phrases; do not copy visible text; avoid brand names.\n"
        "- Do not collapse ambiguity too early.\n"
        "- Start broad with use-case lanes; add Asset Types and Signatures as evidence accumulates.\n"
        "- Increase specificity only after YES_TOKEN is applied.\n"
        "- After NO_TOKEN, deprioritize that branch and propose another alternative.\n"
        "- The icons must be understandable without explanation, language, or onboarding.\n\n"
        "SAFETY\n"
        "- Do not emit intent icons for illegal or deceptive systems.\n"
        "- Do not produce impersonation or identity abuse flows.\n"
        "- Keep all intent representations general-purpose and constructive.\n\n"
        "Return JSON only."
    )


def _intent_icons_instruction_mother() -> str:
    return (
        "MODE\n"
        "You are in Mother proposal mode for Brood.\n"
        "Optimization target: stunningly awe-inspiring and joyous + novel.\n"
        "You must maximize visual wow while preserving coherence and subject identity.\n\n"
        "MOTHER CONTEXT RULES\n"
        "- CONTEXT_ENVELOPE_JSON.mother_context is authoritative when present.\n"
        "- Treat mother_context.creative_directive and mother_context.optimization_target as hard steering.\n"
        "- Prefer transformation modes that are novel relative to mother_context.recent_rejected_modes_for_context.\n"
        "- Avoid repeating mother_context.last_accepted_mode unless confidence improvement is substantial.\n"
        "- Use mother_context.selected_ids and mother_context.active_id to prioritize evidence_image_ids.\n"
        "- Use images[].origin to balance uploaded references with mother-generated continuity.\n"
        "- For 2+ images, prefer coherent fusion over collage and preserve a single camera/lighting world.\n"
        "- Keep anti-artifact behavior conservative: avoid ghosting, duplication, and interface residue.\n\n"
        "Return the same strict JSON schema contract as the default intent engine.\n\n"
        f"{_intent_icons_instruction()}"
    )


def _read_canvas_context_envelope(image_path: Path) -> str:
    """Read a per-snapshot context envelope written by the desktop (best-effort)."""
    try:
        sidecar = image_path.with_suffix(".ctx.json")
    except Exception:
        sidecar = None
    if not sidecar or not sidecar.exists():
        return ""
    try:
        raw = sidecar.read_text(encoding="utf-8", errors="ignore").strip()
    except Exception:
        return ""
    if not raw:
        return ""
    # Guard against accidental large payloads.
    if len(raw) > 12_000:
        raw = raw[:11_800].rstrip() + "..."
    return f"CONTEXT_ENVELOPE_JSON:\n{raw}"
