"""Gemini 3 Flash client for background Canvas Context.

This is the non-streaming alternative to OpenAI Realtime for the desktop
"always-on vision" feature. Each snapshot is processed as a single-turn request
to keep the background loop stateless.
"""

from __future__ import annotations

import mimetypes
import os
import queue
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..runs.events import EventWriter

_SOURCE = "gemini_flash"
_DEFAULT_MODEL = "gemini-3-flash-preview"

_STOP = object()


@dataclass(frozen=True)
class CanvasContextJob:
    image_path: str
    submitted_at_ms: int


class CanvasContextGeminiFlashSession:
    """Background Gemini session that computes Canvas Context for snapshots."""

    def __init__(self, events: EventWriter) -> None:
        self._events = events
        self._model = str(os.getenv("BROOD_CANVAS_CONTEXT_GEMINI_MODEL") or "").strip() or _DEFAULT_MODEL

        self._api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
        self._disabled = os.getenv("BROOD_CANVAS_CONTEXT_GEMINI_DISABLED") == "1"

        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self._jobs: queue.Queue[object] = queue.Queue()
        self._fatal_error: str | None = None

    def start(self) -> tuple[bool, str | None]:
        if self._disabled:
            return False, "Gemini canvas context is disabled (BROOD_CANVAS_CONTEXT_GEMINI_DISABLED=1)."
        if not self._api_key:
            return False, "Missing GEMINI_API_KEY (or GOOGLE_API_KEY)."
        try:
            from google import genai  # noqa: F401  # type: ignore
            from google.genai import types  # noqa: F401  # type: ignore
        except Exception:
            return False, "Missing dependency: google-genai (pip install google-genai)."

        with self._lock:
            if self._thread and self._thread.is_alive():
                return True, None
            self._fatal_error = None
            self._stop.clear()
            self._thread = threading.Thread(target=self._thread_main, name="brood-aov-gemini", daemon=True)
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
            return False, "Gemini canvas context is disabled (BROOD_CANVAS_CONTEXT_GEMINI_DISABLED=1)."
        if not snapshot_path.exists():
            return False, f"Snapshot not found: {snapshot_path}"
        with self._lock:
            if self._fatal_error:
                return False, self._fatal_error
            if not (self._thread and self._thread.is_alive()):
                return False, "Gemini session not started. Run /canvas_context_gemini_start first."
        job = CanvasContextJob(image_path=str(snapshot_path), submitted_at_ms=int(time.time() * 1000))
        self._jobs.put(job)
        return True, None

    def _thread_main(self) -> None:
        try:
            from google import genai  # type: ignore
            from google.genai import types  # type: ignore
        except Exception:
            msg = "Missing dependency: google-genai (pip install google-genai)."
            self._set_fatal_error(msg)
            self._emit_failed(None, msg, fatal=True)
            return

        if not self._api_key:
            msg = "Missing GEMINI_API_KEY (or GOOGLE_API_KEY)."
            self._set_fatal_error(msg)
            self._emit_failed(None, msg, fatal=True)
            return

        client = genai.Client(api_key=self._api_key)
        config = _build_canvas_context_config(types)

        try:
            self._job_loop(client, types, config)
        except Exception as exc:
            msg = f"Gemini canvas context session crashed: {exc}"
            self._set_fatal_error(msg)
            self._emit_failed(None, msg, fatal=True)

    def _job_loop(self, client: Any, types: Any, config: Any) -> None:
        while not self._stop.is_set():
            job = self._jobs.get()
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
            self._run_job(client, types, config, job)

    def _run_job(self, client: Any, types: Any, config: Any, job: CanvasContextJob) -> None:
        image_path = Path(job.image_path)
        try:
            image_bytes = image_path.read_bytes()
        except Exception as exc:
            msg = f"Failed to read snapshot: {exc}"
            self._set_fatal_error(msg)
            self._emit_failed(job.image_path, msg, fatal=True)
            self._stop.set()
            return

        mime, _ = mimetypes.guess_type(str(image_path))
        mime = mime or "image/jpeg"

        context_text = _read_canvas_context_envelope(image_path)
        prompt = _canvas_context_instruction()
        if context_text:
            prompt = f"{prompt}\n\n{context_text}"

        parts = [
            types.Part(text=prompt),
            types.Part(inline_data=types.Blob(data=image_bytes, mime_type=mime)),
        ]

        response = None
        try:
            chat = client.chats.create(model=self._model)
            if config is not None:
                response = chat.send_message(parts, config=config)
            else:
                response = chat.send_message(parts)
        except Exception:
            # Retry without config (older SDKs can reject unknown fields).
            try:
                chat = client.chats.create(model=self._model)
                response = chat.send_message(parts)
            except Exception as exc:
                msg = f"Gemini request failed: {exc}"
                self._set_fatal_error(msg)
                self._emit_failed(job.image_path, msg, fatal=True)
                self._stop.set()
                return

        text = getattr(response, "text", None)
        cleaned = _clean_text(str(text)) if isinstance(text, str) else ""
        if not cleaned:
            candidates = getattr(response, "candidates", []) or []
            cleaned = _extract_text_from_candidates(candidates)
        if not cleaned:
            msg = "Empty Gemini canvas context response."
            self._set_fatal_error(msg)
            self._emit_failed(job.image_path, msg, fatal=True)
            self._stop.set()
            return

        self._emit_canvas_context(job.image_path, cleaned)

    def _emit_canvas_context(self, image_path: str, text: str) -> None:
        self._events.emit(
            "canvas_context",
            image_path=image_path,
            text=text,
            source=_SOURCE,
            model=self._model,
        )

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
            self._fatal_error = str(message or "").strip() or "Unknown Gemini error."


def _build_canvas_context_config(types: Any) -> Any:
    """Best-effort config for fast Canvas Context responses."""

    # Gemini 3 supports "thinking levels"; we prefer MINIMAL for low latency.
    thinking_config = None
    try:
        ThinkingConfig = getattr(types, "ThinkingConfig", None)
        if ThinkingConfig is not None:
            try:
                thinking_config = ThinkingConfig(thinking_level="minimal")
            except Exception:
                # Older SDKs used budgets; 0-ish yields minimal thinking.
                try:
                    thinking_config = ThinkingConfig(thinking_budget=0)
                except Exception:
                    thinking_config = None
    except Exception:
        thinking_config = None

    kwargs: dict[str, Any] = {
        "max_output_tokens": 520,
        "temperature": 0.6,
        "candidate_count": 1,
    }
    if thinking_config is not None:
        kwargs["thinking_config"] = thinking_config
    try:
        return types.GenerateContentConfig(**kwargs)
    except Exception:
        return None


def _extract_text_from_candidates(candidates: Any) -> str:
    parts_out: list[str] = []
    for candidate in candidates or []:
        content = getattr(candidate, "content", None)
        parts = getattr(content, "parts", None) or getattr(candidate, "parts", None) or []
        for part in parts:
            chunk = getattr(part, "text", None)
            if isinstance(chunk, str) and chunk.strip():
                parts_out.append(chunk.strip())
    return "\n".join(parts_out).strip()


def _clean_text(text: str) -> str:
    return str(text or "").strip()


def _canvas_context_instruction() -> str:
    # Keep this text in sync with brood_engine/realtime/openai_realtime.py.
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

