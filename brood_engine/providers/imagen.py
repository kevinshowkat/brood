"""Imagen provider (Google/Vertex)."""

from __future__ import annotations

import json
import os
from typing import Any, Mapping

try:
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore
except Exception:  # pragma: no cover
    genai = None  # type: ignore
    types = None  # type: ignore

try:  # optional
    import google.auth as google_auth  # type: ignore
    from google.auth import credentials as google_auth_credentials  # type: ignore
    from google.oauth2 import service_account  # type: ignore
except Exception:  # pragma: no cover
    google_auth = None  # type: ignore
    google_auth_credentials = None  # type: ignore
    service_account = None  # type: ignore

from ..runs.receipts import ImageRequest
from .base import GeneratedArtifact, ProviderResponse
from .google_utils import (
    build_image_path,
    normalize_output_format,
    nearest_gemini_ratio,
    resolve_image_size_hint,
)


class ImagenProvider:
    name = "imagen"

    def generate(self, request: ImageRequest) -> ProviderResponse:
        if genai is None:
            raise RuntimeError("google-genai package not installed. Run: pip install google-genai")

        warnings: list[str] = []
        provider_options = request.provider_options or {}
        model = request.model or "imagen-4.0-ultra"
        output_format = normalize_output_format(request.output_format, "png") or "png"

        ratio = provider_options.get("aspect_ratio") or nearest_gemini_ratio(request.size, warnings)
        if ratio == "4:5":
            warnings.append("Imagen does not support 4:5; using 3:4 instead.")
            ratio = "3:4"
        image_size = provider_options.get("image_size") or resolve_image_size_hint(request.size)

        add_watermark = True
        if provider_options.get("add_watermark") is not None:
            add_watermark = bool(provider_options.get("add_watermark"))

        seed = request.seed
        if seed is not None and add_watermark:
            warnings.append("Imagen seed ignored because add_watermark=true.")
            seed = None

        config_kwargs: dict[str, Any] = {
            "number_of_images": max(1, int(request.n)),
            "image_size": image_size,
        }
        if ratio:
            config_kwargs["aspect_ratio"] = ratio
        if request.output_format:
            output_mime = "image/jpeg" if output_format == "jpeg" else f"image/{output_format}"
            config_kwargs["output_mime_type"] = output_mime
        if seed is not None:
            config_kwargs["seed"] = seed
        if provider_options.get("add_watermark") is not None:
            config_kwargs["add_watermark"] = add_watermark
        if provider_options.get("person_generation") is not None:
            config_kwargs["person_generation"] = provider_options.get("person_generation")

        config = types.GenerateImagesConfig(**config_kwargs)
        raw_request = {
            "model": model,
            "prompt": request.prompt,
            "config": config_kwargs,
        }

        response = None
        raw_response: dict[str, Any] = {}

        vertex_client, project = _vertex_client()
        if vertex_client is not None and project is not None:
            model_name = _resolve_vertex_model(project, model)
            response = vertex_client.models.generate_images(
                model=model_name,
                prompt=request.prompt,
                config=config,
            )
        else:
            client = _client()
            response = client.models.generate_images(
                model=_resolve_model_id(model),
                prompt=request.prompt,
                config=config,
            )

        if response is None:
            raise RuntimeError("Imagen returned no response.")

        raw_response = _to_dict(response)
        generated_images = getattr(response, "generated_images", None) or getattr(response, "images", None)
        iterable = generated_images if isinstance(generated_images, (list, tuple)) else []

        results: list[GeneratedArtifact] = []
        output_mime = "image/jpeg" if output_format == "jpeg" else f"image/{output_format}"
        for idx, item in enumerate(iterable):
            image_bytes = getattr(item, "image_bytes", None) or getattr(item, "bytes", None)
            if not image_bytes:
                continue
            image_path = build_image_path(request.out_dir, idx, output_format)
            image_path.write_bytes(image_bytes)
            results.append(
                GeneratedArtifact(
                    image_path=image_path,
                    width=None,
                    height=None,
                    seed=seed,
                    metadata={
                        "provider": "vertex" if vertex_client else "imagen",
                        "mime_type": output_mime,
                    },
                )
            )

        if not results:
            raise RuntimeError("Imagen returned no images.")

        return ProviderResponse(
            results=results,
            provider_request=raw_request,
            provider_response=raw_response,
            warnings=warnings,
        )


