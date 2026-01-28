"""Imagen (Google/Vertex) adapter."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

try:
    from google import genai  # type: ignore
    from google.genai import errors as genai_errors  # type: ignore
    from google.genai import types  # type: ignore
except Exception:  # pragma: no cover
    genai = None  # type: ignore
    genai_errors = None  # type: ignore
    types = None  # type: ignore

from forge_image_api.core.contracts import ImageRequest, ResolvedRequest
from .base import ProviderAdapter, ProviderImage, ProviderResponse, ProviderStreamEvent


MODEL_ID = os.getenv("IMAGEN_MODEL_ID", "models/imagen-4.0-ultra-generate-001")
VERTEX_MODEL_NAME = os.getenv("IMAGEN_VERTEX_MODEL", "imagen-4.0-ultra-generate-001")

try:  # optional
    import google.auth as google_auth  # type: ignore
    from google.auth import credentials as google_auth_credentials  # type: ignore
    from google.oauth2 import service_account  # type: ignore
except Exception:  # pragma: no cover
    google_auth = None  # type: ignore[assignment]
    google_auth_credentials = None  # type: ignore[assignment]
    service_account = None  # type: ignore[assignment]


def _resolve_vertex_auth() -> Tuple[Optional["google_auth_credentials.Credentials"], Optional[str]]:
    scopes = ("https://www.googleapis.com/auth/cloud-platform",)
    detected_project: Optional[str] = None

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


def _vertex_client() -> Tuple[Optional[genai.Client], Optional[str]]:
    if genai is None:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")
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
    client_kwargs: Dict[str, Any] = {
        "vertexai": True,
        "project": project,
        "location": location,
    }
    if credentials is not None:
        client_kwargs["credentials"] = credentials
    if api_key:
        client_kwargs["api_key"] = api_key

    return genai.Client(**client_kwargs), project


def _client() -> genai.Client:
    api_key = os.getenv("IMAGEN_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("IMAGEN_API_KEY or GOOGLE_API_KEY not set for Imagen.")
    if genai is None:
        raise RuntimeError("google-genai package not installed. Run: pip install google-genai")
    return genai.Client(api_key=api_key)


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


def _resolve_vertex_model(project: str) -> str:
    raw = VERTEX_MODEL_NAME
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


class ImagenAdapter:
    name = "imagen"

    def generate(self, request: ImageRequest, resolved: ResolvedRequest) -> ProviderResponse:
        output_format_effective = resolved.output_format
        output_format_param = output_format_effective if request.output_format else None
        output_mime = "image/jpeg" if output_format_effective == "jpeg" else f"image/{output_format_effective}"
        config_kwargs: Dict[str, Any] = {
            "number_of_images": resolved.n,
        }
        if output_format_param:
            config_kwargs["output_mime_type"] = output_mime
        if resolved.provider_params.get("image_size"):
            config_kwargs["image_size"] = resolved.provider_params.get("image_size")
        if resolved.provider_params.get("aspect_ratio"):
            config_kwargs["aspect_ratio"] = resolved.provider_params.get("aspect_ratio")
        if resolved.seed is not None:
            config_kwargs["seed"] = resolved.seed
        if resolved.provider_params.get("add_watermark") is not None:
            config_kwargs["add_watermark"] = resolved.provider_params.get("add_watermark")
        if resolved.provider_params.get("person_generation") is not None:
            config_kwargs["person_generation"] = resolved.provider_params.get("person_generation")

        config = types.GenerateImagesConfig(**config_kwargs)
        raw_request = {
            "model": resolved.model,
            "prompt": resolved.prompt,
            "config": config_kwargs,
        }

        response = None
        raw_response: Dict[str, Any] = {}
        images: List[ProviderImage] = []

        vertex_client, project = _vertex_client()
        if vertex_client is not None and project is not None:
            model_name = _resolve_vertex_model(project)
            response = vertex_client.models.generate_images(
                model=model_name,
                prompt=resolved.prompt,
                config=config,
            )
        else:
            client = _client()
            response = client.models.generate_images(
                model=MODEL_ID,
                prompt=resolved.prompt,
                config=config,
            )

        if response is None:
            raise RuntimeError("Imagen returned no response.")

        raw_response = _to_dict(response)
        generated_images = getattr(response, "generated_images", None) or getattr(response, "images", None)
        iterable = generated_images if isinstance(generated_images, (list, tuple)) else []

        for item in iterable:
            image_bytes = getattr(item, "image_bytes", None) or getattr(item, "bytes", None)
            if not image_bytes:
                continue
            images.append(
                ProviderImage(
                    image_bytes=image_bytes,
                    mime_type=output_mime,
                    provider_request_id=getattr(response, "id", None),
                    metadata={"provider": "vertex" if vertex_client else "imagen"},
                )
            )

        if not images:
            raise RuntimeError("Imagen returned no images.")

        usage_payload = getattr(response, "usage_metadata", None) or getattr(response, "usage", None)

        return ProviderResponse(
            images=images,
            model=resolved.model,
            usage=usage_payload if isinstance(usage_payload, Mapping) else None,
            raw_request=raw_request,
            raw_response=raw_response,
            warnings=resolved.warnings,
        )

    def stream(self, request: ImageRequest, resolved: ResolvedRequest) -> Iterator[ProviderStreamEvent]:
        yield ProviderStreamEvent(
            type="error",
            index=0,
            message="Imagen does not support streaming image generation.",
        )
