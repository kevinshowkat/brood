"""CLI progress helpers."""

from __future__ import annotations

import sys
import threading
import time
from typing import TextIO


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
            self.stream.write(f"{line}\n")
            self.stream.flush()
            return
        line, origin = progress_line(self.label, self.start)
        self.start = origin
        self._write_line(line, newline=False)
        self._started = True
        self._thread.start()

    def stop(self, done: bool = True) -> None:
        if not self._started and not self._enabled:
            if done:
                line, _ = progress_line(self.label, self.start, done=True)
                self.stream.write(f"{line}\n")
                self.stream.flush()
            return
        self._stop.set()
        self._thread.join(timeout=0.5)
        line, _ = progress_line(self.label, self.start, done=done)
        self._write_line(line, newline=True)

    def _run(self) -> None:
        while not self._stop.wait(self.interval_s):
            line, _ = progress_line(self.label, self.start, done=False)
            self._write_line(line, newline=False)

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
