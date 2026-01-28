"""Run summary generation."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import now_utc_iso, write_json


@dataclass
class RunSummary:
    run_id: str
    started_at: str
    finished_at: str
    total_versions: int
    total_artifacts: int
    winners: list[dict[str, Any]]


def write_summary(path: Path, summary: RunSummary, extra: dict[str, Any] | None = None) -> None:
    payload = {
        "run_id": summary.run_id,
        "started_at": summary.started_at,
        "finished_at": summary.finished_at,
        "total_versions": summary.total_versions,
        "total_artifacts": summary.total_artifacts,
        "winners": summary.winners,
        "ts": now_utc_iso(),
    }
    if extra:
        payload.update(extra)
    write_json(path, payload)
