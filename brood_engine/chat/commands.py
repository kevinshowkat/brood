"""Slash command registry."""

from __future__ import annotations

COMMANDS = {
    "/profile": "Set memory/profile context",
    "/text_model": "Select text model",
    "/image_model": "Select image model",
    "/fast": "Fast preset",
    "/quality": "Quality preset",
    "/cheaper": "Lower cost preset",
    "/better": "Higher quality preset",
    "/optimize": "Analyze last receipt with goals (optional review mode)",
    "/recreate": "Recreate from reference image",
    "/export": "Export report",
    "/help": "Show help",
}
