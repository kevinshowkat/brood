"""CLI progress helpers."""

from __future__ import annotations

import shutil
import sys
import threading
import time
from typing import TextIO

_BOLD = "\x1b[1m"
_GREY = "\x1b[38;2;150;157;165m"
_RESET = "\x1b[0m"


def progress_line(label: str, start: float | None = None, done: bool = False) -> tuple[str, float]:
    now = time.monotonic()
    origin = now if start is None else start
    elapsed = max(0, int(now - origin))
    minutes = elapsed // 60
    seconds = elapsed % 60
    suffix = "done" if done else "esc to interrupt"
    return f"• {label} ({minutes}m {seconds:02d}s • {suffix})", origin


def progress_once(label: str) -> float:
    line, origin = progress_line(label)
    print(line)
    return origin


class ProgressTicker:
    def __init__(
        self,
        label: str,
        start: float | None = None,
        stream: TextIO | None = None,
        interval_s: float = 1.0,
    ) -> None:
        self.label = label
        self.start = start
        self.stream = stream or sys.stdout
        self.interval_s = max(0.2, interval_s)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._enabled = bool(getattr(self.stream, "isatty", lambda: False)())
        self._started = False

    def start_ticking(self) -> None:
        if not self._enabled:
            line, origin = progress_line(self.label, self.start)
            self.start = origin
            self.stream.write(f"{_BOLD}{line}{_RESET}\n")
            self.stream.flush()
            return
        line, origin = progress_line(self.label, self.start)
        self.start = origin
        self._write_line(f"{_BOLD}{line}{_RESET}", newline=False)
        self._started = True
        self._thread.start()

    def stop(self, done: bool = True) -> None:
        if not self._started and not self._enabled:
            if done:
                self._write_done_line()
            return
        self._stop.set()
        self._thread.join()
        if done:
            self._write_done_line()
        else:
            line, _ = progress_line(self.label, self.start, done=False)
            self._write_line(f"{_BOLD}{line}{_RESET}", newline=True)

    def update_label(self, label: str) -> None:
        self.label = label
        if not self._enabled or not self._started or self._stop.is_set():
            return
        line, _ = progress_line(self.label, self.start, done=False)
        self._write_line(f"{_BOLD}{line}{_RESET}", newline=False)

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            if self._stop.is_set():
                break
            line, _ = progress_line(self.label, self.start, done=False)
            self._write_line(f"{_BOLD}{line}{_RESET}", newline=False)

    def _write_line(self, line: str, newline: bool) -> None:
        if not self._enabled:
            self.stream.write(f"{line}\n")
            self.stream.flush()
            return
        self.stream.write("\r")
        self.stream.write(line)
        self.stream.write("\033[K")
        if newline:
            self.stream.write("\n")
        self.stream.flush()

    def _write_done_line(self) -> None:
        elapsed = max(0, int(time.monotonic() - (self.start or time.monotonic())))
        duration = _format_duration(elapsed)
        width = 0
        if self._enabled:
            try:
                width = shutil.get_terminal_size(fallback=(100, 20)).columns
            except Exception:
                width = 100
        line = _separator_line(f"Generated in {duration}", width if width else 100)
        styled = f"{_GREY}{line}{_RESET}"
        if self._enabled:
            self.stream.write("\r")
            self.stream.write(styled)
            self.stream.write("\033[K\n")
            self.stream.flush()
        else:
            self.stream.write(f"{styled}\n")
            self.stream.flush()


def _format_duration(seconds: int) -> str:
    minutes, secs = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    if hours:
        return f"{hours}h {minutes}m {secs:02d}s"
    if minutes:
        return f"{minutes}m {secs:02d}s"
    return f"{secs}s"


def _separator_line(label: str, width: int) -> str:
    content = f" {label} "
    if width <= len(content) + 2:
        return content.strip()
    remaining = width - len(content)
    left = remaining // 2
    right = remaining - left
    return f"{'─' * left}{content}{'─' * right}"
