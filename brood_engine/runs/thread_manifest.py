"""Thread manifest for deterministic versioning."""

from __future__ import annotations

import difflib
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

from ..utils import now_utc_iso, read_json, write_json


def _prompt_diff(prev: str | None, curr: str) -> list[str] | None:
    if prev is None:
        return None
    diff = difflib.unified_diff(
        prev.splitlines(),
        curr.splitlines(),
        lineterm="",
        fromfile="prev",
        tofile="curr",
    )
    return list(diff)


def _settings_diff(prev: Mapping[str, Any] | None, curr: Mapping[str, Any]) -> dict[str, Any] | None:
    if prev is None:
        return None
    diff: dict[str, Any] = {}
    keys = set(prev.keys()) | set(curr.keys())
    for key in sorted(keys):
        if prev.get(key) != curr.get(key):
            diff[key] = {"from": prev.get(key), "to": curr.get(key)}
    return diff


@dataclass
class VersionEntry:
    version_id: str
    parent_version_id: str | None
    intent: dict[str, Any]
    settings: dict[str, Any]
    prompt: str
    prompt_diff: list[str] | None
    settings_diff: dict[str, Any] | None
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    selected_artifact_id: str | None = None
    feedback: list[dict[str, Any]] = field(default_factory=list)


class ThreadManifest:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.schema_version = 1
        self.thread_id = str(uuid.uuid4())
        self.created_at = now_utc_iso()
        self.versions: list[VersionEntry] = []
        self.context_summary: dict[str, Any] = {"text": "", "updated_at": None}

    @classmethod
    def load(cls, path: Path) -> "ThreadManifest":
        payload = read_json(path, {})
        manifest = cls(path)
        if not isinstance(payload, dict):
            return manifest
        manifest.schema_version = payload.get("schema_version", 1)
        manifest.thread_id = payload.get("thread_id", manifest.thread_id)
        manifest.created_at = payload.get("created_at", manifest.created_at)
        manifest.context_summary = payload.get("context_summary", manifest.context_summary)
        versions = payload.get("versions", [])
        if isinstance(versions, list):
            for item in versions:
                if not isinstance(item, dict):
                    continue
                manifest.versions.append(
                    VersionEntry(
                        version_id=item.get("version_id"),
                        parent_version_id=item.get("parent_version_id"),
                        intent=item.get("intent", {}),
                        settings=item.get("settings", {}),
                        prompt=item.get("prompt", ""),
                        prompt_diff=item.get("prompt_diff"),
                        settings_diff=item.get("settings_diff"),
                        artifacts=item.get("artifacts", []),
                        selected_artifact_id=item.get("selected_artifact_id"),
                        feedback=item.get("feedback", []),
                    )
                )
        return manifest

    def _next_version_id(self) -> str:
        return f"v{len(self.versions) + 1}"

    def add_version(
        self,
        *,
        intent: dict[str, Any],
        settings: dict[str, Any],
        prompt: str,
        parent_version_id: str | None,
    ) -> VersionEntry:
        prev = self._get_version(parent_version_id) if parent_version_id else None
        prompt_diff = _prompt_diff(prev.prompt if prev else None, prompt)
        settings_diff = _settings_diff(prev.settings if prev else None, settings)
        version = VersionEntry(
            version_id=self._next_version_id(),
            parent_version_id=parent_version_id,
            intent=intent,
            settings=settings,
            prompt=prompt,
            prompt_diff=prompt_diff,
            settings_diff=settings_diff,
        )
        self.versions.append(version)
        return version

    def add_artifact(self, version_id: str, artifact: dict[str, Any]) -> None:
        version = self._get_version(version_id)
        if version:
            version.artifacts.append(artifact)

    def select_artifact(self, version_id: str, artifact_id: str, reason: str | None = None) -> None:
        version = self._get_version(version_id)
        if not version:
            return
        version.selected_artifact_id = artifact_id
        if reason:
            version.feedback.append({"artifact_id": artifact_id, "rating": "winner", "reason": reason})

    def record_feedback(self, version_id: str, payload: dict[str, Any]) -> None:
        version = self._get_version(version_id)
        if version:
            version.feedback.append(payload)

    def update_context_summary(self, text: str) -> None:
        self.context_summary = {"text": text, "updated_at": now_utc_iso()}

    def save(self) -> None:
        payload = {
            "schema_version": self.schema_version,
            "thread_id": self.thread_id,
            "created_at": self.created_at,
            "versions": [self._serialize_version(v) for v in self.versions],
            "context_summary": self.context_summary,
        }
        write_json(self.path, payload)

    def _serialize_version(self, version: VersionEntry) -> dict[str, Any]:
        return {
            "version_id": version.version_id,
            "parent_version_id": version.parent_version_id,
            "intent": version.intent,
            "settings": version.settings,
            "prompt": version.prompt,
            "prompt_diff": version.prompt_diff,
            "settings_diff": version.settings_diff,
            "artifacts": version.artifacts,
            "selected_artifact_id": version.selected_artifact_id,
            "feedback": version.feedback,
        }

    def _get_version(self, version_id: str | None) -> VersionEntry | None:
        if not version_id:
            return None
        for version in self.versions:
            if version.version_id == version_id:
                return version
        return None
