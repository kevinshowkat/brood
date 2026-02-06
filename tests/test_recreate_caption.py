from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from brood_engine.recreate.caption import infer_prompt


def _clear_caption_env(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("OPENAI_API_KEY", "OPENAI_API_KEY_BACKUP", "GEMINI_API_KEY", "GOOGLE_API_KEY"):
        monkeypatch.delenv(key, raising=False)


def test_infer_prompt_prefers_embedded_prompt(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_caption_env(monkeypatch)
    path = tmp_path / "ref.png"
    image = Image.new("RGB", (16, 16), (255, 0, 0))
    info = PngInfo()
    info.add_text("prompt", "A red apple on a wooden table, soft window light, 35mm photo")
    image.save(path, pnginfo=info)

    inference = infer_prompt(path)
    assert inference.source == "metadata"
    assert "red apple" in inference.prompt.lower()


def test_infer_prompt_falls_back_without_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_caption_env(monkeypatch)
    path = tmp_path / "ref.png"
    Image.new("RGB", (16, 16), (0, 255, 0)).save(path)

    inference = infer_prompt(path)
    assert inference.source == "fallback"
    assert "recreate an image similar to" in inference.prompt.lower()

