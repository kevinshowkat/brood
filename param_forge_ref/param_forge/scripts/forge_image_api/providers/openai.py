"""OpenAI image adapter."""

from __future__ import annotations

import base64
import io
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional

try:
    from openai import OpenAI  # type: ignore
except Exception:  # pragma: no cover
    OpenAI = None  # type: ignore

from forge_image_api.core.contracts import ImageRequest, ResolvedRequest
from forge_image_api.core.utils import utc_timestamp
from .base import ProviderAdapter, ProviderImage, ProviderResponse, ProviderStreamEvent


DEFAULT_MODEL = "gpt-image-1.5"


def _client() -> OpenAI:
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("OPENAI_API_KEY_BACKUP")
    if not api_key:
        raise RuntimeError("OPENAI_API_KEY not set.")
    if OpenAI is None:
        raise RuntimeError("openai package not installed. Run: pip install openai")
    return OpenAI(api_key=api_key)


def _to_plain(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Mapping):
        return {str(k): _to_plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_to_plain(v) for v in value]
    if hasattr(value, "model_dump_json"):
        try:
            return json.loads(value.model_dump_json())
        except Exception:
            pass
    if hasattr(value, "model_dump"):
        try:
            return _to_plain(value.model_dump())
        except Exception:
            pass
    if hasattr(value, "__dict__"):
        return {str(k): _to_plain(v) for k, v in value.__dict__.items() if not str(k).startswith("_")}
    return str(value)


def _extract_index(payload: Mapping[str, Any]) -> Optional[int]:
    for key in ("index", "image_index", "image_number", "position"):
        raw = payload.get(key)
        if isinstance(raw, int):
            return raw
        if isinstance(raw, str):
            try:
                return int(raw)
            except ValueError:
                continue
    metadata = payload.get("metadata")
    if isinstance(metadata, Mapping):
        for key in ("index", "image_index", "image_number", "position"):
            raw = metadata.get(key)
            if isinstance(raw, int):
                return raw
            if isinstance(raw, str):
                try:
                    return int(raw)
                except ValueError:
                    continue
    return None


def _extract_image_payloads(event: Any) -> List[Dict[str, Any]]:
    payloads: List[Dict[str, Any]] = []
    data_attr = getattr(event, "data", None)
    candidates: list[Any] = []
    if data_attr is None:
        candidates.append(event)
    elif isinstance(data_attr, list):
        candidates.extend(data_attr)
    else:
        candidates.append(data_attr)

    for candidate in candidates:
        candidate_dict = _to_plain(candidate)
        if isinstance(candidate_dict, dict) and candidate_dict.get("b64_json"):
            payloads.append(candidate_dict)
    return payloads


def _coerce_usage(usage_obj: Any) -> Any:
    if usage_obj is None:
        return None
    if hasattr(usage_obj, "model_dump_json"):
        try:
            return json.loads(usage_obj.model_dump_json())
        except Exception:
            pass
    if hasattr(usage_obj, "model_dump"):
        try:
            return usage_obj.model_dump()
        except Exception:
            pass
    if isinstance(usage_obj, Mapping):
        return {k: _coerce_usage(v) for k, v in usage_obj.items()}
    return usage_obj


def _open_image_handle(value: Any, out_dir: Path, label: str) -> tuple[Any, Optional[Path]]:
    if isinstance(value, (str, Path)):
        path = Path(value).expanduser().resolve()
        return path.open("rb"), None
    if isinstance(value, (bytes, bytearray)):
        temp_path = out_dir / f"input-{label}-{utc_timestamp()}.bin"
        temp_path.write_bytes(bytes(value))
        return temp_path.open("rb"), temp_path
    raise TypeError(f"Unsupported image input type: {type(value)}")


def _call_with_kw_fallback(func, kwargs: Dict[str, Any], max_retries: int = 2):
    """Retry call by stripping unexpected keyword args reported by the SDK."""
    attempt = 0
    while True:
        try:
            return func(**kwargs)
        except TypeError as exc:
            message = str(exc)
            if "unexpected keyword argument" not in message or attempt >= max_retries:
                raise
            # Extract offending kwarg name if possible.
            bad_key = None
            if "'" in message:
                parts = message.split("'")
                if len(parts) >= 2:
                    bad_key = parts[1]
            if not bad_key or bad_key not in kwargs:
                raise
            kwargs = dict(kwargs)
            kwargs.pop(bad_key, None)
            attempt += 1


