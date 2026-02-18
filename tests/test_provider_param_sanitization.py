from brood_engine.providers.flux import _resolve_flux_dims, _sanitize_flux_options
from brood_engine.providers.imagen import (
    _normalize_imagen_aspect_ratio,
    _normalize_imagen_image_size,
    _normalize_imagen_number_of_images,
    _normalize_imagen_person_generation,
)


def test_flux_dims_are_scaled_to_documented_max_area() -> None:
    width, height, warnings = _resolve_flux_dims("4000x4000")
    assert width * height <= 4_000_000
    assert any("scaled down" in warning for warning in warnings)


def test_flux_ignores_non_flex_steps_guidance_and_unknown_options() -> None:
    warnings: list[str] = []
    sanitized = _sanitize_flux_options(
        {
            "steps": 12,
            "guidance": 3.0,
            "quality": "high",
            "output_format": "jpg",
        },
        endpoint_label="flux-2-pro",
        warnings=warnings,
    )
    assert sanitized.get("output_format") == "jpeg"
    assert "steps" not in sanitized
    assert "guidance" not in sanitized
    assert "quality" not in sanitized
    assert any("non-flex endpoint" in warning for warning in warnings)


def test_imagen_ratio_and_size_are_normalized() -> None:
    warnings: list[str] = []
    ratio = _normalize_imagen_aspect_ratio("2:3", warnings=warnings)
    size = _normalize_imagen_image_size("4K", model="imagen-4.0-ultra", warnings=warnings)
    assert ratio == "3:4"
    assert size == "2K"
    assert any("aspect_ratio snapped" in warning for warning in warnings)
    assert any("image_size 4K unsupported" in warning for warning in warnings)


def test_imagen_clamps_number_of_images_and_person_generation() -> None:
    warnings: list[str] = []
    count = _normalize_imagen_number_of_images(8, warnings=warnings)
    person_generation = _normalize_imagen_person_generation("all_people", warnings=warnings)
    assert count == 4
    assert person_generation is None
    assert any("number_of_images clamped to 4" in warning for warning in warnings)
    assert any("person_generation" in warning for warning in warnings)
