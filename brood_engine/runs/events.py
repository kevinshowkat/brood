"""Append-only events stream."""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

from ..utils import now_utc_iso


@dataclass
class EventWriter:
    path: Path
    run_id: str
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False, init=False)

    def emit(self, event_type: str, **payload: Any) -> dict[str, Any]:
        event = {
            "type": event_type,
            "run_id": self.run_id,
            "ts": now_utc_iso(),
        }
        event.update(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = f"{json.dumps(event)}\n"
        with self._lock:
            with self.path.open("a", encoding="utf-8") as handle:
                handle.write(line)
        return event