def _supports_output_compression(output_format: Optional[str]) -> bool:
    if not output_format:
        return True
    return output_format.strip().lower() != "png"


class OpenAIAdapter:
    name = "openai"

    def generate(self, request: ImageRequest, resolved: ResolvedRequest) -> ProviderResponse:
        client = _client()
        model = resolved.model or DEFAULT_MODEL
        output_format_effective = resolved.output_format
        output_format_param = output_format_effective if request.output_format else None
        prompt = resolved.prompt
        out_dir = request.out_dir or Path.cwd()
        warnings = list(resolved.warnings)
        allow_compression = _supports_output_compression(output_format_effective)
        if not allow_compression and resolved.provider_params.get("output_compression") is not None:
            warnings.append("OpenAI output_compression ignored for PNG output.")

        use_responses = False
        responses_model = model
        if request.provider_options:
            use_responses = bool(
                request.provider_options.get("use_responses")
                or request.provider_options.get("openai_use_responses")
            )
            responses_model = request.provider_options.get("responses_model") or request.provider_options.get(
                "openai_responses_model"
            ) or responses_model

        response = None
        raw_request: Dict[str, Any] = {}
        temp_paths: List[Path] = []
        image_handles: List[Any] = []
        mask_handle = None

        try:
            if use_responses and request.mode != "edit":
                tool_payload: Dict[str, Any] = {"type": "image_generation"}
                if resolved.size:
                    tool_payload["size"] = resolved.size
                if output_format_param:
                    tool_payload["output_format"] = output_format_param
                quality = resolved.provider_params.get("quality")
                if quality:
                    tool_payload["quality"] = quality
                if resolved.background:
                    tool_payload["background"] = resolved.background
                if allow_compression and resolved.provider_params.get("output_compression") is not None:
                    tool_payload["output_compression"] = resolved.provider_params.get("output_compression")

                raw_request = {
                    "model": responses_model,
                    "prompt": prompt,
                    "image_count": resolved.n,
                    "size": resolved.size,
                    "responses": True,
                    "tool": tool_payload,
                }
                if output_format_param:
                    raw_request["output_format"] = output_format_param

                responses: List[Any] = []
                try:
                    for _ in range(max(1, resolved.n)):
                        response_obj = client.responses.create(
                            model=responses_model,
                            input=prompt,
                            tools=[tool_payload],
                            tool_choice={"type": "image_generation"},
                        )
                        responses.append(response_obj)
                    response = responses
                except Exception as exc:
                    warnings.append(f"OpenAI responses failed; falling back to images.generate ({exc}).")
                    response = None

            if response is None and request.mode == "edit" and request.inputs.init_image is not None:
                base_handle, temp_path = _open_image_handle(request.inputs.init_image, out_dir, "init")
                image_handles.append(base_handle)
                if temp_path:
                    temp_paths.append(temp_path)
                if request.inputs.reference_images:
                    for idx, ref in enumerate(request.inputs.reference_images):
                        ref_handle, temp_ref = _open_image_handle(ref, out_dir, f"ref-{idx}")
                        image_handles.append(ref_handle)
                        if temp_ref:
                            temp_paths.append(temp_ref)
                if request.inputs.mask is not None:
                    mask_handle, temp_mask = _open_image_handle(request.inputs.mask, out_dir, "mask")
                    if temp_mask:
                        temp_paths.append(temp_mask)

                raw_request = {
                    "model": model,
                    "prompt": prompt,
                    "image_count": resolved.n,
                    "size": resolved.size,
                }
                if output_format_param:
                    raw_request["output_format"] = output_format_param
                edit_kwargs: Dict[str, Any] = {
                    "model": model,
                    "prompt": prompt,
                    "image": image_handles,
                    "mask": mask_handle,
                    "n": resolved.n,
                    "size": resolved.size,
                    "user": resolved.user,
                    "quality": resolved.provider_params.get("quality", "high"),
                    "background": resolved.background,
                }
                if output_format_param:
                    edit_kwargs["output_format"] = output_format_param
                if resolved.provider_params.get("input_fidelity") is not None:
                    edit_kwargs["input_fidelity"] = resolved.provider_params.get("input_fidelity")
                if allow_compression and resolved.provider_params.get("output_compression") is not None:
                    edit_kwargs["output_compression"] = resolved.provider_params.get("output_compression")
                response = _call_with_kw_fallback(client.images.edit, edit_kwargs)
            elif response is None:
                raw_request = {
                    "model": model,
                    "prompt": prompt,
                    "image_count": resolved.n,
                    "size": resolved.size,
                }
                if output_format_param:
                    raw_request["output_format"] = output_format_param
                gen_kwargs: Dict[str, Any] = {
                    "model": model,
                    "prompt": prompt,
                    "n": resolved.n,
                    "size": resolved.size,
                    "user": resolved.user,
                    "quality": resolved.provider_params.get("quality", "high"),
                    "moderation": resolved.provider_params.get("moderation", "low"),
                    "background": resolved.background,
                }
                if output_format_param:
                    gen_kwargs["output_format"] = output_format_param
                if resolved.provider_params.get("input_fidelity") is not None:
                    gen_kwargs["input_fidelity"] = resolved.provider_params.get("input_fidelity")
                if allow_compression and resolved.provider_params.get("output_compression") is not None:
                    gen_kwargs["output_compression"] = resolved.provider_params.get("output_compression")
                response = _call_with_kw_fallback(client.images.generate, gen_kwargs)
        finally:
            for handle in image_handles:
                try:
                    handle.close()
                except Exception:
                    pass
            if mask_handle is not None:
                try:
                    mask_handle.close()
                except Exception:
                    pass
            for temp_path in temp_paths:
                try:
                    temp_path.unlink(missing_ok=True)
                except Exception:
                    pass

        if response is None:
            raise RuntimeError("OpenAI returned no response.")

        images: List[ProviderImage] = []
        usage: Any = None
        raw_response: Any = None

        if isinstance(response, list):
            usage_payloads: List[Any] = []
            raw_responses: List[Any] = []
            for response_obj in response:
                response_plain = _to_plain(response_obj)
                raw_responses.append(response_plain)
                usage_payloads.append(_coerce_usage(getattr(response_obj, "usage", None)))
                output = response_plain.get("output") if isinstance(response_plain, dict) else None
                if not isinstance(output, list):
                    continue
                for item in output:
                    if not isinstance(item, dict):
                        continue
                    b64_candidates: List[str] = []
                    if isinstance(item.get("b64_json"), str):
                        b64_candidates.append(item["b64_json"])
                    result = item.get("result")
                    if isinstance(result, str):
                        b64_candidates.append(result)
                    elif isinstance(result, list):
                        for entry in result:
                            if isinstance(entry, str):
                                b64_candidates.append(entry)
                            elif isinstance(entry, dict) and isinstance(entry.get("b64_json"), str):
                                b64_candidates.append(entry["b64_json"])
                    if not b64_candidates:
                        continue
                    for b64 in b64_candidates:
                        binary = base64.b64decode(b64)
                        payload = dict(item)
                        payload.pop("b64_json", None)
                        metadata = payload.get("metadata") or {}
                        images.append(
                            ProviderImage(
                                image_bytes=binary,
                                mime_type=f"image/{output_format_effective}",
                                seed=metadata.get("seed"),
                                width=metadata.get("width"),
                                height=metadata.get("height"),
                                provider_request_id=response_plain.get("id")
                                if isinstance(response_plain, dict)
                                else None,
                                metadata={"payload": payload, "metadata": metadata},
                            )
                        )
            raw_response = {"responses": raw_responses}
            if usage_payloads:
                usage = {"responses": usage_payloads}
        else:
            usage = _coerce_usage(getattr(response, "usage", None))
            raw_response = _to_plain(response)
            data = getattr(response, "data", []) or []
            for idx, item in enumerate(data):
                payload = _to_plain(item)
                if not isinstance(payload, dict):
                    continue
                b64 = payload.get("b64_json")
                if not b64:
                    continue
                binary = base64.b64decode(b64)
                payload.pop("b64_json", None)
                metadata = payload.get("metadata") or {}
                images.append(
                    ProviderImage(
                        image_bytes=binary,
                        mime_type=f"image/{output_format_effective}",
                        seed=metadata.get("seed"),
                        width=metadata.get("width"),
                        height=metadata.get("height"),
                        provider_request_id=getattr(response, "id", None),
                        metadata={"payload": payload, "metadata": metadata},
                    )
                )

        if not images:
            raise RuntimeError("OpenAI returned no images.")

        return ProviderResponse(
            images=images,
            model=getattr(response, "model", None) if not isinstance(response, list) else model,
            usage=usage,
            raw_request=raw_request,
            raw_response=raw_response,
            warnings=warnings,
        )

    def stream(self, request: ImageRequest, resolved: ResolvedRequest) -> Iterator[ProviderStreamEvent]:
        client = _client()
        model = resolved.model or DEFAULT_MODEL
        output_format_effective = resolved.output_format
        output_format_param = output_format_effective if request.output_format else None
        prompt = resolved.prompt
        allow_compression = _supports_output_compression(output_format_effective)

        if request.mode == "edit":
            yield ProviderStreamEvent(
                type="error",
                index=0,
                message="Streaming edits are not supported for OpenAI image models.",
            )
            return

        stream_kwargs: Dict[str, Any] = {
            "model": model,
            "prompt": prompt,
            "n": resolved.n,
            "size": resolved.size,
            "quality": resolved.provider_params.get("quality", "high"),
            "moderation": resolved.provider_params.get("moderation", "low"),
            "stream": True,
        }
        if output_format_param:
            stream_kwargs["output_format"] = output_format_param
        if resolved.user:
            stream_kwargs["user"] = resolved.user
        if resolved.background:
            stream_kwargs["background"] = resolved.background
        if resolved.provider_params.get("input_fidelity"):
            stream_kwargs["input_fidelity"] = resolved.provider_params.get("input_fidelity")
        if allow_compression and resolved.provider_params.get("output_compression") is not None:
            stream_kwargs["output_compression"] = resolved.provider_params.get("output_compression")
        if resolved.partial_images is not None:
            stream_kwargs["partial_images"] = resolved.partial_images

        stream = client.images.generate(**stream_kwargs)

        indexed_payloads: dict[int, Dict[str, Any]] = {}
        unindexed_payloads: List[Dict[str, Any]] = []
        usage_payload: Any = None
        response_id: Optional[str] = None
        response_model: Optional[str] = None

        for event in stream:
            event_type = str(getattr(event, "type", "") or "")
            if event_type == "response.error":
                message = getattr(event, "error", None)
                yield ProviderStreamEvent(type="error", index=0, message=str(message))
                return

            if event_type == "image_generation.partial_image":
                b64_json = getattr(event, "b64_json", None)
                if not b64_json:
                    event_plain = _to_plain(event)
                    if isinstance(event_plain, dict):
                        b64_json = event_plain.get("b64_json")
                if b64_json:
                    binary = base64.b64decode(b64_json)
                    index_hint = None
                    event_plain = _to_plain(event)
                    if isinstance(event_plain, dict):
                        index_hint = _extract_index(event_plain)
                    yield ProviderStreamEvent(
                        type="partial",
                        index=index_hint or 0,
                        image_bytes=binary,
                    )
                continue

            payloads = _extract_image_payloads(event)
            for payload in payloads:
                index = _extract_index(payload)
                if index is not None:
                    indexed_payloads[index] = payload
                else:
                    unindexed_payloads.append(payload)

            if event_type == "image_generation.completed":
                usage_payload = _coerce_usage(getattr(event, "usage", None))
                response_obj = getattr(event, "response", None)
                response_dict = _to_plain(response_obj)
                if isinstance(response_dict, dict):
                    response_id = response_dict.get("id") or response_id
                    response_model = response_dict.get("model") or response_model
                event_dict = _to_plain(event)
                if isinstance(event_dict, dict):
                    response_id = event_dict.get("id", response_id)
                    response_model = event_dict.get("model", response_model)

        final_payloads: List[Dict[str, Any]] = []
        if indexed_payloads:
            for idx in sorted(indexed_payloads):
                final_payloads.append(indexed_payloads[idx])
        if unindexed_payloads:
            final_payloads.extend(unindexed_payloads)

        if not final_payloads:
            yield ProviderStreamEvent(type="error", index=0, message="OpenAI stream ended without images.")
            return

        for idx, payload in enumerate(final_payloads):
            b64 = payload.get("b64_json")
            if not b64:
                continue
            binary = base64.b64decode(b64)
            payload.pop("b64_json", None)
            metadata = payload.get("metadata") or {}
            provider_image = ProviderImage(
                image_bytes=binary,
                mime_type=f"image/{output_format_effective}",
                seed=metadata.get("seed"),
                width=metadata.get("width"),
                height=metadata.get("height"),
                provider_request_id=response_id,
                metadata={"payload": payload, "metadata": metadata, "usage": usage_payload},
            )
            yield ProviderStreamEvent(type="final", index=idx, image=provider_image)
