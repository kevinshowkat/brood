from __future__ import annotations

import time

from brood_engine.cli_progress import ProgressTicker


class FakeStream:
    def __init__(self, is_tty: bool) -> None:
        self._isatty = is_tty
        self.buffer: list[str] = []

    def isatty(self) -> bool:  # pragma: no cover - signature mimic
        return self._isatty

    def write(self, data: str) -> None:
        self.buffer.append(data)

    def flush(self) -> None:  # pragma: no cover - no-op for tests
        return None

    @property
    def text(self) -> str:
        return "".join(self.buffer)


def test_ticker_non_tty_prints_once() -> None:
    stream = FakeStream(is_tty=False)
    ticker = ProgressTicker("Generating images", stream=stream, interval_s=0.01)
    ticker.start_ticking()
    ticker.stop(done=True)
    output = stream.text
    lines = [line for line in output.splitlines() if line.strip()]
    assert len(lines) == 2
    assert "Generating images" in lines[0]
    assert "Generated in" in lines[1]
    assert "\r" not in output


def test_ticker_tty_updates_in_place() -> None:
    stream = FakeStream(is_tty=True)
    ticker = ProgressTicker("Generating images", stream=stream, interval_s=0.01)
    ticker.start_ticking()
    time.sleep(0.03)
    ticker.stop(done=True)
    output = stream.text
    assert "\r" in output
    assert "\x1b[K" in output
    assert output.count("Generated in") == 1
