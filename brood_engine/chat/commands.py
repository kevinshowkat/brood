"""Slash command registry."""

from __future__ import annotations

COMMANDS = {
    "/argue": "Debate two images (vision critique; why each direction wins)",
    "/bridge": "Find the aesthetic midpoint between two images (multi-image prompt)",
    "/profile": "Set memory/profile context",
    "/text_model": "Select text model",
    "/image_model": "Select image model",
    "/fast": "Fast preset",
    "/quality": "Quality preset",
    "/cheaper": "Lower cost preset",
    "/better": "Higher quality preset",
    "/optimize": "Analyze last receipt with goals (optional review mode)",
    "/diagnose": "Diagnose what's working / not working in an image (vision critique)",
    "/recast": "Reimagine an image in a totally different medium/context (image-to-image prompt)",
    "/recreate": "Recreate from reference image",
    "/describe": "Describe an image (vision) for the HUD",
    "/use": "Set active image path for edits",
    "/blend": "Combine two images into one (multi-image prompt)",
    "/swap_dna": "Apply structure of image A with surface qualities of image B (multi-image prompt)",
    "/extract_dna": "Extract color/material DNA from one or more images (vision analysis)",
    "/soul_leech": "Extract dominant emotional soul from one or more images (vision analysis)",
    "/extract_rule": "Extract the shared design rule across three images (vision analysis)",
    "/odd_one_out": "Identify which of three images breaks the pattern (vision analysis)",
    "/triforce": "Generate the centroid image equidistant from three references (multi-image prompt)",
    "/export": "Export report",
    "/help": "Show help",
}
