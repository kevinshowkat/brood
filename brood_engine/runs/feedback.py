"""Feedback storage."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import now_utc_iso


@dataclass
class FeedbackWriter:
    path: Path
    run_id: str

    def record(self, version_id: str, artifact_id: str, rating: str, reason: str | None = None) -> dict[str, Any]:
        payload = {
            "ts": now_utc_iso(),
            "run_id": self.run_id,
            "version_id": version_id,
            "artifact_id": artifact_id,
            "rating": rating,
            "reason": reason,
        }
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(payload))
            handle.write("\n")
        return payload