def _client() -> genai.Client:
    api_key = os.getenv("IMAGEN_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("IMAGEN_API_KEY or GOOGLE_API_KEY not set for Imagen.")
    return genai.Client(api_key=api_key)


def _resolve_model_id(model: str | None) -> str:
    env_override = os.getenv("IMAGEN_MODEL_ID")
    if env_override:
        return env_override
    normalized = _normalize_model_name(model)
    if normalized:
        return normalized
    return "models/imagen-4.0-ultra-generate-001"


def _resolve_vertex_auth() -> tuple[google_auth_credentials.Credentials | None, str | None]:
    scopes = ("https://www.googleapis.com/auth/cloud-platform",)
    detected_project: str | None = None

    json_payload = os.getenv("IMAGEN_VERTEX_SERVICE_ACCOUNT_JSON")
    if json_payload and service_account is not None:
        try:
            data = json.loads(json_payload)
            detected_project = str(data.get("project_id") or data.get("projectId") or "") or None
            creds = service_account.Credentials.from_service_account_info(data, scopes=scopes)
            return creds, detected_project
        except Exception:
            pass

    credential_path = os.getenv("IMAGEN_VERTEX_SERVICE_ACCOUNT_FILE") or os.getenv(
        "GOOGLE_APPLICATION_CREDENTIALS"
    )
    if credential_path and service_account is not None:
        try:
            creds = service_account.Credentials.from_service_account_file(credential_path, scopes=scopes)
            detected_project = getattr(creds, "project_id", None)
            return creds, detected_project
        except Exception:
            pass

    if google_auth is not None:
        try:
            creds, project = google_auth.default(scopes=scopes)  # type: ignore[call-arg]
            detected_project = project or getattr(creds, "project_id", None)
            return creds, detected_project
        except Exception:
            return None, None

    return None, None


def _vertex_client() -> tuple[genai.Client | None, str | None]:
    if genai is None:
        return None, None
    credentials, detected_project = _resolve_vertex_auth()
    project = (
        os.getenv("IMAGEN_VERTEX_PROJECT")
        or detected_project
        or os.getenv("GOOGLE_CLOUD_PROJECT")
        or os.getenv("GCLOUD_PROJECT")
        or os.getenv("GOOGLE_PROJECT_ID")
    )
    if not project:
        return None, None
    location = os.getenv("IMAGEN_VERTEX_LOCATION", "us-central1")
    api_key = os.getenv("IMAGEN_VERTEX_API_KEY")
    client_kwargs: dict[str, Any] = {
        "vertexai": True,
        "project": project,
        "location": location,
    }
    if credentials is not None:
        client_kwargs["credentials"] = credentials
    if api_key:
        client_kwargs["api_key"] = api_key
    return genai.Client(**client_kwargs), project


def _resolve_vertex_model(project: str, model: str | None) -> str:
    env_override = os.getenv("IMAGEN_VERTEX_MODEL")
    raw = env_override or _normalize_vertex_name(model) or "imagen-4.0-ultra-generate-001"
    location = os.getenv("IMAGEN_VERTEX_LOCATION", "us-central1")
    if raw.startswith("projects/"):
        return raw
    if raw.startswith("publishers/"):
        suffix = raw
    elif raw.startswith("models/"):
        suffix = raw.replace("models/", "publishers/google/models/", 1)
    else:
        suffix = f"publishers/google/models/{raw}"
    return f"projects/{project}/locations/{location}/{suffix}"


def _normalize_model_name(model: str | None) -> str | None:
    if not model:
        return None
    normalized = str(model).strip().lower()
    if normalized.startswith("models/"):
        return normalized
    if normalized in {"imagen-4", "imagen-4.0"}:
        return "models/imagen-4.0-generate-001"
    if normalized in {"imagen-4.0-ultra", "imagen-4-ultra"}:
        return "models/imagen-4.0-ultra-generate-001"
    return normalized


def _normalize_vertex_name(model: str | None) -> str | None:
    if not model:
        return None
    normalized = str(model).strip().lower()
    if normalized.startswith("projects/") or normalized.startswith("publishers/"):
        return normalized
    if normalized.startswith("models/"):
        return normalized.replace("models/", "publishers/google/models/", 1)
    if normalized in {"imagen-4", "imagen-4.0"}:
        return "imagen-4.0-generate-001"
    if normalized in {"imagen-4.0-ultra", "imagen-4-ultra"}:
        return "imagen-4.0-ultra-generate-001"
    return normalized


def _to_dict(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(k): _to_dict(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_dict(v) for v in value]
    if hasattr(value, "model_dump_json"):
        try:
            return json.loads(value.model_dump_json())
        except Exception:
            pass
    if hasattr(value, "model_dump"):
        try:
            return _to_dict(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {str(k): _to_dict(v) for k, v in value.__dict__.items() if not str(k).startswith("_")}
    return str(value)
