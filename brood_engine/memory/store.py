"""SQLite-backed aesthetic memory store."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..utils import ensure_dir


DB_PATH = Path.home() / ".brood" / "memory.sqlite"


@dataclass
class MemoryStore:
    path: Path = DB_PATH

    def connect(self) -> sqlite3.Connection:
        ensure_dir(self.path.parent)
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        return conn

    def init_db(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS artifacts (
                    artifact_id TEXT PRIMARY KEY,
                    run_id TEXT,
                    version_id TEXT,
                    image_path TEXT,
                    receipt_path TEXT,
                    provider TEXT,
                    model TEXT,
                    prompt TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS feedback (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artifact_id TEXT,
                    profile_id TEXT,
                    rating TEXT,
                    reason TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS palettes (
                    artifact_id TEXT,
                    colors_json TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS style_tags (
                    artifact_id TEXT,
                    tags_json TEXT,
                    summary_1line TEXT,
                    created_at TEXT
                );
                CREATE TABLE IF NOT EXISTS profiles (
                    profile_id TEXT PRIMARY KEY,
                    summary_text TEXT,
                    structured_prefs_json TEXT,
                    updated_at TEXT
                );
                """
            )

    def add_artifact(self, payload: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO artifacts
                (artifact_id, run_id, version_id, image_path, receipt_path, provider, model, prompt, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    payload.get("artifact_id"),
                    payload.get("run_id"),
                    payload.get("version_id"),
                    payload.get("image_path"),
                    payload.get("receipt_path"),
                    payload.get("provider"),
                    payload.get("model"),
                    payload.get("prompt"),
                    payload.get("created_at"),
                ),
            )

    def record_feedback(self, payload: dict[str, Any]) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO feedback
                (artifact_id, profile_id, rating, reason, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    payload.get("artifact_id"),
                    payload.get("profile_id"),
                    payload.get("rating"),
                    payload.get("reason"),
                    payload.get("created_at"),
                ),
            )

    def record_palette(self, artifact_id: str, colors_json: str, created_at: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO palettes (artifact_id, colors_json, created_at) VALUES (?, ?, ?)",
                (artifact_id, colors_json, created_at),
            )

    def record_style_tags(self, artifact_id: str, tags_json: str, summary_1line: str, created_at: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "INSERT INTO style_tags (artifact_id, tags_json, summary_1line, created_at) VALUES (?, ?, ?, ?)",
                (artifact_id, tags_json, summary_1line, created_at),
            )

    def upsert_profile(self, profile_id: str, summary_text: str, structured_prefs_json: str, updated_at: str) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO profiles (profile_id, summary_text, structured_prefs_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(profile_id) DO UPDATE SET
                    summary_text=excluded.summary_text,
                    structured_prefs_json=excluded.structured_prefs_json,
                    updated_at=excluded.updated_at
                """,
                (profile_id, summary_text, structured_prefs_json, updated_at),
            )

    def list_profiles(self) -> list[str]:
        with self.connect() as conn:
            rows = conn.execute("SELECT profile_id FROM profiles ORDER BY profile_id").fetchall()
        return [row[0] for row in rows]
