from __future__ import annotations

from pathlib import Path

from PIL import Image

from brood_engine.recreate.similarity import compare


def test_similarity_determinism(tmp_path: Path) -> None:
    image_path = tmp_path / "ref.png"
    image = Image.new("RGB", (64, 64), (255, 0, 0))
    image.save(image_path)

    result1 = compare(image_path, image_path)
    result2 = compare(image_path, image_path)
    assert result1["overall"] == result2["overall"]
    assert result1["overall"] >= 0.99
