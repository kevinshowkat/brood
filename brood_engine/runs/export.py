"""Export a run to HTML."""

from __future__ import annotations

import html
from pathlib import Path
from typing import Any

from ..utils import read_json


def export_html(run_dir: Path, out_path: Path) -> Path:
    thread_path = run_dir / "thread.json"
    thread = read_json(thread_path, {}) if thread_path.exists() else {}
    versions = thread.get("versions", []) if isinstance(thread, dict) else []

    cards: list[str] = []
    for version in versions:
        if not isinstance(version, dict):
            continue
        prompt = html.escape(str(version.get("prompt", "")))
        version_id = html.escape(str(version.get("version_id", "")))
        artifacts = version.get("artifacts", []) if isinstance(version.get("artifacts", []), list) else []
        for artifact in artifacts:
            if not isinstance(artifact, dict):
                continue
            image_path = artifact.get("image_path")
            receipt_path = artifact.get("receipt_path")
            image_src = html.escape(str(image_path)) if image_path else ""
            receipt_src = html.escape(str(receipt_path)) if receipt_path else ""
            cards.append(
                f"<div class='card'>"
                f"<div class='thumb'><img src='{image_src}' alt='artifact'></div>"
                f"<div class='meta'><div class='vid'>{version_id}</div>"
                f"<div class='prompt'>{prompt}</div>"
                f"<div class='links'><a href='{receipt_src}'>receipt</a></div></div>"
                f"</div>"
            )

    html_doc = f"""
<!doctype html>
<html>
<head>
  <meta charset='utf-8'>
  <title>Brood Export</title>
  <style>
    body {{ font-family: Arial, sans-serif; background: #f6f6f6; margin: 0; padding: 20px; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }}
    .card {{ background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }}
    .thumb {{ width: 100%; height: 200px; background: #eee; display: flex; align-items: center; justify-content: center; }}
    .thumb img {{ max-width: 100%; max-height: 100%; }}
    .meta {{ padding: 10px; }}
    .vid {{ font-weight: bold; font-size: 12px; color: #444; }}
    .prompt {{ font-size: 13px; margin: 8px 0; }}
    .links a {{ font-size: 12px; color: #0066cc; text-decoration: none; }}
  </style>
</head>
<body>
  <h1>Brood Run Export</h1>
  <div class='grid'>
    {''.join(cards)}
  </div>
</body>
</html>
"""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_doc, encoding="utf-8")
    return out_path
