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
    "/describe": "Describe an image (vision) for the HUD",
    "/use": "Set active image path for edits",
    "/blend": "Combine two images into one (multi-image prompt)",
    "/swap_dna": "Apply structure of image A with surface qualities of image B (multi-image prompt)",
    "/export": "Export report",
    "/help": "Show help",
}
