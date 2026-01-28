"""Utility helpers for PARAM FORGE."""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple

from .contracts import ImageInput

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def ensure_out_dir(out_dir: Optional[Path]) -> Path:
    if out_dir is None:
        root = Path(os.getenv("PARAM_FORGE_OUTPUTS", "outputs"))
        out_dir = root / "param_forge" / utc_timestamp()
    out_dir = Path(out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def is_url(value: str) -> bool:
    return bool(_URL_RE.match(value or ""))


def read_input_bytes(value: ImageInput) -> Tuple[bytes, Optional[str]]:
    if isinstance(value, bytes):
        return value, None
    if isinstance(value, Path):
        return value.read_bytes(), str(value)
    if isinstance(value, str):
        if is_url(value):
            raise ValueError("URL inputs must be fetched by provider adapters.")
        path = Path(value).expanduser().resolve()
        return path.read_bytes(), str(path)
    raise TypeError(f"Unsupported input type: {type(value)}")
