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
        inference = infer_prompt(reference_path)
        prompt = inference.prompt
        base_prompt = inference.prompt
        prompt_source = inference.source
        caption_model = inference.model

        run_settings = dict(settings or {})
        # Provide the reference as context for providers that can accept images as input.
        if "reference_images" not in run_settings:
            run_settings["reference_images"] = [str(reference_path)]

        self.event_writer.emit(
            "recreate_prompt_inferred",
            reference=str(reference_path),
            prompt=base_prompt,
            source=prompt_source,
            model=caption_model,
        )
        best: dict[str, Any] | None = None
        best_score = 0.0
        iterations_run = 0
        error: str | None = None

        try:
            for iteration in range(1, iterations + 1):
                iterations_run = iteration
                intent = {
                    "action": "recreate",
                    "reference": str(reference_path),
                    "iteration": iteration,
                    "base_prompt": base_prompt,
                    "prompt_source": prompt_source,
                    "caption_model": caption_model,
                }
                artifacts = self.engine_generate(prompt, run_settings, intent)
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
        except Exception as exc:
            error = str(exc)
            raise
        finally:
            best_id = best.get("artifact_id") if best else None
            self.event_writer.emit(
                "recreate_done",
                reference=str(reference_path),
                best_artifact_id=best_id,
                best_score=best_score,
                iterations=iterations_run,
                success=error is None,
                error=error,
            )

        return {
            "best": best,
            "best_score": best_score,
            "inferred_prompt": base_prompt,
            "prompt_source": prompt_source,
            "caption_model": caption_model,
        }
