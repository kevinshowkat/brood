"""Recreate loop with similarity scoring."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from ..runs.events import EventWriter
from ..utils import read_json, write_json
from .caption import infer_prompt
from .similarity import compare


class RecreateLoop:
    def __init__(
        self,
        engine_generate: Callable[[str, dict[str, Any], dict[str, Any]], list[dict[str, Any]]],
        event_writer: EventWriter,
        run_id: str,
    ) -> None:
        self.engine_generate = engine_generate
        self.event_writer = event_writer
        self.run_id = run_id

    def run(
        self,
        reference_path: Path,
        settings: dict[str, Any],
        iterations: int = 3,
        target_similarity: float = 0.8,
    ) -> dict[str, Any]:
        prompt = infer_prompt(reference_path)
        best: dict[str, Any] | None = None
        best_score = 0.0

        for iteration in range(1, iterations + 1):
            intent = {"action": "recreate", "reference": str(reference_path), "iteration": iteration}
            artifacts = self.engine_generate(prompt, settings, intent)
            for artifact in artifacts:
                image_path = Path(artifact["image_path"])
                receipt_path = Path(artifact["receipt_path"])
                metrics = compare(reference_path, image_path)
                artifact["similarity"] = metrics
                if metrics["overall"] > best_score:
                    best_score = metrics["overall"]
                    best = artifact
                # Update receipt metadata
                payload = read_json(receipt_path, {})
                if isinstance(payload, dict):
                    meta = payload.get("result_metadata")
                    if not isinstance(meta, dict):
                        meta = {}
                        payload["result_metadata"] = meta
                    meta["similarity"] = metrics
                    write_json(receipt_path, payload)
            best_id = best.get("artifact_id") if best else None
            self.event_writer.emit(
                "recreate_iteration_update",
                iteration=iteration,
                similarity=best_score,
                best_artifact_id=best_id,
            )
            if best_score >= target_similarity:
                break
            prompt = f"{prompt} Refine to better match the reference image.".strip()

        return {"best": best, "best_score": best_score}
