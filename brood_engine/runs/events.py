"""Append-only events stream."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import now_utc_iso


@dataclass
class EventWriter:
    path: Path
    run_id: str

    def emit(self, event_type: str, **payload: Any) -> dict[str, Any]:
        event = {
            "type": event_type,
            "run_id": self.run_id,
            "ts": now_utc_iso(),
        }
        event.update(payload)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(event))
            handle.write("\n")
        return event
