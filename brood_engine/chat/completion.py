"""Completion registry for slash commands and models."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from ..models.registry import ModelRegistry
from .commands import COMMANDS


@dataclass(frozen=True)
class CompletionItem:
    label: str
    detail: str


def command_completions() -> list[CompletionItem]:
    return [CompletionItem(label=cmd, detail=desc) for cmd, desc in COMMANDS.items()]


def model_completions(registry: ModelRegistry | None = None) -> list[CompletionItem]:
    registry = registry or ModelRegistry()
    items: list[CompletionItem] = []
    for model in registry.list():
        items.append(CompletionItem(label=model.name, detail=",".join(model.capabilities)))
    return items


def profile_completions(profiles: Iterable[str]) -> list[CompletionItem]:
    return [CompletionItem(label=name, detail="profile") for name in profiles]
