"""Core Brood engine orchestration."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from .chat.context_tracker import ContextTracker
from .eval.llm_council import analyze_receipt
from .memory.palette import extract_palette, palette_to_json
from .memory.store import MemoryStore
from .models.registry import ModelRegistry
from .models.selectors import ModelSelector
from .pricing.estimator import PricingEstimator
from .pricing.latency import LatencyEstimator
from .providers import default_registry
from .providers.base import ProviderRegistry
from .recreate.loop import RecreateLoop
from .runs.cache import CacheStore
from .runs.events import EventWriter
from .runs.feedback import FeedbackWriter
from .runs.receipts import ImageRequest, ResolvedRequest, build_receipt, write_receipt
from .runs.summary import RunSummary, write_summary
from .runs.thread_manifest import ThreadManifest
from .utils import now_utc_iso, stable_hash, read_json, getenv_flag


class BroodEngine:
    def __init__(
        self,
        run_dir: Path,
        events_path: Path,
        text_model: str | None = None,
        image_model: str | None = None,
        profile: str = "default",
        provider_registry: ProviderRegistry | None = None,
    ) -> None:
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.run_id = run_dir.name or str(uuid.uuid4())
        self.events = EventWriter(events_path, self.run_id)
        self.thread_path = run_dir / "thread.json"
        self.thread = ThreadManifest.load(self.thread_path) if self.thread_path.exists() else ThreadManifest(self.thread_path)
        self.cache = CacheStore(run_dir / "cache.json")
        self.feedback_writer = FeedbackWriter(run_dir / "feedback.jsonl", self.run_id)
        self.summary_path = run_dir / "summary.json"
        self.model_selector = ModelSelector(ModelRegistry())
        self.pricing = PricingEstimator()
        self.latency = LatencyEstimator()
        self.providers = provider_registry or default_registry()
        self.context_tracker = ContextTracker(max_tokens=8192)
        self.text_model = text_model
        self.image_model = image_model
        self.profile = profile
        self.last_fallback_reason: str | None = None
        self.last_plan: dict[str, Any] | None = None
        self.last_cost_latency: dict[str, Any] | None = None
        self.memory_enabled = getenv_flag("BROOD_MEMORY", False)
        self.memory_store = MemoryStore() if self.memory_enabled else None
        if self.memory_store:
            self.memory_store.init_db()
        self.started_at = now_utc_iso()
        self.events.emit("run_started", out_dir=str(self.run_dir))

    def track_context(self, text_in: str, text_out: str, model: str | None) -> dict[str, Any]:
        usage = self.context_tracker.record_call(text_in, text_out, model)
        summary = self.context_tracker.maybe_summarize()
        if summary:
            self.thread.update_context_summary(summary)
            self.thread.save()
        payload = {
            "model": model or "unknown",
            "used_tokens": usage.used_tokens,
            "max_tokens": usage.max_tokens,
            "pct": usage.pct,
            "alert_level": usage.alert_level,
        }
        self.events.emit("context_window_update", **payload)
        return payload

    def preview_plan(self, prompt: str, settings: dict[str, Any]) -> dict[str, Any]:
        image_selection = self.model_selector.select(self.image_model, "image")
        model_spec = image_selection.model
        size = settings.get("size", "1024x1024")
        n = int(settings.get("n", 1))
        cache_key = stable_hash(
            {"prompt": prompt, "size": size, "n": n, "model": model_spec.name, "options": settings}
        )
        cached = self.cache.get(cache_key) is not None
        return {
            "images": n,
            "model": model_spec.name,
            "provider": model_spec.provider,
            "size": size,
            "cached": cached,
            "fallback_reason": image_selection.fallback_reason,
        }

    def generate(self, prompt: str, settings: dict[str, Any], intent: dict[str, Any]) -> list[dict[str, Any]]:
        image_selection = self.model_selector.select(self.image_model, "image")
        model_spec = image_selection.model
        if image_selection.fallback_reason:
            intent["model_fallback"] = image_selection.fallback_reason
        self.last_fallback_reason = image_selection.fallback_reason

        provider = self.providers.get(model_spec.provider)
        if not provider:
            raise RuntimeError(f"No provider available for {model_spec.provider}")

        size = settings.get("size", "1024x1024")
        n = int(settings.get("n", 1))
        output_format = settings.get("output_format")
        seed = settings.get("seed")
        request = ImageRequest(
            prompt=prompt,
            size=size,
            n=n,
            seed=seed,
            output_format=output_format,
            provider=model_spec.provider,
            model=model_spec.name,
            provider_options=settings.get("provider_options", {}),
            out_dir=str(self.run_dir),
        )

        cache_key = stable_hash({"prompt": prompt, "size": size, "n": n, "model": model_spec.name, "options": settings})
        cached = self.cache.get(cache_key)

        plan_payload = {
            "plan": {
                "images": n,
                "model": model_spec.name,
                "provider": model_spec.provider,
                "size": size,
                "cached": bool(cached),
                "fallback_reason": image_selection.fallback_reason,
            }
        }
        self.last_plan = plan_payload["plan"]
        self.events.emit("plan_preview", **plan_payload)

        parent_version = intent.get("parent_version_id")
        version = self.thread.add_version(intent=intent, settings=settings, prompt=prompt, parent_version_id=parent_version)
        self.thread.save()
        self.events.emit(
            "version_created",
            version_id=version.version_id,
            parent_version_id=parent_version,
            settings=settings,
            prompt=prompt,
        )

        artifacts: list[dict[str, Any]] = []
        if cached:
            for item in cached.get("artifacts", []):
                artifact = dict(item)
                artifacts.append(artifact)
                self.thread.add_artifact(version.version_id, artifact)
                self.events.emit(
                    "artifact_created",
                    version_id=version.version_id,
                    artifact_id=artifact.get("artifact_id"),
                    image_path=artifact.get("image_path"),
                    receipt_path=artifact.get("receipt_path"),
                    metrics=artifact.get("metrics", {}),
                )
            self.thread.save()
            return artifacts

        response = provider.generate(request)
        cost_estimate = self.pricing.estimate_image_cost(model_spec.pricing_key)
        latency_estimate = self.latency.estimate_image_latency(model_spec.latency_key)
        self.last_cost_latency = {
            "provider": model_spec.provider,
            "model": model_spec.name,
            "cost_per_1k_images_usd": cost_estimate.cost_per_1k_images_usd,
            "latency_per_image_s": latency_estimate.latency_per_image_s,
        }
        if cost_estimate.cost_per_1k_images_usd is not None or latency_estimate.latency_per_image_s is not None:
            self.events.emit(
                "cost_latency_update",
                provider=model_spec.provider,
                model=model_spec.name,
                cost_per_1k_images_usd=cost_estimate.cost_per_1k_images_usd,
                latency_per_image_s=latency_estimate.latency_per_image_s,
            )

        for idx, result in enumerate(response.results, start=1):
            artifact_id = f"{version.version_id}-{idx:02d}-{uuid.uuid4().hex[:8]}"
            receipt_path = self.run_dir / f"receipt-{artifact_id}.json"
            resolved = ResolvedRequest(
                provider=model_spec.provider,
                model=model_spec.name,
                size=size,
                width=result.width,
                height=result.height,
                output_format=output_format or "png",
                background=None,
                seed=result.seed,
                n=n,
                user=None,
                prompt=prompt,
                inputs=request.inputs,
                stream=False,
                partial_images=None,
                provider_params=settings.get("provider_options", {}),
                warnings=response.warnings,
            )
            metadata = {
                "cost_per_1k_images_usd": cost_estimate.cost_per_1k_images_usd,
                "latency_per_image_s": latency_estimate.latency_per_image_s,
            }
            receipt = build_receipt(
                request=request,
                resolved=resolved,
                provider_request=response.provider_request,
                provider_response=response.provider_response,
                warnings=response.warnings,
                image_path=result.image_path,
                receipt_path=receipt_path,
                result_metadata=metadata,
            )
            write_receipt(receipt_path, receipt)

            artifact = {
                "artifact_id": artifact_id,
                "image_path": str(result.image_path),
                "receipt_path": str(receipt_path),
                "metrics": metadata,
            }
            artifacts.append(artifact)
            self.thread.add_artifact(version.version_id, artifact)
            self.events.emit(
                "artifact_created",
                version_id=version.version_id,
                artifact_id=artifact_id,
                image_path=str(result.image_path),
                receipt_path=str(receipt_path),
                metrics=metadata,
            )

            if self.memory_store:
                colors = extract_palette(result.image_path)
                self.memory_store.record_palette(artifact_id, palette_to_json(colors), now_utc_iso())
                self.memory_store.add_artifact(
                    {
                        "artifact_id": artifact_id,
                        "run_id": self.run_id,
                        "version_id": version.version_id,
                        "image_path": str(result.image_path),
                        "receipt_path": str(receipt_path),
                        "provider": model_spec.provider,
                        "model": model_spec.name,
                        "prompt": prompt,
                        "created_at": now_utc_iso(),
                    }
                )

        self.thread.save()
        self.cache.set(cache_key, {"artifacts": artifacts})
        return artifacts

    def analyze_last_receipt(self) -> dict[str, Any] | None:
        if not self.thread.versions:
            return None
        last_version = self.thread.versions[-1]
        if not last_version.artifacts:
            return None
        receipt_path = Path(last_version.artifacts[-1]["receipt_path"])
        payload = read_json(receipt_path, {}) if receipt_path.exists() else {}
        if not isinstance(payload, dict):
            return None
        analysis = analyze_receipt(payload)
        self.events.emit(
            "analysis_ready",
            version_id=last_version.version_id,
            recommendations=analysis.recommendations,
            analysis_excerpt=analysis.analysis_excerpt,
        )
        return {"recommendations": analysis.recommendations, "analysis_excerpt": analysis.analysis_excerpt}

    def record_feedback(self, version_id: str, artifact_id: str, rating: str, reason: str | None = None) -> None:
        feedback = self.feedback_writer.record(version_id, artifact_id, rating, reason)
        self.thread.record_feedback(version_id, feedback)
        self.thread.save()
        self.events.emit(
            "feedback_recorded",
            version_id=version_id,
            artifact_id=artifact_id,
            rating=rating,
            reason=reason,
        )
        if self.memory_store and rating == "winner":
            try:
                from .memory.style_tagger import tag_style
            except Exception:
                return
            prompt = None
            for version in self.thread.versions:
                for artifact in version.artifacts:
                    if artifact.get("artifact_id") == artifact_id:
                        prompt = version.prompt
                        break
            if prompt:
                tags = tag_style(prompt)
                self.memory_store.record_style_tags(
                    artifact_id,
                    str(tags.tags),
                    tags.summary_1line,
                    now_utc_iso(),
                )

    def recreate(self, reference_path: Path, settings: dict[str, Any]) -> dict[str, Any]:
        loop = RecreateLoop(self._generate_for_recreate, self.events, self.run_id)
        return loop.run(reference_path, settings)

    def _generate_for_recreate(self, prompt: str, settings: dict[str, Any], intent: dict[str, Any]) -> list[dict[str, Any]]:
        intent = dict(intent)
        intent["parent_version_id"] = settings.get("parent_version_id")
        return self.generate(prompt, settings, intent)

    def finish(self) -> None:
        winners: list[dict[str, Any]] = []
        total_artifacts = 0
        for version in self.thread.versions:
            total_artifacts += len(version.artifacts)
            if version.selected_artifact_id:
                winners.append(
                    {
                        "version_id": version.version_id,
                        "artifact_id": version.selected_artifact_id,
                    }
                )
        summary = RunSummary(
            run_id=self.run_id,
            started_at=self.started_at,
            finished_at=now_utc_iso(),
            total_versions=len(self.thread.versions),
            total_artifacts=total_artifacts,
            winners=winners,
        )
        write_summary(self.summary_path, summary)
        self.events.emit("run_finished", summary_path=str(self.summary_path))
