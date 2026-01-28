"""Core Brood engine orchestration."""

from __future__ import annotations

import time
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

    def _build_cost_latency_payload(
        self,
        model_spec: Any,
        n: int,
        measured_latency: float,
        cached: bool = False,
    ) -> dict[str, Any]:
        cost_estimate = self.pricing.estimate_image_cost(model_spec.pricing_key)
        latency_estimate = self.latency.estimate_image_latency(model_spec.latency_key)
        latency_value = latency_estimate.latency_per_image_s
        if latency_value is None:
            latency_value = measured_latency
        cost_total_usd = None
        if cost_estimate.cost_per_image_usd is not None:
            cost_total_usd = 0.0 if cached else cost_estimate.cost_per_image_usd * n
        payload = {
            "provider": model_spec.provider,
            "model": model_spec.name,
            "cost_total_usd": cost_total_usd,
            "cost_per_1k_images_usd": cost_estimate.cost_per_1k_images_usd,
            "latency_per_image_s": latency_value,
        }
        self.last_cost_latency = dict(payload)
        return payload

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
            cost_payload = self._build_cost_latency_payload(
                model_spec,
                n=n,
                measured_latency=0.0,
                cached=True,
            )
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
            self.events.emit("cost_latency_update", **cost_payload)
            return artifacts

        started_at = time.monotonic()
        response = None
        error: Exception | None = None
        try:
            response = provider.generate(request)
        except Exception as exc:
            error = exc
        elapsed = max(time.monotonic() - started_at, 0.0)
        measured_latency = elapsed / max(1, n)
        cost_payload = self._build_cost_latency_payload(
            model_spec,
            n=n,
            measured_latency=measured_latency,
        )
        if error is not None:
            self.events.emit("cost_latency_update", **cost_payload)
            self.events.emit(
                "generation_failed",
                version_id=version.version_id,
                provider=model_spec.provider,
                model=model_spec.name,
                error=str(error),
            )
            raise error

        cost_total_usd = cost_payload["cost_total_usd"]
        cost_per_1k_images_usd = cost_payload["cost_per_1k_images_usd"]
        latency_value = cost_payload["latency_per_image_s"]

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
                "cost_total_usd": cost_total_usd,
                "cost_per_1k_images_usd": cost_per_1k_images_usd,
                "latency_per_image_s": latency_value,
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
        self.events.emit("cost_latency_update", **cost_payload)
        return artifacts

    def analyze_last_receipt(
        self,
        goals: list[str] | None = None,
        *,
        mode: str | None = None,
        round_idx: int | None = None,
        round_total: int | None = None,
    ) -> dict[str, Any] | None:
        payload, last_version = self.last_receipt_payload()
        if not payload or not last_version:
            return None
        analysis_started = time.monotonic()
        analysis = analyze_receipt(payload, goals=goals, model=self.text_model)
        analysis_elapsed = time.monotonic() - analysis_started
        if goals:
            last_version.intent = dict(last_version.intent)
            last_version.intent["goals"] = list(goals)
            self.thread.save()
        self.events.emit(
            "analysis_ready",
            version_id=last_version.version_id,
            recommendations=analysis.recommendations,
            analysis_excerpt=analysis.analysis_excerpt,
            goals=goals or [],
            analysis_elapsed_s=analysis_elapsed,
            analysis_model=self.text_model,
            mode=mode,
            round=round_idx,
            round_total=round_total,
        )
        return {
            "recommendations": analysis.recommendations,
            "analysis_excerpt": analysis.analysis_excerpt,
            "analysis_elapsed_s": analysis_elapsed,
            "analysis_model": self.text_model,
            "mode": mode,
            "round": round_idx,
            "round_total": round_total,
        }

    def last_receipt_payload(self) -> tuple[dict[str, Any] | None, Any | None]:
        if not self.thread.versions:
            return None, None
        last_version = self.thread.versions[-1]
        if not last_version.artifacts:
            return None, None
        receipt_path = Path(last_version.artifacts[-1]["receipt_path"])
        payload = read_json(receipt_path, {}) if receipt_path.exists() else {}
        if not isinstance(payload, dict):
            return None, None
        return payload, last_version

    def last_version_snapshot(self) -> dict[str, Any] | None:
        if not self.thread.versions:
            return None
        last_version = self.thread.versions[-1]
        settings = dict(last_version.settings or {})
        provider_options = settings.get("provider_options")
        if isinstance(provider_options, dict):
            settings["provider_options"] = dict(provider_options)
        return {
            "version_id": last_version.version_id,
            "prompt": last_version.prompt,
            "settings": settings,
        }

    def apply_recommendations(
        self,
        settings: dict[str, Any],
        recommendations: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], list[str], list[str]]:
        updated = dict(settings or {})
        provider_options = updated.get("provider_options")
        if not isinstance(provider_options, dict):
            provider_options = {}
        summary: list[str] = []
        skipped: list[str] = []
        for rec in recommendations or []:
            if not isinstance(rec, dict):
                continue
            name = rec.get("setting_name")
            if not name:
                continue
            value = rec.get("setting_value")
            target = rec.get("setting_target") or "provider_options"
            target = str(target)
            if target in {"request", "top_level"}:
                if str(name).lower() == "model" and value:
                    current = self.image_model
                    if current == value:
                        skipped.append(f"model={value} (unchanged)")
                    else:
                        self.image_model = str(value)
                        summary.append(f"model={value}")
                elif str(name).lower() == "size":
                    allowed = self._allowed_sizes_for_current_model()
                    if allowed and value not in allowed:
                        skipped.append(f"size={value} (unsupported)")
                    elif updated.get("size") == value:
                        skipped.append(f"size={value} (unchanged)")
                    else:
                        updated[str(name)] = value
                        summary.append(f"{name}={value}")
                else:
                    if updated.get(str(name)) == value:
                        skipped.append(f"{name}={value} (unchanged)")
                    else:
                        updated[str(name)] = value
                        summary.append(f"{name}={value}")
            elif target in {"provider_options", "provider", "options"}:
                if provider_options.get(str(name)) == value:
                    skipped.append(f"provider_options.{name}={value} (unchanged)")
                else:
                    provider_options[str(name)] = value
                    summary.append(f"provider_options.{name}={value}")
        if provider_options:
            updated["provider_options"] = provider_options
        return updated, summary, skipped

    def _allowed_sizes_for_current_model(self) -> list[str] | None:
        model = self.image_model or ""
        provider = ""
        selection = self.model_selector.select(model, "image")
        if selection and selection.model:
            provider = selection.model.provider
            model = selection.model.name
        if provider == "openai" and model.startswith("gpt-image"):
            return ["1024x1024", "1024x1536", "1536x1024", "auto"]
        return None

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
