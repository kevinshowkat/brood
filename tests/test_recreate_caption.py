from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from brood_engine.recreate.caption import infer_prompt, infer_diagnosis, infer_argument


def test_prepare_vision_image_converts_heic_on_macos(tmp_path: Path) -> None:
    """HEIC files are common camera outputs on macOS/iOS.

    Our vision calls require a widely-supported format (JPEG). PIL does not decode
    HEIC without optional plugins, so we fall back to `sips` on macOS.
    """
    import shutil
    import subprocess
    import sys

    if sys.platform != "darwin":
        pytest.skip("HEIC conversion via sips is macOS-specific")
    if not shutil.which("sips"):
        pytest.skip("sips not available")

    png = tmp_path / "src.png"
    Image.new("RGB", (32, 32), (120, 40, 200)).save(png)
    heic = tmp_path / "src.heic"

    subprocess.run(
        ["sips", "-s", "format", "heic", str(png), "--out", str(heic)],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )

    from brood_engine.recreate.caption import _prepare_vision_image

    data, mime = _prepare_vision_image(heic, max_dim=64)
    assert mime == "image/jpeg"
    assert data[:2] == b"\xff\xd8"


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


def test_infer_diagnosis_returns_none_without_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_caption_env(monkeypatch)
    path = tmp_path / "ref.png"
    Image.new("RGB", (16, 16), (30, 30, 30)).save(path)

    assert infer_diagnosis(path) is None


def test_infer_argument_returns_none_without_keys(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_caption_env(monkeypatch)
    a = tmp_path / "a.png"
    b = tmp_path / "b.png"
    Image.new("RGB", (16, 16), (200, 30, 30)).save(a)
    Image.new("RGB", (16, 16), (30, 30, 200)).save(b)

    assert infer_argument(a, b) is None
