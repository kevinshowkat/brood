"""Profile management for memory."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..utils import now_utc_iso
from .store import MemoryStore


@dataclass
class Profile:
    profile_id: str
    summary_text: str = ""
    structured_prefs: dict[str, Any] | None = None


class ProfileManager:
    def __init__(self, store: MemoryStore | None = None) -> None:
        self.store = store or MemoryStore()
        self.store.init_db()

    def upsert(self, profile: Profile) -> None:
        prefs_json = "{}"
        if profile.structured_prefs:
            prefs_json = str(profile.structured_prefs)
        self.store.upsert_profile(profile.profile_id, profile.summary_text, prefs_json, now_utc_iso())

    def list_profiles(self) -> list[str]:
        return self.store.list_profiles()
