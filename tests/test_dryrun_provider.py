from __future__ import annotations

from pathlib import Path

from brood_engine.providers.base import ImageRequest
from brood_engine.providers.dryrun import DryRunProvider, _resolve_size


def test_resolve_size_aliases() -> None:
    assert _resolve_size("portrait") == (1024, 1536)
    assert _resolve_size("landscape") == (1536, 1024)
    assert _resolve_size("square") == (1024, 1024)
    assert _resolve_size("bad-size") == (1024, 1024)


def test_dryrun_generate_creates_expected_artifacts(tmp_path: Path) -> None:
    provider = DryRunProvider()
    request = ImageRequest(
        prompt="A dramatic coastline",
        size="landscape",
        n=2,
        out_dir=str(tmp_path),
        model="dryrun-image-1",
    )
    response = provider.generate(request)
    results = response.results

    assert len(results) == 2
    assert results[0].width == 1536
    assert results[0].height == 1024
    assert results[1].width == 1536
    assert results[1].height == 1024
    assert results[0].metadata == {"dryrun": True}
    assert results[0].seed is not None
    assert results[0].image_path.exists()
    assert results[1].image_path.exists()
    assert results[0].image_path != results[1].image_path


def test_dryrun_generate_uses_seed_if_provided(tmp_path: Path) -> None:
    provider = DryRunProvider()
    request = ImageRequest(
        prompt="A dramatic coastline",
        size="square",
        n=1,
        out_dir=str(tmp_path),
        seed=12345,
        model="dryrun-image-1",
    )
    response = provider.generate(request)
    results = response.results

    assert len(results) == 1
    assert results[0].seed == 12345
    assert results[0].width == 1024
    assert results[0].height == 1024
